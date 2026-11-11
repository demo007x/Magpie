// 划词页：动作卡（resident/上下文两张 + 拖拽排序）+ 自定义 AI 动作（编辑模态/试跑/删除）
// + 智能提取模式行与提取信息开关组。动作顺序唯一真相 = settings.actionOrder。
import { Fragment, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { GripVertical, Plus, Sparkles } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { toast } from "../../shared/toast";
import { aiChat } from "../../shared/ai";
import {
  allActionIds,
  CONTEXT_ACTION_IDS,
  CUSTOM_ID_PREFIX,
  isAiAction,
} from "../../shared/actions";
import type { CustomAction } from "../../shared/types";
import { SquarePen } from "lucide-react";
import { actionDesc, actionLabel } from "./labels";
import { CUSTOM_ICON_CHOICES, customIconNode } from "../../shared/icons";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

const IS_MAC = /Mac/i.test(navigator.platform);

export default function CapturePage({ settings, patch, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  // 智能提取的前提：默认模型服务已配置（密钥与模型名齐备）——未配置时开关禁用，
  // 与浮动条 AI 动作的显示闸同一判据
  const smartExtractReady = settings
    ? settings.providers.some(
        (p) =>
          p.id === settings.defaultProviderId &&
          p.apiKey.trim() !== "" &&
          p.model.trim() !== "",
      )
    : false;

  // 动作顺序：已配置顺序 + 注册表中新增动作（追加末尾）
  const orderedActionIds = settings ? allActionIds(settings) : [];
  // resident 动作（含自定义）与上下文动作分两张卡：后者只在选中内容含实体时出现，
  // 且同时最多上一个胶囊，四者之间排序对浮动条没有意义——混在常驻列表里反而误导"可排"
  const residentIds = orderedActionIds.filter((id) => !CONTEXT_ACTION_IDS.has(id));
  // 打开地图依赖地名识别（macOS NLTagger，Windows 无系统级等价物）——
  // Windows 上不显示该开关（无能力不显示），地点 chip 运行时本就不会出现
  const contextIds = orderedActionIds.filter(
    (id) => CONTEXT_ACTION_IDS.has(id) && (IS_MAC || id !== "addr"),
  );

  // 拖拽排序（指针事件实现，不依赖 WKWebView 残缺的 HTML5 DnD）：
  // 按住把手 → document 级 mousemove 做行命中检测 → 松手落位
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const overIdRef = useRef<string | null>(null);

  const onGripDown = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
    const onMove = (ev: MouseEvent) => {
      let hit: string | null = null;
      rowEls.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) hit = key;
      });
      overIdRef.current = hit;
      setOverId(hit);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = overIdRef.current;
      setDragId(null);
      setOverId(null);
      overIdRef.current = null;
      if (!target || target === id) return;
      // 落位：从原位置移除后插入目标位置，随即落盘（划词页即时保存）
      patch((s) => {
        const order = allActionIds(s);
        const from = order.indexOf(id);
        const to = order.indexOf(target);
        if (from < 0 || to < 0) return {};
        order.splice(from, 1);
        order.splice(to, 0, id);
        return { actionOrder: order };
      });
      saveNow?.();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  // ---- 自定义 AI 动作 ----
  // 与内置动作混排在同一张「动作」卡里：胶囊顺序 = 这张卡的行序（actionOrder 是唯一真相），
  // 分成两张卡会让用户自造的动作永远排在内置之后，前 4 个可见位就轮不到它了
  const CUSTOM_MAX = 10;
  /** 打开编辑模态的自定义动作 id（名称/图标/提示词/试跑/删除都在模态里完成，
      列表行只留展示与开关——就地展开塞整个表单太拥挤） */
  const [actionModal, setActionModal] = useState<string | null>(null);
  /** 试跑样例文本：按动作 id 存在组件内，不落盘——它是预览输入，不是配置 */
  const [trySample, setTrySample] = useState<Record<string, string>>({});
  /** 试跑结果留在父组件：关掉模态不该打断正在流的输出 */
  const [tryRun, setTryRun] = useState<{
    id: string;
    out: string;
    running: boolean;
    error?: string;
  } | null>(null);
  const tryRunRef = useRef(0);
  /** 编辑模态里删除按钮的二次确认态（模态上不再叠 Confirm，避免两层 Esc） */
  const [delArm, setDelArm] = useState(false);
  /** 图标选择的当前 tab（组名）：打开模态时定位到动作图标所在组 */
  const [iconTab, setIconTab] = useState<string>(CUSTOM_ICON_CHOICES[0].group);

  const customActions = settings?.customActions ?? [];
  const customById = (id: string) => customActions.find((c) => c.id === id);

  /** 打开编辑模态：清掉上一次的试跑流与删除确认态，图标 tab 定位到动作图标所在组
   *  （没设图标则停在「默认」组），用户打开即见当前选中态 */
  const openActionModal = (id: string) => {
    const c = customById(id);
    setIconTab(
      c?.icon
        ? (CUSTOM_ICON_CHOICES.find((g) => g.names.includes(c.icon!))?.group ??
            CUSTOM_ICON_CHOICES[0].group)
        : CUSTOM_ICON_CHOICES[0].group,
    );
    tryRunRef.current++;
    setTryRun(null);
    setDelArm(false);
    setActionModal(id);
  };

  /** 关闭编辑模态 = 即时落盘（完成 / × / Esc / 点遮罩共用路径）：编辑在每次按键
   *  时已写入本地状态，这里统一持久化——划词页不再有「保存更改」按钮 */
  const closeActionModal = () => {
    tryRunRef.current++;
    setTryRun(null);
    setDelArm(false);
    setActionModal(null);
    saveNow?.();
  };

  const updateCustom = (id: string, p: Partial<CustomAction>) => {
    patch((s) => ({
      customActions: s.customActions.map((c) => (c.id === id ? { ...c, ...p } : c)),
    }));
  };

  const addCustom = () => {
    if (!settings || customActions.length >= CUSTOM_MAX) return;
    const id = `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}`;
    patch({
      customActions: [
        ...settings.customActions,
        { id, name: t("capture.newAction"), prompt: "", enabled: true },
      ],
      // 行序表补上新 id：追加在末尾，用户拖把手调整（与搜索引擎「添加」一致）
      actionOrder: [...allActionIds(settings), id],
    });
    openActionModal(id);
  };


  const removeCustom = (id: string) => {
    if (!settings) return;
    patch({
      customActions: settings.customActions.filter((c) => c.id !== id),
      actionOrder: settings.actionOrder.filter((x) => x !== id),
    });
    tryRunRef.current++;
    setTryRun(null);
    setDelArm(false);
    setActionModal(null);
    saveNow?.();
  };

  /** 试跑：走默认模型服务（Rust 读的是已落盘的配置，未保存的改动不生效） */
  const runTry = (c: CustomAction) => {
    if (!c.prompt.trim()) {
      setTryRun({ id: c.id, out: "", running: false, error: t("capture.tryNeedPrompt") });
      return;
    }
    const sample = (trySample[c.id] ?? "").trim();
    if (!sample) {
      setTryRun({ id: c.id, out: "", running: false, error: t("capture.tryNeedSample") });
      return;
    }
    const runId = ++tryRunRef.current;
    let full = "";
    setTryRun({ id: c.id, out: "", running: true });
    aiChat(
      [
        { role: "system", content: c.prompt },
        { role: "user", content: sample },
      ],
      null,
      {
        onDelta: (chunk) => {
          if (tryRunRef.current !== runId) return;
          full += chunk;
          setTryRun((t) => (t && t.id === c.id ? { ...t, out: full } : t));
        },
        onDone: () => {
          if (tryRunRef.current !== runId) return;
          setTryRun((t) => (t && t.id === c.id ? { ...t, running: false } : t));
        },
        onError: (message) => {
          if (tryRunRef.current !== runId) return;
          setTryRun({ id: c.id, out: full, running: false, error: message });
        },
      },
    );
  };

  return (
          <>
            <h1>{t("nav.capture")}</h1>
            <p className="page-hint">
              {t("capture.hint")}
              <br />
              {t("capture.extractHint", {
                addr: IS_MAC ? t("capture.extractHintAddr") : "",
              })}
            </p>

            <h2 className="sec">{t("capture.capsuleSec")}</h2>
            <div className="card">
              <div className="row-between">
                <div className="row-title">
                  {t("capture.showCount")}
                  <span className="action-desc">{t("capture.showCountHint")}</span>
                </div>
                <div className="row-ctl">
                  <button
                    className="btn sm"
                    disabled={settings.capsuleShowCount <= 2}
                    onClick={() => {
                      patch({ capsuleShowCount: settings.capsuleShowCount - 1 });
                      saveNow?.();
                    }}
                  >
                    −
                  </button>
                  <span style={{ minWidth: 16, textAlign: "center" }}>
                    {settings.capsuleShowCount}
                  </span>
                  <button
                    className="btn sm"
                    disabled={settings.capsuleShowCount >= 8}
                    onClick={() => {
                      patch({ capsuleShowCount: settings.capsuleShowCount + 1 });
                      saveNow?.();
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <h2 className="sec">{t("capture.actionsSec")}</h2>
            {Object.values(settings.actions).every((v) => v === false) &&
              !settings.customActions.some((c) => c.enabled) && (
              <div className="all-off-note">
                {t("capture.allOff")}
              </div>
            )}
            <div className="card">
              {residentIds.map((k) => {
                const c = customById(k);
                return (
                  <Fragment key={k}>
                    <div
                      ref={(el) => {
                        if (el) rowEls.current.set(k, el);
                        else rowEls.current.delete(k);
                      }}
                      className={`row-between sep action-row ${dragId === k ? "dragging" : ""} ${
                        overId === k && dragId && dragId !== k ? "drop-target" : ""
                      }`}
                    >
                      <div className="row-title">
                        <span
                          className="grip"
                          title={t("common.dragToSort")}
                          onMouseDown={(e) => onGripDown(e, k)}
                        >
                          <GripVertical size={13} strokeWidth={1.75} />
                        </span>
                        {c && (
                          <span className="row-ic" title={t("capture.iconAlt")}>
                            {customIconNode(c.icon, 14) ?? <Sparkles size={14} strokeWidth={1.75} />}
                          </span>
                        )}
                        {c ? c.name || t("common.unnamed") : actionLabel(k)}
                        {c ? (
                          <span className="tag mine">{t("capture.tagMine")}</span>
                        ) : (
                          isAiAction(k) && <span className="tag ai">AI</span>
                        )}
                        <span className="action-desc">
                          {c ? (c.prompt.trim() ? "" : t("common.promptNotSet")) : actionDesc(k)}
                        </span>
                      </div>
                      <div className="row-ctl">
                        {c && (
                          <button
                            className="svc-chev"
                            title={t("capture.editActionTitle")}
                            onClick={() => openActionModal(k)}
                          >
                            <SquarePen size={13} strokeWidth={2} />
                          </button>
                        )}
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={
                              c
                                ? c.enabled
                                : (settings.actions[k as keyof typeof settings.actions] ?? false)
                            }
                            onChange={(e) => {
                              if (c) {
                                updateCustom(c.id, { enabled: e.target.checked });
                                saveNow?.();
                                return;
                              }
                              // 至少保留一个开启的动作，避免浮动条变空白
                              if (
                                !e.target.checked &&
                                Object.values(settings.actions).filter(Boolean).length <= 1
                              ) {
                                toast(t("capture.keepOneAction"), "err");
                                return;
                              }
                              patch({
                                actions: { ...settings.actions, [k]: e.target.checked },
                              });
                              saveNow?.();
                            }}
                          />
                          <span className="knob" />
                        </label>
                      </div>
                    </div>

                    {/* 编辑/试跑/删除已整体移入编辑模态（见 actionModal）——
                        就地展开塞下名称+图标网格+提示词+试跑太拥挤 */}
                  </Fragment>
                );
              })}
              <button
                className="act-add"
                disabled={customActions.length >= CUSTOM_MAX}
                title={
                  customActions.length >= CUSTOM_MAX
                    ? t("capture.customMax", { max: CUSTOM_MAX })
                    : t("capture.customAddTitle")
                }
                onClick={addCustom}
              >
                <Plus size={13} strokeWidth={2} />
                {t("capture.addCustom")}
              </button>
            </div>

            <h2 className="sec">{t("capture.extractSec")}</h2>
            {/* 智能提取是「怎么提取」的模式，不是「提取什么」的功能——分段控件
                置于节标题下、卡外（用户定稿 2026-10-24）；注释只陈述不解释 */}
            <div className="mode-line">
              <div className="seg" role="radiogroup" aria-label={t("capture.extractModeAria")}>
                <button
                  className={smartExtractReady && settings.smartExtract ? "on" : ""}
                  disabled={!smartExtractReady}
                  onClick={() => {
                    patch({ smartExtract: true });
                    saveNow?.();
                  }}
                >
                  {t("capture.modeAi")}
                </button>
                <button
                  className={!(smartExtractReady && settings.smartExtract) ? "on" : ""}
                  onClick={() => {
                    patch({ smartExtract: false });
                    saveNow?.();
                  }}
                >
                  {t("capture.modeSystem")}
                </button>
              </div>
              <span className="mode-note">
                {/* 说明跟随所选选项（一行只说一件事）；AI 未配置时提示配置入口 */}
                {!smartExtractReady
                  ? t("capture.modeAiHint")
                  : settings.smartExtract
                    ? t("capture.modeAiOnHint")
                    : t("capture.modeSystemHint")}
              </span>
            </div>
            <div className="card">
              {contextIds.map((k) => (
                <div key={k} className="row-between sep action-row context-row">
                  <div className="row-title">
                    {actionLabel(k)}
                    <span className="action-desc">{actionDesc(k)}</span>
                  </div>
                  <div className="row-ctl">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          settings.actions[k as keyof typeof settings.actions] ?? false
                        }
                        onChange={(e) => {
                          patch({ actions: { ...settings.actions, [k]: e.target.checked } });
                          saveNow?.();
                        }}
                      />
                      <span className="knob" />
                    </label>
                  </div>
                </div>
              ))}
            </div>

            {/* 编辑模态：名称/提示词/图标 + 试跑 + 删除在一个面板里完成——
                写提示词 → 就地试跑 → 改，闭环不再跨两个 UI 层。
                提示词取当前编辑内容；模型服务读已落盘配置（试跑前先保存） */}
            {(() => {
              const c = actionModal ? customById(actionModal) : null;
              if (!c) return null;
              const running = tryRun?.id === c.id && tryRun.running;
              return (
                <Modal
                  title={t("capture.customModalTitle", {
                    name: c.name || t("common.unnamed"),
                  })}
                  onClose={closeActionModal}
                  footer={
                    <>
                      <button
                        className={`btn sm ${delArm ? "danger" : ""}`}
                        onClick={() => {
                          if (!delArm) {
                            setDelArm(true);
                            return;
                          }
                          removeCustom(c.id);
                        }}
                      >
                        {delArm ? t("capture.confirmDelete") : t("common.delete")}
                      </button>
                      <button className="btn primary sm" onClick={closeActionModal}>
                        {t("common.done")}
                      </button>
                    </>
                  }
                >
                  <label className="field">
                    <span>{t("capture.nameField")}</span>
                    <input
                      value={c.name}
                      maxLength={8}
                      placeholder={t("capture.namePh")}
                      onChange={(e) => updateCustom(c.id, { name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("capture.promptField")}</span>
                    <textarea
                      className="prompt-input in-field"
                      spellCheck={false}
                      rows={5}
                      placeholder={t("capture.promptPh")}
                      value={c.prompt}
                      onChange={(e) => updateCustom(c.id, { prompt: e.target.value })}
                    />
                  </label>
                  <div className="field">
                    <span>{t("capture.iconField")}</span>
                    <div className="icon-tabs" role="tablist" aria-label={t("capture.iconTabsAria")}>
                      {CUSTOM_ICON_CHOICES.map((g) => (
                        <button
                          key={g.group}
                          role="tab"
                          aria-selected={iconTab === g.group}
                          className={`icon-tab ${iconTab === g.group ? "on" : ""}`}
                          onClick={() => setIconTab(g.group)}
                        >
                          {g.group}
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const group = CUSTOM_ICON_CHOICES.find((g) => g.group === iconTab);
                      if (!group) return null;
                      return (
                        <div className="icon-grid" role="radiogroup" aria-label={t("capture.iconGroupAria", { group: group.group })}>
                          {group.group === CUSTOM_ICON_CHOICES[0].group && (
                            <button
                              type="button"
                              className={`icon-cell ${!c.icon ? "on" : ""}`}
                              title={t("common.default")}
                              aria-label={t("capture.iconDefaultAria")}
                              onClick={() => updateCustom(c.id, { icon: undefined })}
                            >
                              <Sparkles size={16} strokeWidth={1.75} />
                            </button>
                          )}
                          {group.names.map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={`icon-cell ${c.icon === n ? "on" : ""}`}
                              title={n}
                              aria-label={`${group.group} ${n}`}
                              onClick={() => updateCustom(c.id, { icon: n })}
                            >
                              {customIconNode(n, 16)}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="try-block">
                    <label className="field">
                      <span>{t("capture.trySampleField")}</span>
                      <textarea
                        className="prompt-input in-field try-sample"
                        spellCheck={false}
                        placeholder={t("capture.trySamplePh")}
                        value={trySample[c.id] ?? ""}
                        onChange={(e) => setTrySample((m) => ({ ...m, [c.id]: e.target.value }))}
                      />
                    </label>
                    {tryRun?.id === c.id && (tryRun.out || tryRun.error) && (
                      <pre className={`act-out ${tryRun.error ? "bad" : ""}`}>
                        {tryRun.error ?? tryRun.out}
                      </pre>
                    )}
                    <button className="btn sm" disabled={running} onClick={() => runTry(c)}>
                      {running ? t("capture.generating") : t("capture.tryRun")}
                    </button>
                  </div>
                </Modal>
              );
            })()}
    </>
  );
}
