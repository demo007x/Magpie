// 模型服务页：服务卡（名称/地址/密钥/模型/接口形态）+ 预设 chips 添加 + 默认项/删除。
import { useState } from "react";
import {
  formEntryOf,
  PRESET_PROVIDERS,
  presetByBaseUrl,
  type ProviderPreset,
} from "../../shared/providerPresets";
import { Confirm } from "../../shared/Modal";
import { toast } from "../../shared/toast";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type { Provider } from "../../shared/types";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

const NEW_PROVIDER = (): Provider => ({
  id: `p${Date.now()}`,
  name: t("model.newProviderName"),
  baseUrl: "",
  apiKey: "",
  model: "",
  form: "chat",
});

export default function ModelPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [providerOpen, setProviderOpen] = useState<string | null>(null);
  // 「添加服务」预设 chips 面板（与翻译页同款内联交互）
  const [provPickerOpen, setProvPickerOpen] = useState(false);
  /** 待删除条目的确认框（模型服务）：确认走 Modal
   *  （confirm() 在 WKWebView 里恒为 false，用它等于删不掉） */
  const [confirmDelProvider, setConfirmDelProvider] = useState<string | null>(null);

  const patchProvider = (id: string, p: Partial<Provider>) => {
    patch((s) => ({ providers: s.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  };
  // 添加模型服务：预设（预填名称/地址/形态/候选模型，只差密钥）或自定义（手填全项）。
  // 不置灰已添加预设——同一家开两个号是合理需求
  const addProvider = (preset: ProviderPreset) => {
    if (!settings) return;
    const p: Provider = {
      id: `p${Date.now()}`,
      name: t(preset.label),
      baseUrl: preset.forms[0].baseUrl,
      apiKey: "",
      model: "",
      form: preset.forms[0].form,
    };
    patch({
      providers: [...settings.providers, p],
      defaultProviderId: settings.providers.length === 0 ? p.id : settings.defaultProviderId,
    });
    setProviderOpen(p.id); // 新卡自动展开，直接进入编辑
    setProvPickerOpen(false);
  };
  const addCustomProvider = () => {
    if (!settings) return;
    const p = NEW_PROVIDER();
    patch({
      providers: [...settings.providers, p],
      defaultProviderId: settings.providers.length === 0 ? p.id : settings.defaultProviderId,
    });
    setProviderOpen(p.id);
    setProvPickerOpen(false);
  };
  const removeProvider = (id: string) => {
    if (!settings) return;
    const rest = settings.providers.filter((x) => x.id !== id);
    patch({
      providers: rest,
      defaultProviderId:
        settings.defaultProviderId === id ? rest[0].id : settings.defaultProviderId,
    });
    setConfirmDelProvider(null);
  };

  return (
          <>
            <h1>{t("model.title")}</h1>
            <p className="page-hint">
              {t("model.hint")}
            </p>

            <h2 className="sec">{t("model.servicesSec")}</h2>
            {settings.providers.map((p) => {
              const open = providerOpen === p.id;
              // 按地址反查预设（含所在形态项）：命中则给占位指引并决定形态切换是否露出；
              // 改过地址即不再命中
              const hit = presetByBaseUrl(p.baseUrl);
              const preset = hit?.preset;
              return (
                <div className="card" key={p.id}>
                  {/* 折叠卡头：名称 + 模型 + 默认标记，点击展开编辑（与 Prompt 页同形态） */}
                  <div className="prompt-head" onClick={() => setProviderOpen(open ? null : p.id)}>
                    <div className="row-title">
                      {p.name || t("model.unnamedSvc")}
                      <span className="action-desc">{p.model || t("model.noModel")}</span>
                      {settings.defaultProviderId === p.id && (
                        <span className="tag ai">{t("common.default")}</span>
                      )}
                    </div>
                    {/* 不持 onClick：点把手冒泡到卡片头统一切换（与 Prompt 页同约定） */}
                    <button
                      className={`svc-chev ${open ? "open" : ""}`}
                      title={open ? t("common.collapse") : t("common.expandEdit")}
                    >
                      <ChevronDown size={13} strokeWidth={2} />
                    </button>
                  </div>
                  <div className={`svc-body ${open ? "open" : ""}`}>
                    <div>
                      <div className="grid">
                        <label className="field">
                          <span>{t("model.fName")}</span>
                          <input value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
                        </label>
                        <label className="field">
                          <span>{t("model.fModel")}</span>
                          <input
                            value={p.model}
                            placeholder={preset ? t(preset.hint) : ""}
                            onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                          />
                        </label>
                        {/* 接口形态所有卡常驻：形态选择权在用户（厂商随时可能新增
                            端点，注册表快照不该锁死）。预设含该形态地址则切换时
                            自动带出（不同形态端点前缀可能完全不同，如智谱两形态
                            是两个基址）；未含则保持当前地址由用户自行确认 */}
                        <label className="field">
                          <span>{t("model.fForm")}</span>
                          <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
                            {(["chat", "responses"] as const).map((f) => (
                              <label key={f} className="radio sm">
                                <input
                                  type="radio"
                                  name={`form-${p.id}`}
                                  checked={(p.form ?? "chat") === f}
                                  onChange={() => {
                                    const next = preset ? formEntryOf(preset, f) : undefined;
                                    patchProvider(
                                      p.id,
                                      next ? { form: f, baseUrl: next.baseUrl } : { form: f },
                                    );
                                  }}
                                />
                                {f === "chat" ? t("model.formChat") : "Responses"}
                              </label>
                            ))}
                          </div>
                        </label>
                        <label className="field wide">
                          <span>{t("model.fBaseUrl")}</span>
                          <input value={p.baseUrl} onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })} />
                        </label>
                        <label className="field wide">
                          <span>{t("model.fApiKey")}</span>
                          <input
                            type="password"
                            value={p.apiKey}
                            placeholder="sk-…"
                            onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                          />
                        </label>
                      </div>
                      <div className="row-between" style={{ marginTop: 10 }}>
                        <div>
                          <div className="row-title">{t("model.thinking")}</div>
                          <div className="row-sub">{t("model.thinkingSub")}</div>
                        </div>
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={!!p.thinking}
                            onChange={(e) => patchProvider(p.id, { thinking: e.target.checked })}
                          />
                          <span className="knob" />
                        </label>
                      </div>
                      <div className="card-foot">
                        <label className="radio">
                          <input
                            type="radio"
                            name="defaultProvider"
                            checked={settings.defaultProviderId === p.id}
                            onChange={() => patch({ defaultProviderId: p.id })}
                          />
                          {t("model.setAsDefault")}
                        </label>
                        <button
                          className="row-del"
                          title={t("model.delSvcTitle")}
                          aria-label={t("model.delSvcTitle")}
                          onClick={() => {
                            if (settings.providers.length <= 1) {
                              toast(t("model.keepOne"), "err");
                              return;
                            }
                            setConfirmDelProvider(p.id);
                          }}
                        >
                          <Trash2 size={13} strokeWidth={1.75} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="prov-add">
              <button className="btn" onClick={() => setProvPickerOpen((v) => !v)}>
                <Plus size={13} strokeWidth={2} />{" "}
                {provPickerOpen ? t("common.collapse") : t("common.addService")}
              </button>
              {/* 内联 chips 面板（与翻译页同款交互）：选预设即预填地址/形态/候选模型，
                  点自定义保留手填全项；不置灰已添加项——同一家开两个号是合理需求 */}
              {provPickerOpen && (
                <div className="svc-chips">
                  {PRESET_PROVIDERS.map((ps) => (
                    <button key={ps.id} className="svc-chip" onClick={() => addProvider(ps)}>
                      {t(ps.label)}
                    </button>
                  ))}
                  <button className="svc-chip" onClick={addCustomProvider}>
                    {t("common.custom")}
                  </button>
                </div>
              )}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? t("common.saved") : t("common.saveChanges")}
              </button>
            </div>

            {confirmDelProvider &&
              (() => {
                const p = settings.providers.find((x) => x.id === confirmDelProvider);
                if (!p) return null;
                return (
                  <Confirm
                    title={t("model.delConfirmTitle")}
                    text={t("model.delSvcText", {
                      name: p.name || t("model.unnamedSvc"),
                    })}
                    onCancel={() => setConfirmDelProvider(null)}
                    onConfirm={() => removeProvider(confirmDelProvider)}
                  />
                );
              })()}
    </>
  );
}
