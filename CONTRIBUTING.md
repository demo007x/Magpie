# 参与贡献

感谢关注拾趣 (Magpie)！无论是报缺陷、提建议、改文档还是写代码，都欢迎。

拾趣是鼠标触发的第一文本源入口枢纽：屏幕上任何文字（划词 / 识图），动作即时给出结果，就地处理、就地落地。产品定位与边界见 [docs/01-产品定位与规划](docs/01-产品定位与规划.md)，路线图见 [ROADMAP.md](ROADMAP.md)。

## 行为准则

友善、尊重、对事不对人。争论方案时不否定人；文档与讨论使用简体中文（与项目文档语言一致）。

## 提问与建议

- **功能建议**：先看 [ROADMAP.md](ROADMAP.md) 与 [docs/01 §4 产品原则](docs/01-产品定位与规划.md)——拾趣刻意不做程序员向功能（报错 / 代码解释）、不自建下游知识库（接入而非自建），与定位冲突的建议会先被否掉，请勿见怪。
- **使用问题**：先读 [README](README.zh-CN.md) 的「快速开始」与主窗口「权限」自检页；大部分划词问题（某应用取不到词、浮动条不弹）都出在系统授权上。

## 报告缺陷

Issue 请包含：

1. **系统与版本**：macOS 版本、拾趣版本（设置 › 关于）、来源（Release / 源码构建）；
2. **触发应用**：在哪个应用里划词 / 识图（这是捕获类缺陷最关键的线索）；
3. **复现步骤**：拖选还是双击、选中文本的语言与内容样例；
4. **期望与实际**：浮动条没弹？结果错误？还是直接崩了；
5. **授权状态**：主窗口「权限」页的自检结果（辅助功能 / 输入监控）。

崩溃类问题请附上控制台（Console.app）中该进程的崩溃日志。

## 开发环境

```bash
# 前置：macOS 13+，Xcode Command Line Tools，Rust 1.80+，Node 20+，pnpm
git clone https://github.com/demo007x/Magpie.git
cd Magpie
pnpm install
pnpm tauri dev      # 开发运行（自动启动 vite :5173）
```

开发模式授权提醒：`tauri dev` 运行的是未打包二进制，不会自动出现在「辅助功能」列表，需要把**运行 dev 的终端 App**（Terminal / iTerm2 / VS Code）加入 系统设置 → 隐私与安全性 → 辅助功能。

**坑**：`tauri::generate_context!` 编译期读取 `../dist` 与 `src-tauri/icons/`。若 cargo 报缺 icon 或 dist，先跑 `pnpm build` 或 `pnpm tauri icon` 再重试。

## 提交前必须通过的本地验证

项目暂无测试框架（MVP 阶段），验证方式 = 三条命令 + 真机交互：

```bash
pnpm check     # TS 类型检查
cargo check    # Rust 检查（在 src-tauri/ 下执行）
cargo build    # 链接验证（FFI 符号错误只有链接时才暴露）
```

涉及划词捕获、浮动条、OCR 的改动，请用 `pnpm tauri dev` 真机验证：至少覆盖拖选 / 双击、深浅主题两种外观、一个标准应用（Safari）与一个兼容模式应用（微信）。

## 工程约定（红线）

完整约定见 [AGENTS.md](AGENTS.md)，以下是改代码前必须知道的红线，违反会导致链接失败、崩溃或协议不同步：

1. **架构分工：Rust 管不变的，TS 管多变的**。系统层（捕获 / 窗口 / 存储 / SSE 传输）在 Rust；动作、prompt、流式渲染在 TS。不要把 AI 编排逻辑搬进 Rust，也不要在 TS 里碰鼠标钩子。
2. **契约同步**：`src-tauri/src/settings.rs` 与 `src/shared/types.ts` 是同一契约的两面（serde `rename_all=camelCase` + 容器级默认值），改字段两边必须同步；改 Rust↔TS 事件 / 命令协议须同步 [docs/02 §3.2](docs/02-架构设计.md) 的契约表。
3. **kAX\* 常量必须 dlsym**（`capture/macos.rs::ax_consts`）：直接 `extern static` 能过 `cargo check` 但链接必败。别"简化"回 extern。
4. **AppKit 调用只在主线程**：窗口操作从后台线程直接调会 SIGILL，一律经 `run_on_main_thread` 派发。
5. **AI 传输走 Rust 哑管道**（ADR-03）：BYOK 任意第三方端点大概率无 CORS 头，勿改成 WebView 直连。新增动作 = 在 `src/shared/actions.ts` 动作注册表注册一个对象，Rust 零改动。
6. **WKWebView 里没有 JS 对话框**：`alert / confirm / prompt` 是静默空操作。提醒走 `toast()`，确认走 `src/shared/Modal.tsx` 的 `Confirm`。
7. **UI 不用组件库**：浮层原语用 `Modal.tsx`，列表删除钮统一 `.row-del` 样式，别再各写一份遮罩层。
8. **不引入新的密钥落盘点**：API Key 目前明文存 `settings.json`（ADR-07，M2 迁 keyring），设置页已向用户明示。
9. **OCR 隔离在子进程**：框选截图 + Vision 识别都在 `src/bin/ocr_helper.rs`，AppKit/Vision 的崩溃只杀子进程。勿把 OCR 调用挪回主进程。
10. **vendor 目录勿动**：wry 上游崩溃补丁以 vendor 保留（`[patch.crates-io]` 指向 `../vendor/wry`），勿清理。

## 提交 PR

1. 从 `main` 拉出特性分支，命名如 `feat/ocr-batch-actions`、`fix/floating-clip-multi-display`；
2. 一个 PR 聚焦一件事；大重构先开 Issue 讨论方案再动手（涉及架构决策的翻案须先改 [docs/04-技术选型](docs/04-技术选型.md) 的 ADR）；
3. 确保上面的本地验证全部通过，并在 PR 描述里写明验证方式与真机测试的应用；
4. 涉及用户可见行为的改动，同步更新 [CHANGELOG.md](CHANGELOG.md)（Keep a Changelog 格式）与相关 docs 文档；
5. 提交信息用祈使句短行，首行 ≤ 50 字符，正文解释**为什么**（代码里写不了的那部分）。

首次贡献可以从 [good first issue](https://github.com/demo007x/Magpie/labels/good%20first%20issue) 标签开始；文档改进（错别字、步骤过期、翻译）随时欢迎，不必先开 Issue。

## License

提交即表示你同意以 [MIT](LICENSE) 许可证授权你的贡献。
