import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** 全应用共用的模态容器：遮罩 + 卡片 + 标题 + Esc / 点遮罩关闭 + Tab 焦点循环。
 *
 *  为什么 portal 到 body：折叠体（.svc-body > div）是 overflow:hidden，
 *  就地渲染固定定位的面板会被祖先裁掉。
 *  为什么 onClose 走 ref：调用方每次渲染都给它一个新函数，
 *  放进依赖数组会让副作用重跑，把焦点从正文输入框抢回面板——打字时焦点跳走。
 *
 *  size="sm" 给一两句确认文案这类窄面板；默认宽度是给表单/输出用的。 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = panel.current.querySelectorAll<HTMLElement>(
        'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prevFocus?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div
        className={`modal${size === "sm" ? " sm" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" aria-label="关闭" onClick={onClose}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** 危险操作确认：Modal 的一个固定用法（替代 confirm()——它在 WKWebView 里恒为 false） */
export function Confirm({
  title,
  text,
  confirmLabel = "删除",
  onCancel,
  onConfirm,
}: {
  title: string;
  text: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <button className="btn sm" onClick={onCancel}>
            取消
          </button>
          <button className="btn sm danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="modal-text">{text}</p>
    </Modal>
  );
}
