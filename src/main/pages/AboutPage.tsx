// 关于页：版本信息、更新检测（查 GitHub Releases，无自建服务器；24h 节流在 Rust 侧）。
import { invoke } from "@tauri-apps/api/core";
import markIcon from "../assets/mark.svg";
import { toast } from "../../shared/toast";
import { t, useLocale, getLocale } from "../../shared/i18n";

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

/** 检查时间显示：toLocaleString 语义化档位（X月X日 HH:MM），按当前界面语言取地域格式 */
function fmtChecked(ts: number): string {
  return new Date(ts * 1000).toLocaleString(getLocale() === "en" ? "en-US" : "zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateHint(upd: UpdateInfo | null): string {
  switch (upd?.status) {
    case "available":
      return t("about.updateAvailable", { latest: upd.latest!, current: upd.current });
    case "current":
      return t("about.updateCurrent", {
        current: upd.current,
        time: fmtChecked(upd.checkedAt!),
      });
    case "failed":
      return t("about.updateFailed");
    default:
      return t("about.updateIdle");
  }
}

interface AboutProps {
  appVersion: string;
  upd: UpdateInfo | null;
  checking: boolean;
  runUpdateCheck: (force: boolean) => void;
}

export default function AboutPage({ appVersion, upd, checking, runUpdateCheck }: AboutProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  return (
    <>
      <h1>{t("nav.about")}</h1>
      <p className="page-hint">{t("about.hint")}</p>
      <div className="card about-card">
        <img className="mark big" src={markIcon} alt={t("main.appName")} />
        <div className="about-name">{t("main.appName")}</div>
        <div className="about-slogan">{t("about.slogan")}</div>
        <div className="about-desc">{t("about.desc")}</div>
        <div className="about-motto">{t("about.motto")}</div>
        <div className="about-ver">{t("about.version", { version: appVersion || "—" })}</div>
      </div>
      <h2 className="sec">{t("about.updateSec")}</h2>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-title">{t("about.checkTitle")}</div>
            <div className="row-sub">{updateHint(upd)}</div>
          </div>
          <div className="row-ctl">
            {upd?.status === "available" && upd.url && (
              <button
                className="btn sm primary"
                onClick={() => invoke("open_url", { url: upd.url }).catch(() => undefined)}
              >
                {t("about.download", { version: upd.latest! })}
              </button>
            )}
            <button className="btn sm" disabled={checking} onClick={() => runUpdateCheck(true)}>
              {checking ? t("about.checking") : t("about.checkNow")}
            </button>
          </div>
        </div>
      </div>
      <h2 className="sec">{t("about.feedbackSec")}</h2>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-sub">{t("about.feedbackSub")}</div>
          </div>
          <div className="row-ctl">
            <button
              className="btn sm"
              onClick={() => invoke("open_url", { url: FEEDBACK_FORM_URL }).catch(() => undefined)}
            >
              {t("about.feedbackFeishu")}
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
                  (n) => toast(t("about.logCopied", { count: n }), "info"),
                  (e) => toast(t("about.logCopyFailed", { error: String(e) }), "err"),
                );
              }}
            >
              {t("about.copyLog")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
