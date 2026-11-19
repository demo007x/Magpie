// 识图配置页：识图「识别文字/翻译/解释/总结」是否改由模型直接看图处理。
// 行语义由页顶 hint 一句统一说明（四个开关无差异描述）；资格判定还需默认
// 模型服务已配置密钥（「模型」页）。自动保存页（patch + saveNow，无保存按钮）。
import type { Settings } from "../../shared/types";
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

  return (
    <>
      <p className="page-hint">{t("vision.hint")}</p>
      <div className="card">
        {VISION_ITEMS.map(([k, label], i) => (
          <div className={`row-between${i > 0 ? " sep" : ""}`} key={k}>
            <div className="row-title">{t(label)}</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.vision[k]}
                onChange={(e) => {
                  patch({ vision: { ...settings.vision, [k]: e.target.checked } });
                  saveNow?.();
                }}
              />
              <span className="knob" />
            </label>
          </div>
        ))}
      </div>
    </>
  );
}
