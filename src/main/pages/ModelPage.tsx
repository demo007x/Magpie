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

const NEW_PROVIDER = (): Provider => ({
  id: `p${Date.now()}`,
  name: "自定义服务",
  baseUrl: "",
  apiKey: "",
  model: "",
  form: "chat",
});

export default function ModelPage({ settings, patch, save, saved }: PageProps) {
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
      name: preset.label,
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
            <h1>模型服务</h1>
            <p className="page-hint">
              添加模型服务选预设即可自动带出地址与形态，只填密钥并确认模型名；设为默认的一项供全部划词动作调用。密钥仅保存在本机。更改需保存后生效。
            </p>

            <h2 className="sec">服务</h2>
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
                      {p.name || "未命名服务"}
                      <span className="action-desc">{p.model || "未配置模型"}</span>
                      {settings.defaultProviderId === p.id && <span className="tag ai">默认</span>}
                    </div>
                    {/* 不持 onClick：点把手冒泡到卡片头统一切换（与 Prompt 页同约定） */}
                    <button className={`svc-chev ${open ? "open" : ""}`} title={open ? "收起" : "展开编辑"}>
                      <ChevronDown size={13} strokeWidth={2} />
                    </button>
                  </div>
                  <div className={`svc-body ${open ? "open" : ""}`}>
                    <div>
                      <div className="grid">
                        <label className="field">
                          <span>名称</span>
                          <input value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
                        </label>
                        <label className="field">
                          <span>模型</span>
                          <input
                            value={p.model}
                            placeholder={preset?.hint ?? ""}
                            onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                          />
                        </label>
                        {/* 接口形态所有卡常驻：形态选择权在用户（厂商随时可能新增
                            端点，注册表快照不该锁死）。预设含该形态地址则切换时
                            自动带出（不同形态端点前缀可能完全不同，如智谱两形态
                            是两个基址）；未含则保持当前地址由用户自行确认 */}
                        <label className="field">
                          <span>接口形态</span>
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
                                {f === "chat" ? "Chat · 通用" : "Responses"}
                              </label>
                            ))}
                          </div>
                        </label>
                        <label className="field wide">
                          <span>服务地址</span>
                          <input value={p.baseUrl} onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })} />
                        </label>
                        <label className="field wide">
                          <span>API 密钥</span>
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
                          <div className="row-title">思考模式</div>
                          <div className="row-sub">开启后回答更准但更慢，关闭更快。</div>
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
                          设为默认
                        </label>
                        <button
                          className="row-del"
                          title="删除该服务"
                          aria-label="删除该服务"
                          onClick={() => {
                            if (settings.providers.length <= 1) {
                              toast("至少保留一个模型服务", "err");
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
                <Plus size={13} strokeWidth={2} /> {provPickerOpen ? "收起" : "添加服务"}
              </button>
              {/* 内联 chips 面板（与翻译页同款交互）：选预设即预填地址/形态/候选模型，
                  点自定义保留手填全项；不置灰已添加项——同一家开两个号是合理需求 */}
              {provPickerOpen && (
                <div className="svc-chips">
                  {PRESET_PROVIDERS.map((ps) => (
                    <button key={ps.id} className="svc-chip" onClick={() => addProvider(ps)}>
                      {ps.label}
                    </button>
                  ))}
                  <button className="svc-chip" onClick={addCustomProvider}>
                    自定义
                  </button>
                </div>
              )}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>

            {confirmDelProvider &&
              (() => {
                const p = settings.providers.find((x) => x.id === confirmDelProvider);
                if (!p) return null;
                return (
                  <Confirm
                    title="删除服务"
                    text={`删除「${p.name || "未命名服务"}」？模型名、服务地址与 API 密钥会一并移除。`}
                    onCancel={() => setConfirmDelProvider(null)}
                    onConfirm={() => removeProvider(confirmDelProvider)}
                  />
                );
              })()}
    </>
  );
}
