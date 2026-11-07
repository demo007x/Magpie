// 权限页：辅助功能/输入监控/屏幕录制三项状态展示与授权入口 + 取词健康自检。
// 授权后自动刷新：进入页面开始轮询 capture_status，三项全就绪即停
//（常驻 IPC 会放大 wry 上游 nil-URL 崩溃（#1752）的触发面；屏幕录制不参与停止判定）
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, useLocale } from "../../shared/i18n";

export default function PermsPage() {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [granted, setGranted] = useState<boolean | null>(null);
  const [listenAccess, setListenAccess] = useState<boolean | null>(null);
  const [axServiceOk, setAxServiceOk] = useState<boolean | null>(null);
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const poll = () => {
      invoke<{
        granted: boolean;
        axServiceOk: boolean;
        listenEventAccess: boolean;
        screenCaptureAccess: boolean;
      }>("capture_status")
        .then((s) => {
          if (stop) return;
          setGranted(s.granted);
          setAxServiceOk(s.axServiceOk);
          setListenAccess(s.listenEventAccess);
          setScreenAccess(s.screenCaptureAccess);
          if (s.granted && s.axServiceOk && s.listenEventAccess && s.screenCaptureAccess) return;
          timer = window.setTimeout(poll, 2000);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stop = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return (
          <>
            <h1>{t("nav.perms")}</h1>
            <p className="page-hint">
              {t("perms.hint")}
            </p>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("perms.accessibility")}</div>
                  <div className="row-sub">
                    {granted === false
                      ? t("perms.accessibilityMissing")
                      : t("perms.accessibilityDesc")}
                  </div>
                </div>
                <span className={`pill ${granted ? "ok" : granted === false ? "bad" : ""}`}>
                  {granted === null ? t("perms.checking") : granted ? t("perms.granted") : t("perms.notGranted")}
                </span>
              </div>
              {granted === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() =>
                      invoke<boolean>("prompt_accessibility")
                        .then((grantedNow) => {
                          if (!grantedNow)
                            invoke("open_accessibility_settings").catch(() => undefined);
                        })
                        .catch(() =>
                          invoke("open_accessibility_settings").catch(() => undefined),
                        )
                    }
                  >
                    {t("perms.grantCapture")}
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">{t("perms.inputMonitoring")}</div>
                  <div className="row-sub">
                    {listenAccess === false
                      ? t("perms.inputMissing")
                      : t("perms.inputDesc")}
                  </div>
                </div>
                <span className={`pill ${listenAccess ? "ok" : listenAccess === false ? "bad" : ""}`}>
                  {listenAccess === null ? t("perms.checking") : listenAccess ? t("perms.granted") : t("perms.notGranted")}
                </span>
              </div>
              {listenAccess === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() => invoke<boolean>("request_listen_access").catch(() => undefined)}
                  >
                    {t("perms.grantInput")}
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">{t("perms.screen")}</div>
                  <div className="row-sub">
                    {screenAccess === false
                      ? t("perms.screenMissing")
                      : t("perms.screenDesc")}
                  </div>
                </div>
                <span className={`pill ${screenAccess ? "ok" : screenAccess === false ? "bad" : ""}`}>
                  {screenAccess === null ? t("perms.checking") : screenAccess ? t("perms.granted") : t("perms.notGranted")}
                </span>
              </div>
              {screenAccess === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() =>
                      invoke<boolean>("request_screen_capture_access").catch(() => undefined)
                    }
                  >
                    {t("perms.grantScreen")}
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">{t("perms.selfCheck")}</div>
                  <div className="row-sub">
                    {t("perms.selfCheckSub")}
                  </div>
                </div>
                <span className={`pill ${axServiceOk ? "ok" : axServiceOk === false ? "bad" : ""}`}>
                  {axServiceOk === null ? t("perms.checking") : axServiceOk ? t("perms.ok") : t("perms.bad")}
                </span>
              </div>
            </div>
    </>
  );
}
