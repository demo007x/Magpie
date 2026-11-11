// 朗读页：本地音色包（Kokoro ONNX）的下载引导 + 中英文默认音色选择与试听。
// 下载进度与播放结束都走 Rust 事件：下载可能持续几分钟，进度条不能依赖
// 命令返回值；播放结束事件用来把「停止」按钮复位成「试听」。
// 中文音色共 100 个，男女分开成两个选择器（女 55 / 男 45）——混在一个下拉里
// 要翻 100 行；每行右侧带试听钮，挑音色必须先能听，不能逼用户「选中才能试听」。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AudioLines, ChevronDown, Play } from "lucide-react";
import { Confirm } from "../../shared/Modal";
import { toast } from "../../shared/toast";
import { t, useLocale } from "../../shared/i18n";
import type { PageProps } from "./types";

interface TtsStatus {
  supported: boolean;
  enabled: boolean;
  installed: boolean;
  downloading: boolean;
}

interface Progress {
  stage: string;
  percent: number;
}

/** 音色条目：sid 为 Kokoro voices.bin 的索引；rec = 下拉里挂「推荐」徽标 */
interface VoiceItem {
  sid: number;
  label: string;
  rec?: boolean;
}

/** 一组音色（中文女声 / 中文男声 / 英文） */
interface VoiceGroup {
  key: string;
  items: VoiceItem[];
}

const EN_VOICES = [
  // sid 0 真机对比胜出（fp32 完整精度下英文自然度明显优于同组其余音色），标推荐
  { sid: 0, key: "speech.voiceEnF", n: 1, rec: true },
  { sid: 1, key: "speech.voiceEnF", n: 2 },
  { sid: 2, key: "speech.voiceEnUk" },
] as const;

export default function SpeechPage({ settings, patch, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState("");
  /** 展开的选择器（分组 key；null = 都收起） */
  const [open, setOpen] = useState<string | null>(null);
  /** 正在试听的 sid（null = 没有播放） */
  const [playing, setPlaying] = useState<number | null>(null);
  /** 关闭朗读的确认弹窗（关闭即删几百 MB 的包，属危险操作，先过 Confirm） */
  const [confirmOff, setConfirmOff] = useState(false);
  /** 下载包总大小（MB）：探不到下载源时为 null，文案不带数字 */
  const [remoteSize, setRemoteSize] = useState<number | null>(null);
  /** 已安装的装机占用（MB）：卸载确认框里显示实测值 */
  const [installedSize, setInstalledSize] = useState<number | null>(null);
  /**
   * 每个选择器「上次选中的 sid」：只有默认音色会被落盘，但另一性别的选择器
   * 不该因此跳回第一个——单独记住本组的值，默认归属用「默认」徽标标明
   */
  const [picked, setPicked] = useState<Record<string, number>>(() => {
    const zh = settings.tts.zhVoice;
    return {
      zhF: zh >= 3 && zh < 58 ? zh : 3,
      zhM: zh >= 58 ? zh : 58,
      en: settings.tts.enVoice,
    };
  });

  const refresh = () => {
    invoke<TtsStatus>("tts_status")
      .then(setStatus)
      .catch(() => undefined);
  };

  useEffect(() => {
    refresh();
    // 下载量动态探测（HEAD content-length）：探不到就让文案隐藏数字
    invoke<number | null>("tts_remote_sizes")
      .then((v) => setRemoteSize(v == null ? null : Math.round(v / 1e6)))
      .catch(() => undefined);
    const unProgress = listen<Progress>("tts://progress", (e) => {
      setStage(e.payload.stage);
      setPercent(e.payload.percent);
    });
    const unEnd = listen("tts://end", () => setPlaying(null));
    // 装卸状态被别处改变（卸载完成 / 下载完成）时同步本页
    const unChanged = listen("tts://changed", () => refresh());
    return () => {
      unProgress.then((f) => f());
      unEnd.then((f) => f());
      unChanged.then((f) => f());
      // 离开页面即停：朗读是「看完就走」的伴随动作，不该留在后台
      invoke("tts_stop").catch(() => undefined);
    };
  }, []);

  // 已安装时装机占用实测：卸载确认框显示真实数字
  useEffect(() => {
    if (!status?.installed) {
      setInstalledSize(null);
      return;
    }
    invoke<number>("tts_installed_size")
      .then((v) => setInstalledSize(Math.round(v / 1e6)))
      .catch(() => undefined);
  }, [status?.installed]);

  // 点击选择器以外的地方收起列表（下拉是就地展开的浮层，不留常驻状态）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".voice-row")) setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const download = () => {
    setBusy(true);
    setStage("engine");
    setPercent(0);
    invoke("tts_download")
      .then(() => setPercent(100))
      .catch((e) => toast(t("speech.downloadFailed", { error: String(e) }), "err"))
      .finally(() => {
        setBusy(false);
        setStage("");
        refresh();
      });
  };

  const stop = () => {
    invoke("tts_stop").catch(() => undefined);
    setPlaying(null);
  };

  /** 开关朗读：关闭即卸载音色包（Rust 侧停声删文件），开启则回到下载引导 */
  const setEnabled = (on: boolean) => {
    setConfirmOff(false);
    patch({ tts: { ...settings.tts, enabled: on } });
    saveNow?.();
    if (on) return;
    setPlaying(null);
    setBusy(true);
    invoke("tts_uninstall")
      .catch((e) => toast(t("speech.uninstallFailed", { error: String(e) }), "err"))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  /** 试听指定音色：sid 随命令下发，不等设置落盘（选音色与试听互不依赖） */
  const preview = (lang: "zh" | "en", sid: number) => {
    invoke("tts_stop").catch(() => undefined);
    const text = lang === "zh" ? t("speech.sampleZh") : t("speech.sampleEn");
    invoke("tts_speak", { text, lang, sid })
      .then(() => setPlaying(sid))
      .catch((e) => toast(t("speech.previewFailed", { error: String(e) }), "err"));
  };

  const togglePreview = (lang: "zh" | "en", sid: number) => {
    if (playing === sid) {
      stop();
      return;
    }
    preview(lang, sid);
  };

  const setVoice = (lang: "zh" | "en", group: string, sid: number) => {
    setPicked((p) => ({ ...p, [group]: sid }));
    patch({
      tts:
        lang === "zh"
          ? { ...settings.tts, zhVoice: sid }
          : { ...settings.tts, enVoice: sid },
    });
    saveNow?.();
    setOpen(null);
  };

  if (!status) return null;

  const zhItems = (from: number, count: number, key: string): VoiceItem[] =>
    Array.from({ length: count }, (_, i) => ({
      sid: from + i,
      label: t(key, { n: i + 1 }),
    }));

  const groupsFor = (lang: "zh" | "en"): VoiceGroup[] =>
    lang === "zh"
      ? [
          { key: "zhF", items: zhItems(3, 55, "speech.voiceZhF") },
          { key: "zhM", items: zhItems(58, 45, "speech.voiceZhM") },
        ]
      : [
          {
            key: "en",
            items: EN_VOICES.map((v) => ({
              sid: v.sid,
              label: t(v.key, "n" in v ? { n: v.n } : undefined),
              rec: "rec" in v ? v.rec : undefined,
            })),
          },
        ];

  const currentSid = (lang: "zh" | "en") =>
    lang === "zh" ? settings.tts.zhVoice : settings.tts.enVoice;

  const groupPicker = (lang: "zh" | "en", g: VoiceGroup) => {
    const sid = picked[g.key] ?? g.items[0].sid;
    const item = g.items.find((v) => v.sid === sid) ?? g.items[0];
    const isDefault = currentSid(lang) === item.sid;
    const expanded = open === g.key;
    return (
      <div
        key={g.key}
        className="voice-row"
        onMouseLeave={() => setOpen((o) => (o === g.key ? null : o))}
      >
        <div className="voice-row-head">
          <button
            className={`voice-pick ${expanded ? "on" : ""}`}
            onClick={() => setOpen(expanded ? null : g.key)}
          >
            <span>{item.label}</span>
            {isDefault && <span className="voice-badge">{t("speech.default")}</span>}
            <ChevronDown size={13} strokeWidth={2} className={expanded ? "open" : ""} />
          </button>
        </div>
        {expanded && (
          <div className="voice-list">
            {g.items.map((v) => (
              <div
                key={v.sid}
                className={`voice-opt ${currentSid(lang) === v.sid ? "on" : ""}`}
                onClick={() => setVoice(lang, g.key, v.sid)}
              >
                <span className="voice-name">{v.label}</span>
                {v.rec && <span className="voice-rec">{t("speech.recommended")}</span>}
                <button
                  className={`voice-play ${playing === v.sid ? "on" : ""}`}
                  title={playing === v.sid ? t("speech.stop") : t("speech.preview")}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePreview(lang, v.sid);
                  }}
                >
                  {/* 播放中换成声波图标（方块是「停止」语义，用在试听里像禁用态） */}
                  {playing === v.sid ? <AudioLines size={12} /> : <Play size={11} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const voiceCard = (lang: "zh" | "en") => (
    <div className="card">
      <div className="voice-rows">{groupsFor(lang).map((g) => groupPicker(lang, g))}</div>
      <div className="voice-foot">
        <span className="row-sub">
          {lang === "zh" ? t("speech.sampleZh") : t("speech.sampleEn")}
        </span>
        <button
          className="btn sm"
          onClick={() => togglePreview(lang, currentSid(lang))}
        >
          {playing === currentSid(lang) ? t("speech.stop") : t("speech.preview")}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <h1>{t("nav.speech")}</h1>
      <p className="page-hint">{t("speech.hint")}</p>

      {status.supported && (
        <div className="card">
          <div className="row-between">
            <div>
              <div className="row-title">{t("speech.enable")}</div>
              <div className="row-sub">{t("speech.enableSub")}</div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.tts.enabled}
                onChange={(e) => {
                  // 关闭即删 320MB 的包：先过确认；取消时还原受控 checkbox
                  if (!e.target.checked && status.installed) {
                    e.target.checked = true;
                    setConfirmOff(true);
                    return;
                  }
                  setEnabled(e.target.checked);
                }}
              />
              <span className="knob" />
            </label>
          </div>
        </div>
      )}

      {!status.supported && (
        <div className="card">
          <div className="row-title">{t("speech.unsupported")}</div>
        </div>
      )}

      {status.supported && settings.tts.enabled && !status.installed && (
        <>
          <h2 className="sec">{t("speech.installTitle")}</h2>
          <div className="card">
            <div className="row-between">
              <div>
                <div className="row-title">{t("speech.installTitle")}</div>
                <div className="row-sub">
                  {remoteSize
                    ? t("speech.installSub", { size: remoteSize })
                    : t("speech.installSubNoNum")}
                </div>
              </div>
              <button className="btn primary" disabled={busy} onClick={download}>
                {busy
                  ? stage === "extract-model"
                    ? t("speech.extracting")
                    : percent < 0
                      ? t("speech.downloadingInd")
                      : t("speech.downloading", { percent: Math.round(percent) })
                  : t("speech.download")}
              </button>
            </div>
            {/* 代理源可能没有总长度（percent=-1）：进度未知时只留文字，不画假进度条 */}
            {busy && percent >= 0 && (
              <div className="bar">
                <div className="bar-fill" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </>
      )}

      {status.supported && settings.tts.enabled && status.installed && (
        <>
          {/* 语速：三档直接落盘（引擎 length-scale 系数），下一次朗读即生效；
              合成缓存键含语速，改档不会串到旧语速的音频 */}
          <div className="card">
            <div className="row-between">
              <div>
                <div className="row-title">{t("speech.speed")}</div>
              </div>
              <div className="seg" role="radiogroup" aria-label={t("speech.speed")}>
                {(
                  [
                    [1.2, "slow"],
                    [1.0, "normal"],
                    [0.85, "fast"],
                  ] as const
                ).map(([v, key]) => (
                  <button
                    key={key}
                    className={settings.tts.speed === v ? "on" : ""}
                    onClick={() => {
                      patch({ tts: { ...settings.tts, speed: v } });
                      saveNow?.();
                    }}
                  >
                    {t(`speech.speed_${key}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <h2 className="sec">{t("speech.zhSec")}</h2>
          {voiceCard("zh")}
          <h2 className="sec">{t("speech.enSec")}</h2>
          {voiceCard("en")}
        </>
      )}

      {confirmOff && (
        <Confirm
          title={t("speech.offTitle")}
          text={
            installedSize
              ? t("speech.offText", { size: installedSize })
              : t("speech.offTextNoNum")
          }
          confirmLabel={t("speech.offConfirm")}
          onCancel={() => setConfirmOff(false)}
          onConfirm={() => setEnabled(false)}
        />
      )}
    </>
  );
}
