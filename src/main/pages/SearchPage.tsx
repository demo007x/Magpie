// 搜索引擎页：列表增删/启停/默认项 + 指针拖拽排序（与翻译页同款交互，实现独立）。
import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import { toast } from "../../shared/toast";
import type { SearchEngine } from "../../shared/types";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";
import { engineDisplayName } from "../../shared/engineNames";

const BUILTIN_ENGINES = new Set(["百度AI", "百度", "GoogleAI", "Google", "必应", "GitHub"]);

const ENGINE_PRESETS: Array<[string, string]> = [
  ["百度AI", "https://wenxin.baidu.com/search?word={q}"],
  ["百度", "https://www.baidu.com/s?wd={q}"],
  ["GoogleAI", "https://www.google.com/search?q={q}&udm=50"],
  ["Google", "https://www.google.com/search?q={q}"],
  ["必应", "https://www.bing.com/search?q={q}"],
  ["GitHub", "https://github.com/search?q={q}"],
];

export default function SearchPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const engRowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [engDragId, setEngDragId] = useState<string | null>(null);
  const [engOverId, setEngOverId] = useState<string | null>(null);
  const engOverRef = useRef<string | null>(null);

  const updateEngine = (idx: number, p: Partial<SearchEngine>) => {
    // 守卫走渲染闭包即可：点击路径离散无连发竞态；文本字段（名称/URL）才需要函数式
    if (p.enabled === false && settings) {
      if (settings.searchEngines.filter((x) => x.enabled).length <= 1) {
        toast(t("search.keepOne"), "err");
        return;
      }
    }
    patch((s) => {
      const old = s.searchEngines[idx];
      const next = s.searchEngines.map((x, i) => (i === idx ? { ...x, ...p } : x));
      let defaultSearch = s.defaultSearch;
      // 重命名默认引擎时同步默认项；停用默认引擎时顺延到首个启用项
      if (p.name && old.name === defaultSearch) defaultSearch = p.name;
      if (p.enabled === false && defaultSearch === old.name) {
        defaultSearch = next.find((x) => x.enabled)?.name ?? "";
      }
      return { searchEngines: next, defaultSearch };
    });
  };

  const patchEngines = (engines: SearchEngine[]) => patch({ searchEngines: engines });

  // 引擎名的显示变换：内置中文名在英文界面下显示映射名（百度→Baidu），存储值
  // 不动——存储身份就是名字（defaultSearch/拖拽/内置判定按名匹配）。编辑态用
  // 本地暂存，失焦才落存：逐键改名会让行 key（=名字）变化、输入框重挂丢焦点；
  // 失焦时值等于映射名 = 用户没实质改，不写存储（保留映射显示）
  const [nameEdits, setNameEdits] = useState<Record<string, string | undefined>>({});

  const addEngine = (name: string, url: string) => {
    if (!settings) return;
    if (settings.searchEngines.some((e) => e.name === name)) return;
    patchEngines([...settings.searchEngines, { name, url, enabled: true }]);
  };

  const removeEngine = (idx: number) => {
    if (!settings) return;
    const eng = settings.searchEngines[idx];
    if (BUILTIN_ENGINES.has(eng.name)) return; // 内置引擎不可删（按钮也不渲染，双保险）
    // 至少保留一个启用的引擎，保证「搜索」按钮始终可用（与停用守卫一致）
    if (eng.enabled && settings.searchEngines.filter((x) => x.enabled).length <= 1) {
      toast(t("search.keepOne"), "err");
      return;
    }
    const rest = settings.searchEngines.filter((_, i) => i !== idx);
    // 删除的是默认引擎：默认顺延到首个启用引擎
    const defaultSearch =
      settings.defaultSearch === eng.name
        ? (rest.find((x) => x.enabled)?.name ?? "")
        : settings.defaultSearch;
    patch({ searchEngines: rest, defaultSearch });
  };

  const onEngineGripDown = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setEngDragId(id);
    const onMove = (ev: MouseEvent) => {
      let hit: string | null = null;
      engRowEls.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) hit = key;
      });
      engOverRef.current = hit;
      setEngOverId(hit);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = engOverRef.current;
      setEngDragId(null);
      setEngOverId(null);
      engOverRef.current = null;
      if (!settings || !target || target === id) return;
      const order = settings.searchEngines.map((x) => x.name);
      const from = order.indexOf(id);
      const to = order.indexOf(target);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, id);
      const byName = new Map(settings.searchEngines.map((x) => [x.name, x]));
      patchEngines(order.map((n) => byName.get(n)).filter((x): x is SearchEngine => !!x));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
          <>
            <h1>{t("search.title")}</h1>
            <p className="page-hint">
              {t("search.hint", { qq: "{q}" })}
            </p>
            <div className="card">
              {settings.searchEngines.map((eng, idx) => (
                <div
                  key={eng.name}
                  ref={(el) => {
                    if (el) engRowEls.current.set(eng.name, el);
                    else engRowEls.current.delete(eng.name);
                  }}
                  className={`eng-row ${engDragId === eng.name ? "dragging" : ""} ${
                    engOverId === eng.name && engDragId && engDragId !== eng.name ? "drop-target" : ""
                  }`}
                >
                  <span
                    className="grip"
                    title={t("common.dragToSort")}
                    onMouseDown={(e) => onEngineGripDown(e, eng.name)}
                  >
                    <GripVertical size={13} strokeWidth={1.75} />
                  </span>
                  <input
                    className="eng-name"
                    value={nameEdits[eng.name] ?? engineDisplayName(eng.name)}
                    onFocus={() =>
                      setNameEdits((m) => ({ ...m, [eng.name]: engineDisplayName(eng.name) }))
                    }
                    onChange={(e) =>
                      setNameEdits((m) => ({ ...m, [eng.name]: e.target.value }))
                    }
                    onBlur={() => {
                      const v = nameEdits[eng.name];
                      setNameEdits((m) => {
                        const n = { ...m };
                        delete n[eng.name];
                        return n;
                      });
                      if (v !== undefined && v.trim() && v !== eng.name && v !== engineDisplayName(eng.name)) {
                        updateEngine(idx, { name: v });
                      }
                    }}
                  />
                  <input
                    className="eng-url"
                    value={eng.url}
                    onChange={(e) => updateEngine(idx, { url: e.target.value })}
                  />
                  <label
                    className="radio sm"
                    title={eng.enabled ? t("search.setDefaultTitle") : t("common.setDefaultDisabled")}
                  >
                    <input
                      type="radio"
                      name="defaultEngine"
                      checked={settings.defaultSearch === eng.name}
                      disabled={!eng.enabled}
                      onChange={() => patch({ defaultSearch: eng.name })}
                    />
                    {t("common.default")}
                  </label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={eng.enabled}
                      onChange={(e) => updateEngine(idx, { enabled: e.target.checked })}
                    />
                    <span className="knob" />
                  </label>
                  {/* 仅自定义引擎可删除；内置引擎为系统默认，只可停用/排序 */}
                  {!BUILTIN_ENGINES.has(eng.name) && (
                    <button
                      className="row-del"
                      title={t("search.delEngineTitle")}
                      aria-label={t("search.delEngineTitle")}
                      onClick={() => removeEngine(idx)}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              ))}

              <div className="eng-add">
                {ENGINE_PRESETS.filter(
                  ([n]) => !settings.searchEngines.some((e) => e.name === n),
                ).map(([n, u]) => (
                  <button key={n} className="btn sm" onClick={() => addEngine(n, u)}>
                    ＋ {n}
                  </button>
                ))}
                <button className="btn sm" onClick={() => addEngine(t("search.addCustom"), "https://")}>
                  ＋ {t("search.addCustom")}
                </button>
              </div>
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? t("common.saved") : t("common.saveChanges")}
              </button>
            </div>
    </>
  );
}
