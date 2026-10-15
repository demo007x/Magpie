# 拾趣官网 (web/)

单页营销站，与主应用完全独立：不共用主项目任何代码与依赖，产物 `web/dist/` 单独部署到任意静态托管。

## 命令

```bash
pnpm install        # 装依赖（见下方 pnpm 版本说明）
pnpm dev            # 本地开发 http://localhost:5173
pnpm check          # 仅类型检查
pnpm build          # tsc --noEmit + vite build + 预渲染双语言页 → dist/
pnpm preview        # 预览构建产物
```

**pnpm 版本**：本目录有 `pnpm-workspace.yaml`，把自己声明为独立工作区根。不要删——没有它时 pnpm 会向上级目录找到主项目的 lockfile，把依赖装进仓库根的 `node_modules/.pnpm` 并改写根 `pnpm-lock.yaml`。装依赖请用 pnpm 12.x（与本机 store 一致，版本不符报 `ERR_PNPM_UNEXPECTED_STORE`）。本机现用 homebrew 的 `/opt/homebrew/bin/pnpm`（12.4.2，即 PATH 默认）。

## 部署

**相对路径部署：同一份 `dist/` 可直接发布到任意路径**——GitHub Pages 项目站（`…/Magpie/`）、自建服务器根目录或任意子目录。`/en/` 子页的资源前缀由两处协同：客户端按语言算（`i18n.tsx` 的 `assetBase`），静态 HTML 由预渲染脚本改写（`scripts/prerender.mjs`）。

SEO 元信息（canonical / hreflang / og:url / og:image / sitemap）按正式域名写死为 `https://fm126.top/`；换正式域名时改 `index.html`、`scripts/prerender.mjs`、`public/robots.txt`、`public/sitemap.xml`。下载与更新记录链接指向 `https://github.com/demo007x/Magpie`（`src/data.ts` 的 `REPO` / `RELEASES`），发布新版本无需改代码——页面不写死版本号，具体版本以 Releases 为准。

## 双语言

- **URL 即语言**：`/` = 中文（`lang="zh-CN"`），`/en/` = 英文。语言不再是 localStorage/浏览器语言推断——URL 是唯一事实来源，直接访问哪个路径就渲染哪种语言。
- **预渲染**：`pnpm build` 末尾跑 `scripts/prerender.mjs`，用 `renderToStaticMarkup` 把两份字典各渲染成含完整正文的静态 HTML（爬虫、禁 JS、社交卡片直接读全文），客户端 `hydrateRoot` 接管交互。往页面加内容时**不需要**为预渲染做任何事；只有新加「渲染期就读浏览器状态」的代码才会破坏它（水合会不一致），保持渲染纯由 props/URL 决定即可。
- **语言按钮 = 真 URL + 软切换**（`Nav.tsx`）：`<a href>` 始终指向对方语言的真地址（爬虫/中键/禁 JS 可达），普通左键点击被拦截为原地换字典 + `pushState`（带当前区块锚点），不刷新、滚动位置不丢；前进/后退由 popstate 按路径恢复语言。
- 新增文案改 `src/i18n.tsx` 的 zh / en 两份字典；页面级 `<head>` 元信息（lang/title/description/ogLocale）在同文件 `META` 里，供预渲染与运行时共用。

## 配色与主题

深色为默认（磨砂黑：底 `#0f1012`，卡片只比底亮一档，靠内描边 + 投影分离），`@media (prefers-color-scheme: light)` 翻成磨砂白，跟随系统，站点内不做手动开关。**注意：跟随系统意味着 macOS 处于浅色外观时看不到深色版**，要判断深色配色请把系统外观切到深色。

**唯一色板在 `src/styles.css` 的 `@theme` 里**：组件只写 token 工具类（`bg-panel` / `text-mute-soft` / `border-accent-line` / `bg-fill` …），不出现 `rgba()`、`#hex`、`bg-white/N` 这类把"深底白字"写死的工具类——加了也不会翻色。token 名是自拟的，走 Tailwind v4 的 `--color-*` 命名空间。

三条容易踩的：

- **投影不走 `@theme`**：Tailwind v4 把 `--shadow-*` 编译成静态 `--tw-shadow` 值，`@media` 里覆盖同名变量不生效（结果亮色主题拿到深色的近黑投影）。改为 `:root { --panel-shadow }` + 普通类 `.lift { box-shadow: var(--panel-shadow) }`，两主题各自覆盖，卡片统一挂 `.lift`。
- **mock 区恒为深色**（`.mock-card`）：它是 macOS 深色外观下那层浮窗的复刻，亮色页面里保持深色才读得出是"截图里的产品"。做法是在 `.mock-card` 上重声明**全套** token——底/面（`bg` `elev` `panel` `card`）也在内，因为 mock 里有 `bg-ink text-bg` 的主按钮和 `bg-bg` 的窗口内容区，漏一项就会出现"浅字压浅底"看不见。新增 mock 时把这套重声明抄上，utilities 都读 `var()`，所以 mock 内的 `text-ink/90`、`border-line` 自动按深色算。**另一侧的规矩：`.mock-pill` / `.mock-card` 只能出现在 mock 内部**（`grep '.mock-pill' | 不在 .mock-card 里` 即为泄漏）——它们是恒深色构造，放进真卡片就在亮色主题变成黑块。
- `panel` 是卡片静止态、`card` 是 hover 态（深色下 hover 更亮、亮色下更暗），两者分别在各主题里定义，不要合并成一个。

小字对比度靠 `mute-soft`（11–13px 注脚，两主题均 ≥5:1）而不是 `mute/70`；`mute-faint` 只给拖拽把手、圆点这类非文本装饰件。

## 内容

站点文案的唯一来源是 `src/data.ts`（特性、FAQ、步骤、下载说明）。**只写已实现的能力**：存进笔记应用等未上线的东西在「应用接入」卡里明确标 `开发中`；不承诺各平台最低版本，不谎称已签名公证（当前构建未签名，macOS 安装说明是右键 → 打开，Windows 是 SmartScreen「仍要运行」）。macOS 与 Windows 安装包都在 GitHub Releases（macOS 通用 .dmg，Windows x64 安装包）；Windows 侧文案（下载卡 / 安装步骤 / FAQ）随应用能力演进同步更新。

**语域是客观产品说明**：陈述句、无人称、不写修辞（口号式排比、比喻、感叹号一律不用）、不写实现机制（子进程/管线/AX/协议兼容等）。术语按用户视角翻译，站点里浮层统一叫「浮动条」（app 内也叫胶囊）。

动效基于 `motion`：`Reveal` 是通用的滚动渐入（`viewport={{ once: true }}`），首屏的胶囊演示是独立状态机，两者都读 `useReducedMotion()`，在系统「减弱动态效果」下直接呈现终态。

## 界面截图

`Gallery`（`#gallery`，导航项「界面」）展示真机截图，清单在 `src/i18n.tsx` 的 `gallery.shots`（zh / en 两份都要改）：文件名、说明、**真实像素尺寸**（写进 `width`/`height` 属性占位，加载时不跳动）与跨列 `cls`。图片放 `public/shots/`，`<img>` 用**相对路径** `shots/x.png`（`base: "./"`，绝对路径在子路径部署下会 404）。文件缺失时不显示破图：`.shot[data-missing]` 会在版面上写出待补的路径。

- **两个主题共用一套图**：截图自带浅色窗口底 + 圆角投影，直接落在页面底色上（深色页面上读作「相纸里的照片」，不随主题翻色）。截图本身是产品的浅色外观，与 `.mock-card`（恒深色）是两套口径——站点里 mock 与真图并存时这个差异会被看见，改动前先确认统一到哪一侧。
- 排版为左右交替的全宽行（无底色卡，文字裸排在页面底色上）：列宽按截图宽高分档——宽横 ≥1.8 文：图 = 5:7、中横 1.2–1.8 = 5:6、近方 <1.2 = 4:7；截图按原比例渲染（横图最高 420px、近方 520px，圆角投影、无衬底），奇偶行左右交替；移动端退化为上文下图。不裁切，新增截图无需考虑与邻卡搭配。
- 点击截图打开页内灯箱看大图：Esc / 点幕布 / 右上 × 关闭，←/→ 方向键或两侧箭头切换上一张下一张；灯箱为固定深色幕布（`.lightbox*`，两个主题一致）
- 交付流程：PNG 原图进 `public/shots/` 作为源文件，再压出页面实际使用的 webp 版本（`<picture>` 优先 webp，PNG 兜底）：`cwebp -q 82 -m 6 x.png -o x.webp`，本机无 cwebp 时用 `pnpm dlx sharp-cli -i x.png -o x.webp -f webp --quality 82`（sips 不支持 webp 编码）。
- 截图内容自查：不出现真实 API key、账号邮箱、个人文件路径与个人文档；演示文本用中立内容。
