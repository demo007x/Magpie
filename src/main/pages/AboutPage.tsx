// 关于页：版本信息、更新检测（检测在 Rust 侧：24h 节流；发现新版走应用内更新）。
import { invoke } from "@tauri-apps/api/core";
import markIcon from "../assets/mark.svg";
import { toast } from "../../shared/toast";
import { t, useLocale, getLocale } from "../../shared/i18n";

/** 飞书反馈表单（免登录可填）与 GitHub Issue 入口：跳转后由用户自行填写 */
const FEEDBACK_FORM_URL = "https://tvxjr8zl48.feishu.cn/share/base/form/shrcnF78Kl495G3iUVz8iWvnA6e";
const REPO_URL = "https://github.com/demo007x/Magpie";
const ISSUE_URL = "https://github.com/demo007x/Magpie/issues/new";

export type UpdateInfo = {
  /** 与 Rust update::UpdateInfo.status 对齐：cooldown = 24h 内已查过且无新版 */
  status: "upToDate" | "available" | "cooldown" | "failed" | null;
  current: string;
  latest?: string;
  url?: string;
  /** 更新说明 markdown（发版 Release body；空 = 弹窗回退为跳发布页链接） */
  notes?: string;
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
    case "upToDate":
    case "cooldown":
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
  /** 打开应用内更新弹窗（App.tsx 持有弹窗状态，与 update://available 弹窗共用） */
  openUpdate: () => void;
}

export default function AboutPage({ appVersion, upd, checking, runUpdateCheck, openUpdate }: AboutProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  return (
    <>
      {/* 品牌卡即页面主角，不设页级标题（h1/hint 与卡片信息重复）。
          两行文案各司其职：tagline 说「是什么」（与官网 hero 同源），slogan 是理念签名 */}
      <div className="card about-card">
        <img className="mark big" src={markIcon} alt={t("main.appName")} />
        <div className="about-info">
          <div className="about-name">{t("main.appName")}</div>
          <div className="about-tagline">{t("about.tagline")}</div>
          <div className="about-slogan">{t("about.slogan")}</div>
          <div className="about-ver">{t("about.version", { version: appVersion || "—" })}</div>
        </div>
      </div>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-title">{t("about.checkTitle")}</div>
            <div className="row-sub">{updateHint(upd)}</div>
          </div>
          <div className="row-ctl">
            {upd?.status === "available" && upd.url && (
              <button className="btn sm primary" onClick={openUpdate}>
                {t("about.updateTo", { version: upd.latest! })}
              </button>
            )}
            <button className="btn sm" disabled={checking} onClick={() => runUpdateCheck(true)}>
              {checking ? t("about.checking") : t("about.checkNow")}
            </button>
          </div>
        </div>
      </div>
      {/* Star / 分享 / 反馈：同一段轻文案流（次级色居中），动作全是行内链接。
          分享 = 复制预置文案（含仓库链接）进剪贴板，复制成功走 toast。
          动线：好用 → Star / 分享 → 遇到问题 → 三个反馈入口 */}
      <div className="star-line">
        <p>
          {t("about.starLead")}
          <button
            className="text-link"
            onClick={() => invoke("open_url", { url: REPO_URL }).catch(() => undefined)}
          >
            {t("about.starAction")}
          </button>
        </p>
        <p>
          {t("about.shareLead")}
          <button
            className="text-link"
            onClick={() =>
              navigator.clipboard
                .writeText(t("about.shareText", { url: REPO_URL }))
                .then(() => toast(t("about.shareCopied"), "info"))
                .catch(() => undefined)
            }
          >
            {t("about.shareAction")}
          </button>
        </p>
        <p className="gap-top">{t("about.feedbackSub")}</p>
        <p>
          <button
            className="text-link"
            onClick={() => invoke("open_url", { url: FEEDBACK_FORM_URL }).catch(() => undefined)}
          >
            {t("about.feedbackFeishu")}
          </button>
          <span aria-hidden> · </span>
          <button
            className="text-link"
            onClick={() => invoke("open_url", { url: ISSUE_URL }).catch(() => undefined)}
          >
            GitHub Issue
          </button>
          <span aria-hidden> · </span>
          <button
            className="text-link"
            onClick={() => {
              invoke<number>("copy_debug_log").then(
                (n) => toast(t("about.logCopied", { count: n }), "info"),
                (e) => toast(t("about.logCopyFailed", { error: String(e) }), "err"),
              );
            }}
          >
            {t("about.copyLog")}
          </button>
        </p>
      </div>
    </>
  );
}
