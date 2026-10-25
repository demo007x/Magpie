// 快捷键页：三组全局快捷键录制与重置（SHORTCUT_ITEMS/录制器自本页专用，随页拆出）。
import { useState } from "react";
import type { Settings } from "../../shared/types";
import type { PageProps } from "./types";

export default function ShortcutsPage({ settings, patch, save, saved }: PageProps) {

const SHORTCUT_ITEMS: Array<{
  key:
    | "ocrShortcut"
    | "ocrTranslateShortcut"
    | "ocrExplainShortcut"
    | "ocrSummarizeShortcut"
    | "fileOcrShortcut";
  label: string;
  desc: string;
  /** 出厂默认键位：重置按钮的目标值 */
  default: string;
}> = [
  {
    key: "ocrShortcut",
    label: "识图取字",
    default: "Alt+S",
    desc: "框选屏幕任意区域，识别其中的文字，在结果面板中查看、复制、钉住原图，或继续翻译等后续操作。默认 ⌥S。",
  },
  {
    key: "ocrTranslateShortcut",
    label: "识图翻译",
    default: "Alt+T",
    desc: "框选截图，识别出的文字自动交给默认翻译服务，结果直接呈现在面板中。默认 ⌥T。",
  },
  {
    key: "ocrExplainShortcut",
    label: "识图解释",
    default: "Alt+E",
    desc: "框选截图，AI 自动解释识别出的内容。默认 ⌥E。",
  },
  {
    key: "ocrSummarizeShortcut",
    label: "识图总结",
    default: "Alt+D",
    desc: "框选截图，AI 自动提炼识别出的文字要点。默认 ⌥D。",
  },
  {
    key: "fileOcrShortcut",
    label: "访达选图取字",
    default: "Alt+F",
    desc: "选择一张图片文件，识别其中的文字，后续操作与识图取字一致。默认 ⌥F。",
  },
];

// 快捷键显示转换：存储统一为 Tauri 跨平台格式（"Alt+S"），显示按平台翻译——
// macOS 用 ⌥⌃⇧⌘ 符号，Windows 保留 Alt/Ctrl 原文。与 Rust 侧 shortcut_display
//（托盘菜单键位）同一套映射
const IS_MAC = /Mac/i.test(navigator.platform);
const MOD_SYMBOLS: Record<string, string> = {
  Alt: "⌥",
  Option: "⌥",
  CmdOrCtrl: "⌘",
  Cmd: "⌘",
  Meta: "⌘",
  Super: "⌘",
  Control: "⌃",
  Ctrl: "⌃",
  Shift: "⇧",
};
// Windows 显示名：修饰键规范化为平台惯用名（存储保持 Tauri 跨平台格式不变），
// 与 Rust 侧 shortcut_display（托盘菜单）同一套映射，两处需同步
const MOD_NAMES_WIN: Record<string, string> = {
  CmdOrCtrl: "Ctrl",
  Cmd: "Ctrl",
  Meta: "Ctrl",
  Super: "Ctrl",
  Control: "Ctrl",
  Ctrl: "Ctrl",
  Option: "Alt",
  Alt: "Alt",
  Shift: "Shift",
};
function displayShortcut(v: string): string {
  if (!v) return "";
  return v
    .split("+")
    .map((p) => (IS_MAC ? (MOD_SYMBOLS[p] ?? p) : (MOD_NAMES_WIN[p] ?? p)))
    // macOS 符号连写（⌥S）；Windows 用 + 连接（Alt+S）
    .join(IS_MAC ? "" : "+");
}

// 快捷键录制框：点击聚焦后捕获用户按下的组合键，规范化为 Tauri Shortcut 格式。
// 只读（禁手输）；Esc 取消；无修饰键的单击提示不合法（避免吞掉单键全局快捷键）。
function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");

  const sym = (m: string) => (IS_MAC ? (MOD_SYMBOLS[m] ?? m) : m);

  return (
    <input
      readOnly
      style={{ width: 180, flexShrink: 0, cursor: "pointer" }}
      className={recording ? "recording" : ""}
      value={recording ? hint || "按下组合键…" : displayShortcut(value)}
      placeholder={IS_MAC ? "点击录制，如 ⌥S" : "点击录制，如 Alt+S"}
      onFocus={() => {
        setRecording(true);
        setHint("");
      }}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          e.currentTarget.blur();
          return;
        }
        // 修饰键：macOS ⌘ 与 Windows Ctrl 统一存为 CmdOrCtrl（跨平台语义等价）
        const mods: string[] = [];
        if (e.metaKey) mods.push("CmdOrCtrl");
        if (e.ctrlKey) mods.push("Ctrl");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        // 只按了修饰键：先给出已按下的提示，等待主键
        if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) {
          setHint(mods.length ? `${mods.map(sym).join("+")}+…` : "按下组合键…");
          return;
        }
        if (mods.length === 0) {
          setHint("需至少包含一个修饰键");
          return;
        }
        let key = e.key;
        if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
        else if (/^F\d{1,2}$/.test(key)) key = key.toUpperCase();
        else if (!/^\d$/.test(key)) return; // 其他主键（符号/空格等）不支持，忽略
        onChange([...mods, key].join("+"));
        e.currentTarget.blur();
      }}
    />
  );
}

  return (
          <>
            <h1>快捷键</h1>
            <p className="page-hint">
              点按输入框后按下新组合键完成设置，需含 ⌘ / Ctrl / Alt / Shift 之一，Esc 取消。组合键已被其他应用占用时不生效。更改需保存后生效。
            </p>
            <div className="card">
              {SHORTCUT_ITEMS.map((item, i) => (
                <div className={`row-between${i > 0 ? " sep" : ""}`} key={item.key}>
                  <div>
                    <div className="row-title">{item.label}</div>
                    <div className="row-sub">{item.desc}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <ShortcutRecorder
                      value={settings[item.key]}
                      onChange={(v) => patch({ [item.key]: v } as Partial<Settings>)}
                    />
                    {settings[item.key] !== item.default && (
                      <button
                        className="btn sm"
                        title="重置为默认快捷键"
                        onClick={() =>
                          patch({ [item.key]: item.default } as Partial<Settings>)
                        }
                      >
                        重置
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
    </>
  );
}
