// 翻译服务配置完备性（设置页与浮动条共用，文案与逻辑不区分平台）：
// 设置页在「开启 / 设为默认」时拦截，浮动条在真正使用时兜底提醒——
// 两处共用本模块的判据与文案，避免漂移。
import type { Provider, TranslateConfig } from "./types";

/** 服务未配置时返回提示文案（一行直给用户该做什么），已配置返回 null */
export function translateMissingReason(
  t: TranslateConfig,
  providers: Provider[],
  defaultProviderId: string,
  id: string,
): string | null {
  if (id === "baidu") {
    if (!t.appId.trim() || !t.appKey.trim()) {
      return "请先填写百度翻译的 APPID 和密钥";
    }
  } else if (id === "deepl") {
    if (!t.deeplKey.trim()) {
      return "请先填写 DeepL 密钥";
    }
  } else if (id === "ai") {
    // AI 翻译走「模型服务」页的默认模型：默认模型不存在或密钥/模型名缺失 = 未配置
    const p = providers.find((x) => x.id === defaultProviderId);
    if (!p || !p.apiKey.trim() || !p.model.trim()) {
      return "请先在模型服务页配置默认模型";
    }
  }
  return null;
}
