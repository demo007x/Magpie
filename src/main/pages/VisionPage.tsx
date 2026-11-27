// 识图配置页：识图「识别文字/翻译/解释/总结」是否改由模型直接看图处理。
// 行语义由页顶 hint 一句统一说明（四个开关无差异描述）；资格判定还需默认
// 模型服务已配置密钥（「模型」页）。二维码例外：纯本机解码与模型无关，
// 单独一张卡 + 行内副文案说明语义差异。自动保存页（patch + saveNow，无保存按钮）。
import type { Settings } from "../../shared/types";
import { TutorialButton } from "../../shared/TutorialModal";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

const VISION_ITEMS: Array<[keyof Settings["vision"], string]> = [
  ["ocr", "vision.ocr"],
  ["translate", "vision.translate"],
  ["explain", "vision.explain"],
  ["summarize", "vision.summarize"],
];

export default function VisionPage({ settings, patch, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const patchVision = (k: keyof Settings["vision"], v: boolean) => {
    patch({ vision: { ...settings.vision, [k]: v } });
    saveNow?.();
  };

  return (
    <>
      <p className="page-hint">
        {t("vision.hint")} <TutorialButton id="vision" />
      </p>
      <div className="card">
        {VISION_ITEMS.map(([k, label], i) => (
          <div className={`row-between${i > 0 ? " sep" : ""}`} key={k}>
            <div className="row-title">{t(label)}</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.vision[k]}
                onChange={(e) => patchVision(k, e.target.checked)}
              />
              <span className="knob" />
            </label>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-title">{t("vision.qr")}</div>
            <div className="row-sub">{t("vision.qrSub")}</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.vision.qr}
              onChange={(e) => patchVision("qr", e.target.checked)}
            />
            <span className="knob" />
          </label>
        </div>
      </div>
    </>
  );
}
