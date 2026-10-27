// 权限页：辅助功能/输入监控/屏幕录制三项状态展示与授权入口 + 取词健康自检。
// 授权后自动刷新：进入页面开始轮询 capture_status，三项全就绪即停
//（常驻 IPC 会放大 wry 上游 nil-URL 崩溃（#1752）的触发面；屏幕录制不参与停止判定）
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function PermsPage() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [listenAccess, setListenAccess] = useState<boolean | null>(null);
  const [axServiceOk, setAxServiceOk] = useState<boolean | null>(null);
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);

  useEffect(() => {
    let stop = false;
    let t: number | undefined;
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
          t = window.setTimeout(poll, 2000);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stop = true;
      if (t !== undefined) window.clearTimeout(t);
    };
  }, []);

  return (
          <>
            <h1>权限</h1>
            <p className="page-hint">
              划词需「辅助功能」与「输入监控」，识图需「屏幕录制」。授权后返回，状态自动刷新。
            </p>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">辅助功能</div>
                  <div className="row-sub">
                    {granted === false
                      ? "划词必需，授权后才能读取所选文字。"
                      : "读取所选文字，供翻译、解释、总结使用。"}
                  </div>
                </div>
                <span className={`pill ${granted ? "ok" : granted === false ? "bad" : ""}`}>
                  {granted === null ? "检测中" : granted ? "已授权" : "未授权"}
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
                    授权划词
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">输入监控</div>
                  <div className="row-sub">
                    {listenAccess === false
                      ? "浮动条必需，授权后划选文字才会弹出浮动条。"
                      : "监听划选动作，选定即弹出浮动条。"}
                  </div>
                </div>
                <span className={`pill ${listenAccess ? "ok" : listenAccess === false ? "bad" : ""}`}>
                  {listenAccess === null ? "检测中" : listenAccess ? "已授权" : "未授权"}
                </span>
              </div>
              {listenAccess === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() => invoke<boolean>("request_listen_access").catch(() => undefined)}
                  >
                    授权输入监控
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">屏幕录制</div>
                  <div className="row-sub">
                    {screenAccess === false
                      ? "识图取字必需，授权后即可框选屏幕文字识别。"
                      : "识图取字的前提，识别全程在本机完成，画面不上传。"}
                  </div>
                </div>
                <span className={`pill ${screenAccess ? "ok" : screenAccess === false ? "bad" : ""}`}>
                  {screenAccess === null ? "检测中" : screenAccess ? "已授权" : "未授权"}
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
                    授权屏幕录制
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">取词健康自检</div>
                  <div className="row-sub">
                    划词失灵时的诊断。权限均已授权却无浮动条，请在系统设置里关掉再打开拾趣的「辅助功能」，重启应用恢复。
                  </div>
                </div>
                <span className={`pill ${axServiceOk ? "ok" : axServiceOk === false ? "bad" : ""}`}>
                  {axServiceOk === null ? "检测中" : axServiceOk ? "正常" : "异常"}
                </span>
              </div>
            </div>
    </>
  );
}
