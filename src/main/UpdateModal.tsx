// 应用内更新弹窗：发现新版本（update://available 或关于页按钮）后弹出，
// 点「立即更新」才 invoke update_install；下载→替换→重启全在 Rust 侧完成，
// 成功路径命令不会 resolve（应用直接重启），失败恢复按钮可重试。
// 更新说明（发版 Release body，markdown）直接内嵌展示，用户不必跳浏览器；
// 清单没带说明时保留「查看更新内容」链接兜底。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Modal } from "../shared/Modal";
import { toast } from "../shared/toast";
import { t, useLocale } from "../shared/i18n";
import type { UpdateInfo } from "./pages/AboutPage";

interface Progress {
  transferred: number;
  total?: number;
}

// 与结果窗同一管线（floating/App.tsx mdComponents）：图片不自动加载（零外联），
// 转为可点链接交给外部浏览器
const mdComponents: Components = {
  img: ({ src, alt }) => (src ? <a href={src}>{alt || src}</a> : null),
};

export default function UpdateModal({
  upd,
  onClose,
}: {
  upd: UpdateInfo | null;
  onClose: () => void;
}) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  useEffect(() => {
    // 弹窗打开期间才听进度，卸载即停
    const un = listen<Progress>("update://progress", (e) =>
      setProgress({
        transferred: e.payload.transferred,
        total: e.payload.total ?? undefined,
      }),
    );
    return () => {
      un.then((f) => f());
    };
  }, []);
  if (!upd || upd.status !== "available" || !upd.latest) return null;

  const pct =
    progress?.total && progress.total > 0
      ? Math.min(99, Math.round((progress.transferred / progress.total) * 100))
      : null;
  const install = () => {
    setInstalling(true);
    invoke("update_install").catch(() => {
      // 细节已落 Rust 日志，这里只给一句无技术词的短提示，按钮恢复可重试
      toast(t("update.installFailed"), "err");
      setInstalling(false);
      setProgress(null);
    });
  };

  return (
    <Modal
      title={t("update.title")}
      onClose={installing ? () => undefined : onClose}
      footer={
        <>
          <button className="btn sm" disabled={installing} onClick={onClose}>
            {t("update.later")}
          </button>
          <button
            className="btn primary sm"
            disabled={installing}
            onClick={install}
          >
            {installing
              ? pct !== null
                ? t("update.downloading", { pct })
                : t("update.preparing")
              : t("update.installNow")}
          </button>
        </>
      }
    >
      <p>{t("update.body", { latest: upd.latest })}</p>
      {upd.notes ? (
        // 说明区自滚动：长说明不把弹窗撑爆，底部按钮始终可见
        <div className="update-notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {upd.notes}
          </ReactMarkdown>
        </div>
      ) : (
        <p>
          <button
            className="text-link"
            onClick={() =>
              invoke("open_url", { url: upd.url }).catch(() => undefined)
            }
          >
            {t("update.whatsNew")}
          </button>
        </p>
      )}
    </Modal>
  );
}
