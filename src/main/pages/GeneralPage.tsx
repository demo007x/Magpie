// 通用页：主题（跟随系统/亮/暗）、登录自启、程序坞图标（macOS）、结果窗默认尺寸。
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../../shared/toast";
import type { PageProps } from "./types";

const IS_MAC = /Mac/i.test(navigator.platform);

interface GeneralProps extends Omit<PageProps, "save"> {
  appearance: string;
  setAppearanceMode: (mode: string) => void;
}

  const RESULT_SIZE_PRESETS: { label: string; size: [number, number] }[] = [
    { label: "紧凑·横", size: [560, 320] },
    { label: "紧凑·竖", size: [400, 560] },
    { label: "宽敞·横", size: [560, 480] },
    { label: "宽敞·竖", size: [480, 800] },
  ];



export default function GeneralPage({ settings, patch, saveNow, appearance, setAppearanceMode }: GeneralProps) {
  const applyResultPreset = (size: [number, number]) => {
    invoke("apply_result_preset", { width: size[0], height: size[1] }).catch(() => undefined);
    // save_settings 提交的是本地全量 settings——本地不同步的话，其他页面的保存会回退预设
    patch({ resultWindowSize: size });
  };
  return (
          <>
            <h1>通用</h1>
            <p className="page-hint">主题、启动、程序坞与结果窗口的应用级设置，除注明外更改即时生效。</p>
            <h2 className="sec">主题</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">应用外观</div>
                  <div className="row-sub">
                    亮色、暗色或跟随系统自动切换。即时生效，覆盖浮动条、识别面板与提示。
                  </div>
                </div>
                <div className="seg" role="radiogroup" aria-label="应用外观">
                  {[
                    ["auto", "跟随系统"],
                    ["light", "亮色"],
                    ["dark", "暗色"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={appearance === value ? "on" : ""}
                      onClick={() => setAppearanceMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <h2 className="sec">启动</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">登录时自动启动</div>
                  <div className="row-sub">
                    开机登录后自动运行拾趣并驻留菜单栏，无需手动打开。更改即时生效。
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.launchAtLogin}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      invoke("set_launch_at_login", { enabled })
                        .then(() => patch({ launchAtLogin: enabled }))
                        .catch((err) => toast(`设置失败：${err}`, "err"));
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>

            {/* 程序坞为 macOS 概念：Windows 无程序坞，整节隐藏（能力门控） */}
            {IS_MAC && (
            <>
            <h2 className="sec">程序坞</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">在程序坞中显示图标</div>
                  <div className="row-sub">
                    默认仅以菜单栏形态常驻。开启后程序坞同时显示图标；关闭时点主窗口关闭按钮仅隐藏窗口，退出请用菜单栏右键「退出应用」。
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.showDockIcon}
                    onChange={(e) => {
                      patch({ showDockIcon: e.target.checked });
                      saveNow?.();
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>
            </>
            )}

            <h2 className="sec">结果窗口</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">默认尺寸</div>
                  <div className="row-sub">
                    预设四种大小，点选立即作用于结果窗口；拖拽微调仍然有效并被记住。
                  </div>
                </div>
                <div className="seg sized" role="radiogroup" aria-label="结果窗口默认尺寸">
                  {RESULT_SIZE_PRESETS.map((p) => {
                    const rs = settings.resultWindowSize;
                    const active =
                      !!rs &&
                      Math.round(rs[0]) === p.size[0] &&
                      Math.round(rs[1]) === p.size[1];
                    return (
                      <button
                        key={p.label}
                        className={active ? "on" : ""}
                        onClick={() => applyResultPreset(p.size)}
                      >
                        {p.label}
                        <small>
                          {p.size[0]} × {p.size[1]}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
    </>
  );
}
