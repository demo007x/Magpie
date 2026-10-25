// 黑名单页：划词时不显示浮动条的应用列表（应用选择面板添加，.row-del 移除）。
import { Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { PageProps } from "./types";

export default function BlocklistPage({ settings, patch, save, saved }: PageProps) {
  return (
          <>
            <h1>禁用应用</h1>
            <p className="page-hint">
              列表内的应用在划词时不显示浮动条。「选择应用…」添加，条目右侧图标移除。更改需保存后生效。
            </p>

            <div className="card">
              {settings.appBlacklist.length === 0 ? (
                <div className="row-between tight">
                  <div>
                    <div className="row-title" style={{ color: "var(--sec)" }}>
                      暂无禁用应用
                    </div>
                    <div className="row-sub">列表为空，所有应用划词时均显示浮动条。</div>
                  </div>
                </div>
              ) : (
                settings.appBlacklist.map((name, i) => (
                  <div className="row-between tight" key={`${name}-${i}`}>
                    <div className="row-title">{name}</div>
                    <button
                      className="row-del"
                      title="移出禁用列表"
                      aria-label="移出禁用列表"
                      onClick={() =>
                        patch({
                          appBlacklist: settings.appBlacklist.filter((_, idx) => idx !== i),
                        })
                      }
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                ))
              )}
              <div className="card-foot">
                <button
                  className="btn primary"
                  onClick={() => {
                    invoke<string | null>("pick_app_bundle")
                      .then((app) => {
                        if (app && !settings.appBlacklist.includes(app)) {
                          patch({ appBlacklist: [...settings.appBlacklist, app] });
                        }
                      })
                      .catch(() => undefined);
                  }}
                >
                  选择应用…
                </button>
              </div>
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
    </>
  );
}
