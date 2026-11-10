// 朗读页：本地音色包（Kokoro ONNX）的下载引导 + 中英文默认音色选择与试听。
// 下载进度与播放结束都走 Rust 事件：下载可能持续几分钟，进度条不能依赖
// 命令返回值；播放结束事件用来把「停止」按钮复位成「试听」。
// 中文音色共 100 个，男女分开成两个选择器（女 55 / 男 45）——混在一个下拉里
// 要翻 100 行；每行右侧带试听钮，挑音色必须先能听，不能逼用户「选中才能试听」。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AudioLines, ChevronDown, Play } from "lucide-react";
import { toast } from "../../shared/toast";
import { t, useLocale } from "../../shared/i18n";
import type { PageProps } from "./types";

interface TtsStatus {
  supported: boolean;
  installed: boolean;
  downloading: boolean;
}

interface Progress {
  stage: string;
  percent: number;
}

/** 音色条目：sid 为 Kokoro voices.bin 的索引 */
interface VoiceItem {
  sid: number;
  label: string;
}

/** 一组音色（中文女声 / 中文男声 / 英文） */
interface VoiceGroup {
  key: string;
  items: VoiceItem[];
}

const EN_VOICES = [
  { sid: 0, key: "speech.voiceEnF", n: 1 },
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
    const unProgress = listen<Progress>("tts://progress", (e) => {
      setStage(e.payload.stage);
      setPercent(e.payload.percent);
    });
    const unEnd = listen("tts://end", () => setPlaying(null));
    return () => {
      unProgress.then((f) => f());
      unEnd.then((f) => f());
      // 离开页面即停：朗读是「看完就走」的伴随动作，不该留在后台
      invoke("tts_stop").catch(() => undefined);
    };
  }, []);

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

      {!status.supported && (
        <div className="card">
          <div className="row-title">{t("speech.unsupported")}</div>
        </div>
      )}

      {status.supported && !status.installed && (
        <>
          <h2 className="sec">{t("speech.installTitle")}</h2>
          <div className="card">
            <div className="row-between">
              <div>
                <div className="row-title">{t("speech.installTitle")}</div>
                <div className="row-sub">{t("speech.installSub")}</div>
              </div>
              <button className="btn primary" disabled={busy} onClick={download}>
                {busy
                  ? stage === "extract"
                    ? t("speech.extracting")
                    : t("speech.downloading", { percent: Math.round(percent) })
                  : t("speech.download")}
              </button>
            </div>
            {busy && (
              <div className="bar">
                <div
                  className="bar-fill"
                  style={{ width: stage === "extract" ? "100%" : `${percent}%` }}
                />
              </div>
            )}
          </div>
        </>
      )}

      {status.supported && status.installed && (
        <>
          <h2 className="sec">{t("speech.zhSec")}</h2>
          {voiceCard("zh")}
          <h2 className="sec">{t("speech.enSec")}</h2>
          {voiceCard("en")}
        </>
      )}
    </>
  );
}
