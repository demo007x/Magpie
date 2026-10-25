// 关于页：版本信息、更新检测（查 GitHub Releases，无自建服务器；24h 节流在 Rust 侧）。
import { invoke } from "@tauri-apps/api/core";
import markIcon from "../assets/mark.svg";
import { toast } from "../../shared/toast";

/** 飞书反馈表单（免登录可填）与 GitHub Issue 入口：跳转后由用户自行填写 */
const FEEDBACK_FORM_URL = "https://tvxjr8zl48.feishu.cn/share/base/form/shrcnF78Kl495G3iUVz8iWvnA6e";
const ISSUE_URL = "https://github.com/demo007x/Magpie/issues/new";

export type UpdateInfo = {
  status: "current" | "available" | "failed" | null;
  current: string;
  latest?: string;
  url?: string;
  checkedAt?: number;
};

/** 检查时间显示：toLocaleString 语义化档位（X月X日 HH:MM） */
function fmtChecked(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateHint(upd: UpdateInfo | null): string {
  switch (upd?.status) {
    case "available":
      return `发现新版本 v${upd.latest}（当前 v${upd.current}），点「下载」前往发布页获取安装包。`;
    case "current":
      return `已是最新版本（v${upd.current}），检查于 ${fmtChecked(upd.checkedAt!)}。拾趣每天自动检查一次，也可随时手动检查。`;
    case "failed":
      return "这次没检查成（网络不通或 GitHub 暂时访问不了），下次启动会自动重试。";
    default:
      return "启动后自动检查一次，发现新版本时在菜单栏下方轻提示；检查只读取公开版本信息，不发送任何本机数据。";
  }
}

interface AboutProps {
  appVersion: string;
  upd: UpdateInfo | null;
  checking: boolean;
  runUpdateCheck: (force: boolean) => void;
}

export default function AboutPage({ appVersion, upd, checking, runUpdateCheck }: AboutProps) {
  return (
    <>
      <h1>关于</h1>
      <p className="page-hint">
        查看版本与检查更新。更新检测仅读取 GitHub Releases 的公开版本信息，不发送本机数据。
      </p>
      <div className="card about-card">
        <img className="mark big" src={markIcon} alt="拾趣" />
        <div className="about-name">拾趣</div>
        <div className="about-slogan">划词拾趣，阅有所得</div>
        <div className="about-desc">拾趣 Magpie · 划词即懂的阅读伴侣</div>
        <div className="about-motto">得于阅，存于思</div>
        <div className="about-ver">版本 {appVersion || "—"}</div>
      </div>
      <h2 className="sec">更新</h2>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-title">检查新版本</div>
            <div className="row-sub">{updateHint(upd)}</div>
          </div>
          <div className="row-ctl">
            {upd?.status === "available" && upd.url && (
              <button
                className="btn sm primary"
                onClick={() => invoke("open_url", { url: upd.url }).catch(() => undefined)}
              >
                下载 v{upd.latest}
              </button>
            )}
            <button className="btn sm" disabled={checking} onClick={() => runUpdateCheck(true)}>
              {checking ? "检查中…" : "检查更新"}
            </button>
          </div>
        </div>
      </div>
      <h2 className="sec">反馈问题</h2>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-sub">
              遇到问题或有想法，告诉我们。飞书表单人人可填；GitHub Issue 需要账号。
            </div>
          </div>
          <div className="row-ctl">
            <button
              className="btn sm primary"
              onClick={() => invoke("open_url", { url: FEEDBACK_FORM_URL }).catch(() => undefined)}
            >
              飞书反馈
            </button>
            <button
              className="btn sm"
              onClick={() => invoke("open_url", { url: ISSUE_URL }).catch(() => undefined)}
            >
              GitHub Issue
            </button>
            <button
              className="btn sm"
              onClick={() => {
                invoke<number>("copy_debug_log").then(
                  (n) => toast(`已复制运行日志（${n} 字），可随反馈一并粘贴`, "info"),
                  (e) => toast(`复制日志失败：${String(e)}`, "err"),
                );
              }}
            >
              复制日志
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
