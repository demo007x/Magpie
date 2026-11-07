// 快捷键页：三组全局快捷键录制与重置（SHORTCUT_ITEMS/录制器自本页专用，随页拆出）。
import { useState } from "react";
import type { Settings } from "../../shared/types";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

export default function ShortcutsPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）

const SHORTCUT_ITEMS: Array<{
  key:
    | "ocrShortcut"
    | "ocrTranslateShortcut"
    | "ocrExplainShortcut"
    | "ocrSummarizeShortcut"
    | "fileOcrShortcut";
  /** 名称/描述的 i18n 键（sc.*），渲染时 t() 解析 */
  label: string;
  desc: string;
  /** 出厂默认键位：重置按钮的目标值 */
  default: string;
}> = [
  {
    key: "ocrShortcut",
    label: "sc.ocr.label",
    default: "Alt+S",
    desc: "sc.ocr.desc",
  },
  {
    key: "ocrTranslateShortcut",
    label: "sc.ocrTranslate.label",
    default: "Alt+T",
    desc: "sc.ocrTranslate.desc",
  },
  {
    key: "ocrExplainShortcut",
    label: "sc.ocrExplain.label",
    default: "Alt+E",
    desc: "sc.ocrExplain.desc",
  },
  {
    key: "ocrSummarizeShortcut",
    label: "sc.ocrSummarize.label",
    default: "Alt+D",
    desc: "sc.ocrSummarize.desc",
  },
  {
    key: "fileOcrShortcut",
    label: "sc.fileOcr.label",
    default: "Alt+F",
    desc: "sc.fileOcr.desc",
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
      value={recording ? hint || t("sc.pressKeys") : displayShortcut(value)}
      placeholder={t("sc.recordPh", { example: IS_MAC ? "⌥S" : "Alt+S" })}
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
          setHint(mods.length ? `${mods.map(sym).join("+")}+…` : t("sc.pressKeys"));
          return;
        }
        if (mods.length === 0) {
          setHint(t("sc.needMod"));
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
            <h1>{t("nav.shortcuts")}</h1>
            <p className="page-hint">
              {t("sc.hint")}
            </p>
            <div className="card">
              {SHORTCUT_ITEMS.map((item, i) => (
                <div className={`row-between${i > 0 ? " sep" : ""}`} key={item.key}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row-title">{t(item.label)}</div>
                    <div className="row-sub">{t(item.desc)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <ShortcutRecorder
                      value={settings[item.key]}
                      onChange={(v) => patch({ [item.key]: v } as Partial<Settings>)}
                    />
                    {settings[item.key] !== item.default && (
                      <button
                        className="btn sm"
                        title={t("sc.resetTitle")}
                        onClick={() =>
                          patch({ [item.key]: item.default } as Partial<Settings>)
                        }
                      >
                        {t("sc.reset")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? t("common.saved") : t("common.saveChanges")}
              </button>
            </div>
    </>
  );
}
