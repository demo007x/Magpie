// 翻译服务页：已添加服务列表（启停/默认/凭据/拖拽排序）+ 「添加服务」内联 chips。
// 停用只摘出浮动条列表、凭据保留（用量耗尽先停不删）；移除连凭据删净需二次确认。
import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, GripVertical, Plus, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../../shared/toast";
import { Confirm } from "../../shared/Modal";
import { TRANSLATE_SERVICES, translateService, type TranslateService } from "../../shared/translate";
import type { PageProps } from "./types";

export default function TranslatePage({
  settings,
  patch,
  save,
  saved,
  setPage,
  // 凭据折叠态由 App 持有：保存闸（任意页触发）发现必填凭据缺失时，要能当场展开对应行
  svcOpen,
  setSvcOpen,
}: PageProps & {
  setPage: (p: "model") => void;
  svcOpen: Record<string, boolean>;
  setSvcOpen: (f: (m: Record<string, boolean>) => Record<string, boolean>) => void;
}) {
  // ---- 翻译服务排序（拖拽，同引擎列表） ----
  const svcRowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [svcDragId, setSvcDragId] = useState<string | null>(null);
  const [svcOverId, setSvcOverId] = useState<string | null>(null);
  const svcOverRef = useRef<string | null>(null);
  // 「添加服务」内联 chips 面板（卡片底部展开，非弹窗）：完整目录常驻，已添加置灰
  const [svcPickerOpen, setSvcPickerOpen] = useState(false);
  // 移除翻译服务的二次确认（.row-del 一发就删太容易手滑；确认文案言明密钥同删）
  const [confirmDelSvc, setConfirmDelSvc] = useState<string | null>(null);


  // 翻译服务列表：已添加的（order ∪ enabled——旧配置 enabled 可能超出 order）
  // 按 order 排，order 里没记到的 id 按注册表顺序垫底。行内开关决定是否进入
  // 浮动条「翻译」展开列表（enabled ⊆ 已添加 ⊆ 注册表）；停用只摘出菜单，
  // 凭据保留（用量耗尽时先停不删配置）
  const translateRows: TranslateService[] = (() => {
    if (!settings) return [];
    const t = settings.translate;
    const regIdx = (id: string) => TRANSLATE_SERVICES.findIndex((s) => s.id === id);
    const okey = (id: string) => {
      const i = t.order.indexOf(id);
      return i >= 0 ? i : TRANSLATE_SERVICES.length + regIdx(id);
    };
    return [...new Set([...t.order, ...t.enabled])]
      .map((id) => translateService(id))
      .filter((s): s is TranslateService => !!s)
      .sort((a, b) => okey(a.id) - okey(b.id));
  })();
  // 已添加集合（选择器据此排除，停用中的不算未添加）
  const addedServiceIds = new Set(
    settings ? [...settings.translate.order, ...settings.translate.enabled] : [],
  );

  const onSvcGripDown = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setSvcDragId(id);
    const onMove = (ev: MouseEvent) => {
      let hit: string | null = null;
      svcRowEls.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) hit = key;
      });
      svcOverRef.current = hit;
      setSvcOverId(hit);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = svcOverRef.current;
      setSvcDragId(null);
      setSvcOverId(null);
      svcOverRef.current = null;
      if (!target || target === id) return;
      // 行序即新 order：列表是已添加全集，按视觉顺序整体替换
      const ids = translateRows.map((r) => r.id);
      const from = ids.indexOf(id);
      const to = ids.indexOf(target);
      if (from < 0 || to < 0 || !settings) return;
      ids.splice(from, 1);
      ids.splice(to, 0, id);
      patch({ translate: { ...settings.translate, order: ids } });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };



  // 翻译服务添加/移除：添加即启用（凭据可后补）；停用只摘出菜单、保留配置
  // （用量耗尽先停不删）——「保留配置」是停用的语义，移除则连凭据一起删净，
  // 两个动作分工明确，删除不留不可见的残余状态。默认项被停用/移除时顺延
  const addTranslate = (id: string) => {
    if (!settings) return;
    const cur = settings.translate;
    if (addedServiceIds.has(id)) return;
    const enabled = [...cur.enabled, id];
    setSvcOpen((m) => ({ ...m, [id]: true })); // 添加即自动展开该服务的凭据填写
    patch({
      translate: {
        ...cur,
        enabled,
        order: [...cur.order, id],
        default: cur.default || enabled[0] || "",
      },
    });
  };

  const removeTranslate = (id: string) => {
    if (!settings) return;
    const cur = settings.translate;
    if (cur.enabled.length <= 1) {
      toast("至少保留一个翻译服务", "err");
      return;
    }
    const enabled = cur.enabled.filter((x) => x !== id);
    const credentials = { ...cur.credentials };
    delete credentials[id];
    patch({
      translate: {
        ...cur,
        enabled,
        order: cur.order.filter((x) => x !== id),
        default: cur.default === id ? (enabled[0] ?? "") : cur.default,
        credentials,
      },
    });
    setConfirmDelSvc(null);
  };

  // 停用只摘出「翻译」展开列表（凭据与排序保留），全部停用也允许——
  // 浮动条点击翻译时会兜底提示未启用服务
  const toggleTranslate = (id: string, on: boolean) => {
    if (!settings) return;
    const cur = settings.translate;
    const enabled = on
      ? cur.enabled.includes(id)
        ? cur.enabled
        : [...cur.enabled, id]
      : cur.enabled.filter((x) => x !== id);
    patch({
      translate: {
        ...cur,
        enabled,
        default: enabled.includes(cur.default) ? cur.default : (enabled[0] ?? ""),
      },
    });
  };

  // 翻译凭据输入：函数式 partial（密钥是文本输入，同 updateCustom 的连发丢键风险）
  const updateCred = (svcId: string, field: string, value: string) => {
    patch((s) => ({
      translate: {
        ...s.translate,
        credentials: {
          ...s.translate.credentials,
          [svcId]: { ...s.translate.credentials[svcId], [field]: value },
        },
      },
    }));
  };



  return (
          <>
            <h1>翻译</h1>
            <p className="page-hint">
              「添加服务」选择服务商，添加即启用；开关可随时停用，配置保留；密钥在行内填写，「默认」为单击直达项，拖动调整顺序；译文方向自动识别。点「保存更改」永久生效。
            </p>

            <h2 className="sec">服务</h2>
            <div className="card">
              {translateRows.map((svc) => (
                <div
                  key={svc.id}
                  ref={(el) => {
                    if (el) svcRowEls.current.set(svc.id, el);
                    else svcRowEls.current.delete(svc.id);
                  }}
                  className={`svc ${svcDragId === svc.id ? "dragging" : ""} ${
                    svcOverId === svc.id && svcDragId && svcDragId !== svc.id ? "drop-target" : ""
                  }`}
                >
                  <div className="svc-main">
                    <span
                      className="grip"
                      title="拖动排序"
                      onMouseDown={(e) => onSvcGripDown(e, svc.id)}
                    >
                      <GripVertical size={13} strokeWidth={1.75} />
                    </span>
                    <div className="svc-content">
                      <div className="svc-head">
                        <div className="row-title">{svc.label}</div>
                        <div className="row-ctl">
                          <label
                            className="radio sm"
                            title={
                              settings.translate.enabled.includes(svc.id)
                                ? "设为默认翻译服务"
                                : "启用后才可设为默认"
                            }
                          >
                            <input
                              type="radio"
                              name="defaultTranslate"
                              checked={settings.translate.default === svc.id}
                              disabled={!settings.translate.enabled.includes(svc.id)}
                              onChange={() =>
                                patch({ translate: { ...settings.translate, default: svc.id } })
                              }
                            />
                            默认
                          </label>
                          <label className="switch" title="启用后进入「翻译」展开列表">
                            <input
                              type="checkbox"
                              checked={settings.translate.enabled.includes(svc.id)}
                              onChange={(e) => toggleTranslate(svc.id, e.target.checked)}
                            />
                            <span className="knob" />
                          </label>
                          <button
                            className="row-del"
                            title="移除该服务"
                            aria-label={`移除${svc.label}`}
                            onClick={() => {
                              if (settings.translate.enabled.length <= 1) {
                                toast("至少保留一个翻译服务", "err");
                                return;
                              }
                              setConfirmDelSvc(svc.id);
                            }}
                          >
                            <Trash2 size={13} strokeWidth={1.75} />
                          </button>
                          <button
                            className={`svc-chev ${svcOpen[svc.id] ? "open" : ""}`}
                            title={svcOpen[svc.id] ? "收起配置" : "展开配置"}
                            onClick={() => setSvcOpen((m) => ({ ...m, [svc.id]: !m[svc.id] }))}
                          >
                            <ChevronDown size={13} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                      <div className="row-sub">{svc.blurb}</div>

                      {svc.auth === "ai" && (
                        <div className={`svc-body ${svcOpen[svc.id] ? "open" : ""}`}>
                          <div>
                            <div className="svc-fields">
                              <div className="svc-fields-foot">
                                <button
                                  className="btn sm"
                                  onClick={() => setPage("model")}
                                >
                                  前往模型服务
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {svc.fields.length > 0 && (
                        <div className={`svc-body ${svcOpen[svc.id] ? "open" : ""}`}>
                          <div>
                            <div className="svc-fields">
                              {svc.fields.map((f) => (
                                <label
                                  key={f.field}
                                  className={`field ${svc.fields.length === 1 ? "wide" : ""}`}
                                >
                                  <span>{f.label}</span>
                                  <input
                                    type={f.secret ? "password" : "text"}
                                    value={
                                      (settings.translate.credentials[svc.id]?.[f.field] as
                                        | string
                                        | undefined) ?? ""
                                    }
                                    onChange={(e) =>
                                      updateCred(svc.id, f.field, e.target.value)
                                    }
                                    placeholder={f.placeholder}
                                  />
                                </label>
                              ))}
                              <div className="svc-fields-foot">
                                <button
                                  className="btn sm"
                                  onClick={() =>
                                    invoke("open_url", { url: svc.docsUrl }).catch(
                                      () => undefined,
                                    )
                                  }
                                >
                                  {svc.docsLabel}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {TRANSLATE_SERVICES.some((s) => !addedServiceIds.has(s.id)) && (
                <div className="card-foot">
                  <button className="btn sm" onClick={() => setSvcPickerOpen((v) => !v)}>
                    <Plus size={13} strokeWidth={2} /> {svcPickerOpen ? "收起" : "添加服务"}
                  </button>
                </div>
              )}
              {/* 内联 chips 面板（替代弹窗）：名字即决策，描述在列表行里常年可见；
                  完整目录常驻（已添加置灰打勾），点即添加并收起 */}
              {svcPickerOpen && (
                <div className="svc-chips">
                  {TRANSLATE_SERVICES.map((s) => {
                    const added = addedServiceIds.has(s.id);
                    return (
                      <button
                        key={s.id}
                        className="svc-chip"
                        disabled={added}
                        onClick={() => {
                          addTranslate(s.id);
                          setSvcPickerOpen(false);
                        }}
                      >
                        {added ? `✓ ${s.label}` : s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>

            {confirmDelSvc &&
              (() => {
                const svc = translateRows.find((x) => x.id === confirmDelSvc);
                if (!svc) return null;
                return (
                  <Confirm
                    title="移除翻译服务"
                    text={`移除「${svc.label}」？已填写的密钥会一并删除；停用可保留配置。`}
                    onCancel={() => setConfirmDelSvc(null)}
                    onConfirm={() => removeTranslate(confirmDelSvc)}
                  />
                );
              })()}
    </>
  );
}
