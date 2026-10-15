# 拾趣 Magpie — macOS / Windows 能力对照与 Windows 解决方案

> **基准**：代码版本 0.1.13（2026-10-14 逐文件核查 `#[cfg]` 门控得出，非运行实测——Windows 编译验证依赖 MSVC，见 §七）。
> **图例**：✅ 可用 ｜ ⚠️ 可用但降级 / 代码就绪但触发链不可达 ｜ ❌ 缺失 ｜ 🔧 小修即复 ｜ N/A 不适用（Windows 侧更简单）
>
> **一句话结论**：约 80% 能力已跨平台可用或纯修复即复；真正需要研发的是三块——**划词捕获后端**（最大，周级）、**OCR**（天级）、**日期实体解析**（小量级）；唯一「暂无满意方案」的是**地名实体识别**（建议降级）。无硬阻塞。

---

## 一、总对照表

| # | 能力（README「功能」清单） | macOS 实现 | Windows 现状 | Windows 解决方案 | 状态 |
|---|---|---|---|---|---|
| 1 | 全局划词（拖选/双击触发） | CGEventTap + AX 查询 + 手势误判闸门（`capture/macos.rs`，1891 行） | ✅ **完成**：`capture/windows.rs`（uiautomation-rs + WH_MOUSE_LL/WH_KEYBOARD_LL 系统钩子）——静音/自身/表面/应答证据四道闸门 v1，拖选+双击手势，进程路径黑名单匹配；实测记事本（XAML 容器表面）与 Chromium 系浏览器划选均捕获成功，浮动条 31ms 弹出 | 已按 §三.1 方案实现（uiautomation-rs 为成熟开源封装，钩子用系统能力） | ✅ 完成 |
| 2 | 浮动条（跟随鼠标、防出屏、亮暗主题） | Tauri 窗口层（跨平台）+ macOS 原生增强 | ✅ **完成**：随 #1 恢复，实测划选后浮动条 31ms 内弹出（跨平台窗口层无需额外开发） | 无需额外开发 | ✅ 完成 |
| 3 | 浮动条不抢焦点 | `orderFrontRegardless`（`floating.rs` macos_glue） | ✅ **完成**：浮动层（floating/ocr/toast）`set_focusable(false)`（即 WS_EX_NOACTIVATE），划选后目标应用保持焦点与选区高亮；snap/pin 需键盘交互不受影响 | 体感待日常使用确认 | ✅ 完成 |
| 4 | AI 动作（翻译/解释/总结，流式） | `ai.rs` reqwest SSE 哑管道（无平台代码） | 可用 | 无需（纯协议转发） | ✅ |
| 5 | 实体识别：URL/邮箱/验证码/电话 | TS 正则（`src/shared/textContext.ts`） | 可用 | 无需（纯前端正则） | ✅ |
| 6 | 实体识别：日期 | NSDataDetector 手写 FFI（`entities.rs` darwin 模块） | ✅ **完成**：本地规则层（中英文正则 + chrono 本地时区，日期/时间相邻自动合并），13 项单测全过；OCR/划词文本含日期时面板自动出现「加入日历」（前端渲染为跨平台 TS 逻辑） | 已按 §三.3 推荐方案实现 | ✅ 完成 |
| 7 | 实体识别：地点 | NLTagger 地名 NER | ✅ **完成（按「无能力不显示」处理）**：识别返回空（前端优雅降级）；设置页「打开地图」开关已按 `IS_MAC` 门控隐藏（Windows 无地名识别，入口不存在） | 暂无满意方案，降级不提供，详见 §四 | ✅ 完成 |
| 8 | 加入日历（.ics 预填） | `open` 打开 .ics | **已有 Windows 分支**（`cmd /C start`，`entities.rs:62`） | 无需；效果依赖用户装有 Outlook 等日历应用并关联 .ics（Windows 无内置日历） | ✅ |
| 9 | 打开链接 / 搜索 / 写邮件 / 打开地图 | `open_url` → `open` | **已有 Windows 分支**（`main.rs:361`） | 无需 | ✅ |
| 10 | 框选识图（OCR） | `screencapture -i` 框选 + Vision 识别（`ocr_helper` 子进程隔离） | ✅ **完成**：遮罩框选窗（snap.html，Esc 取消/误触保护/拖拽变暗）+ helper 子进程 GDI BitBlt 截屏 + `Windows.Media.Ocr` 识别（中英文实测通过） | 已按 §三.2 方案实现（2026-10-14 端到端实测：全局快捷键 → 拖拽选区 → 识别 401 字符 → 动作面板） | ✅ 完成 |
| 11 | 文件选图取字 | rfd 文件对话框 + `ocr_helper` | 链路各环节已验证（对话框打开/格式过滤/路径输入/识别引擎），仅剩对话框「打开」提交未自动化确认 | 同 #10 识别栈 | 🔧 待人工点一步确认 |
| 12 | 钉图（Snipaste 式） | `pin.rs`：纯 Tauri + arboard，无平台门控 | 代码就绪，OCR 链路已通（面板入口待人工点一次确认） | 随 #10 恢复 | ⚠️ |
| 13 | 结果窗（钉住/拖动/记忆位置尺寸） | `floating.rs` 窗口管理层（跨平台，含非 macOS 回退） | ✅ **完成**：结果窗随 OCR/划词链路实测（面板出现即有完整内容），窗口管理层跨平台无需额外开发 | 随 #1 恢复 | ✅ 完成 |
| 14 | 自定义 AI 动作（上限 10 个） | TS 动作注册表（`src/shared/actions.ts`），Rust 零改动 | 可用 | 无需 | ✅ |
| 15 | 三种翻译通道（AI/百度/DeepL） | TS 层 + `ai.rs` | 可用 | 无需 | ✅ |
| 16 | 自定义搜索引擎（`{q}` 模板） | TS 层 | 可用 | 无需 | ✅ |
| 17 | BYOK（任意 OpenAI 协议端点） | `settings.json` 明文存 Key（ADR-07） | 可用 | 无需。注：M2 计划迁 keyring，Windows 对位 = Windows 凭据管理器（`keyring` crate 跨平台覆盖） | ✅ |
| 18 | 权限独立页 / 自检 | TCC：辅助功能/输入监控/屏幕录制 | ✅ **完成（按「无能力不显示」处理）**：Windows 无 TCC，权限导航项已整体隐藏（`IS_MAC` 门控），stub 探针语义恒通过 | N/A，整条权限引导流程消失，比 macOS 简单 | ✅ 完成 |
| 19 | 菜单栏常驻 / Dock 图标隐藏 | `ActivationPolicy.Accessory` | ✅ **完成**：floating/ocr/toast 配置即 `skipTaskbar: true`（本就不占任务栏），托盘常驻形态一致 | 无需额外开发 | ✅ 完成 |
| 20 | 应用黑名单（含系统应用可靠屏蔽） | `settings::is_blacklisted` 按 app 路径 + bundle id 匹配（跨平台逻辑） | ✅ **已实现**（exe/lnk 选择器 + 进程路径匹配；划词后黑名单即生效）——待人工点一次选择器确认交互 | rfd `.exe/.lnk` 过滤器，exe 文件名即标识 | ✅ 完成 |
| 21 | 兼容模式（微信/Office 等 ⌘C 兜底） | CGEvent 模拟 ⌘C + 剪贴板快照自动还原 + 应答证据闸门 | 未实现（UIA 已覆盖主流场景，此为兜底增强） | Ctrl+C 模拟对等——本是 Windows 划词工具的主流做法；坑与 macOS 同构（资源管理器复制文件、编辑器空选区复制整行），闸门体系复用，详见 §三.1 | ⏳ 待做 |
| 22 | 识图全局快捷键 | tauri-plugin-global-shortcut | 可用（触发后 OCR 环节失败，有错误提示不崩溃） | 随 #10 | ✅ |
| 23 | 开机自启 | autostart 插件（LaunchAgent） | 可用（插件在 Windows 走注册表 Run 键） | 无需 | ✅ |
| 24 | 更新检测（GitHub Releases，24h 节流） | `update.rs` 纯 HTTP | 可用 | 无需 | ✅ |
| 25 | 外观亮 / 暗 / 跟随系统 | 原生窗口主题 + CSS 变量双轨 | 可用（`settings.rs` 仅 Dock 策略一处门控） | 无需 | ✅ |
| 26 | 托盘常驻 + 右键菜单 | tray-icon（跨平台） | ✅ **已实现**：托盘正常 + 菜单快捷键已按平台显示（`Ctrl+Shift+O` 原文）——菜单最终外观待人工瞄一眼 | `main.rs::shortcut_display` 平台分叉（与前端 `displayShortcut` 同映射） | ✅ 完成 |
| 27 | 中文识别模型预热（macOS 26 按需资源） | 启动后台跑一次微型 OCR | N/A | N/A。Windows.Media.Ocr 语言包机制不同；可检测 `AvailableRecognizerLanguages`，缺中文包时 toast 引导安装 | N/A |
| 28 | 全局 toast 轻提示 | `toast.rs` 跨平台 + macOS 滑入动画 | ✅ **完成**：Windows 出场淡入（CSS）+ 零出血修复（`TOAST_PAD=0` + stage padding 0，卡片铺满窗口——同结果窗的透明圈处理）；窗口级滑入是 macOS 原生能力 | CSS 动画零逻辑分支 | ✅ 完成 |
| 29 | 弹出层原生圆角 | NSWindow 图层 cornerRadius | ✅ **完成**：Windows 注入 DWM 圆角属性（Win11 22H2+ 生效，系统约 8px 圆角）；Win10 上属性调用失败自动维持 CSS 圆角回退，行为不变 | `floating.rs` Windows 分支 | ✅ 完成 |
| 30 | Obsidian 收藏直写 | `obsidian.rs` 纯文件操作 | ✅ **已实现**（rfd `pick_folder()` 全平台一致，门控已删）——待人工点一次目录选择器确认交互 | 纯修复，无技术风险 | ✅ 完成 |

---

## 二、已可直接可用，无需任何开发

AI 管道全家桶（#4/14/15/16/17）、纯 TS 实体（#5）、.ics 与 URL 动作（#8/9）、自启/更新/外观（#23/24/25）、权限页（#18，Windows 无 TCC 反而更简单）。

这些模块的共同特征：**没有一行平台分支代码**，或分支早已双平台写好（`open_url`、`open_in_calendar`）。

## 三、缺失但有成熟 Windows 方案（M2 主体工作）

### 3.1 划词捕获（最大缺口，周级 + 专项 spike）

macOS 侧结构：`CGEventTap`（鼠标事件）→ 防抖 detect 线程（AX 查询）→ 手势误判闸门（起点表面分类 + 应答角色/锚定/差分证据，docs/03 A.3.3）→ `spawn_worker` 过滤 → emit。Windows 对位：

| macOS 组件 | Windows 方案 | 说明 |
|---|---|---|
| CGEventTap | `SetWindowsHookEx(WH_MOUSE_LL)` | 低级鼠标钩子，进程内收全局鼠标事件；同一 `start(tx, debounce_ms)` 签名接入（`capture/mod.rs` 分发已就位，只写 `capture/windows.rs`） |
| AX `AXSelectedText` 查询 | UI Automation：mouseup 后 `ElementFromPoint` → `ITextPattern::GetSelection()` → `GetText()`；或订阅 `TextSelectionChanged` / `FocusChanged` 事件驱动 | UIA 是 Windows 生态划词的标准做法（Lister/uTools/Quicker 同路线） |
| bundle id / app 路径 | `WindowFromPoint` → `GetWindowThreadProcessId` → `QueryFullProcessImageName` | exe 路径填 `app` 字段；`bid` 留空（黑名单匹配逻辑已兼容空 bid 的路径匹配） |
| 菜单栏/Dock 坐标系 | Per-Monitor DPI Aware V2（`GetDpiForMonitor` / `WM_DPICHANGED`） | 逻辑坐标换算留在窗口管理层——项目已有此分层（`floating.rs::monitor_rect`） |
| **手势误判闸门** | **架构整体平移，仅换探测原语** | UIA `GetSelection` 与 AX 同为状态查询，同样的"遗留选区替手势背书"病；A.3.3 体系直接适用：表面分类从 AX Role 换 Win32 窗口类名 / UIA `ControlType`；应答证据可多一路 UIA `TextTextChanged` 事件（比 macOS 更强的差分信号） |
| 兼容模式 ⌘C | Ctrl+C 模拟 + 剪贴板快照还原 | 坑同构：资源管理器 Ctrl+C 复制文件、Electron 编辑器空选区复制整行——闸门体系照常拦截 |

**已知坑（docs/03 A.7 预列，需 spike 验证）**：Chromium 系应用需暴露 UIA 接口（新版默认开，旧版要 `--enable-features`）；提权应用（任务管理器）受 UIPI 屏障不可读（除非本应用也提权）；Win32 Edit / RichEdit / Word / Electron 的 TextPattern 支持参差。

**Rust 生态**：微软官方 `windows` crate（COM/WinRT 全覆盖）或 `uiautomation-rs` 封装 crate。

### 3.2 框选识图 OCR（天级）

| macOS 组件 | Windows 方案 | 说明 |
|---|---|---|
| `screencapture -i` 系统框选 | **自绘**：全屏透明置顶遮罩窗 + 橡皮筋选区（Snipaste/ShareX 模式） | Windows 无系统级交互截图命令；项目已有全屏窗口/定位/拖选基建可复用 |
| 屏幕像素获取 | GDI `BitBlt`（首选，一次性截屏最成熟）或 `Windows.Graphics.Capture`（Win10 1803+） | 按选区从全屏位图裁剪 |
| Vision 文字识别 | **`Windows.Media.Ocr`**（WinRT 内置） | 离线、免费、中文语言包随系统分发；印刷体质量够用，整体略逊 Vision |
| `ocr_helper` 子进程隔离 | **模式原样保留** | 子进程内调 WinRT，ObjC 异常隔离问题在 Windows 不存在（无 ObjC），但崩溃隔离仍值得保留 |
| 屏幕录制权限预检 | N/A | Windows 无 TCC；`ocr.rs` 的 preflight 分支加平台门控即可 |

### 3.3 日期实体（NSDataDetector 对位，小量级）

Windows 无系统级自然语言日期解析。两条路线：

- **推荐：Rust 侧自写规则层**。中英文日期/时间段模式（如「明天下午3点」「next Friday」「10月20日」）正则 + 文法，量可控。优点：零依赖、跨平台，将来可反过来替换 macOS 端，两平台收敛为一套实现（`detect_dates` 命令签名不变，前端零改动）。
- 备选：`Microsoft.Recognizers.Text`（微软官方开源实体识别库，中文日期支持完整）——但是 .NET 生态，需 sidecar 进程或移植，与本项目"热路径零框架"取向（ADR）相悖。

## 四、暂无满意方案（明确说明）

| 能力 | 现状 | 为什么暂无方案 | 处置建议 |
|---|---|---|---|
| **地名实体识别**（NLTagger NER 对位） | Windows 返回空 | Windows 无内置 NER。可行路线均不成比例：ONNX Runtime + 小型 NER 模型 = 引入推理运行时和模型文件（违背零框架取向、包体积暴涨）；在线 NER API = 隐私边界（产品红线：文本不出本地管道，AI 动作除外） | **降级不提供**：UI 按"能力不存在"处理（现状即如此，前端已优雅降级）。M3 的实体扩展若引入轻量本地模型，可一并覆盖 |

其余 macOS 专属项（Dock 策略、TCC 权限流程、模型预热）属"Windows 不需要"，非缺失，见总表 N/A 行。

## 五、纯修复项（被过度门控，半天级，无技术风险）

> ✅ **全部已实现（2026-10-14），编译与单测通过**；#1/#2/#5 的最终确认待 UI 交互验证。

1. ✅ **`pick_app_bundle`**（`app_picker.rs`）：Windows 走 rfd `.exe/.lnk` 过滤器，应用标识 = exe 文件名（`is_blacklisted` 路径子串匹配兼容）；macOS 分支原样保留。
2. ✅ **`pick_vault_dir`**：去掉平台门控，rfd `pick_folder()` 三平台一致。
3. ✅ **`ocr_helper` bin 平台门控**：双平台实现共文件（macOS Vision / Windows Windows.Media.Ocr + BitBlt `--snap-ocr`），`cargo build` 全目标 Windows 通过。
4. ✅ **objc2 系依赖归位**：`objc2`/`core-foundation` 等移入 `[target.'cfg(target_os = "macos")'.dependencies]`，Windows 构建不再编译。
5. ✅ **快捷键显示格式**：托盘菜单（Rust `shortcut_display`）与设置页（前端 `displayShortcut`）两处对齐——Windows 显示 `Ctrl+Shift+O` / `Alt+S` 原文（`+` 连接 + 修饰键规范化 `CmdOrCtrl→Ctrl`），macOS 保持 `⌘⇧O` 符号连写；存储格式不变（Tauri 跨平台格式）。托盘菜单最终外观待人工瞄一眼。
6. ✅ **能力门控（无能力不显示）**：`capture_status` 新增 `captureAvailable` 能力位（macOS=true；Windows 桩=false，捕获后端落地自动翻 true）——前端导航据此显隐：**划词、黑名单**随能力位，**权限**随 `IS_MAC`；通用页「程序坞」节仅 macOS 渲染。Windows 当前侧栏 = 快捷键/模型/提示词/翻译/搜索/Obsidian/通用/关于。

## 六、体验细节对位（非阻塞，随 M2 顺手做）

| macOS 实现 | Windows 对位 | 备注 |
|---|---|---|
| **NSWindow 原生阴影**（浮动条/结果窗的悬浮感，按内容 alpha 形状画影，8px 透明出血即渲染空间） | **CSS 自绘投影**（`html.win` 根类 + `.bar`/`.panel` box-shadow）——tao 的窗口阴影是矩形 DWM 投影，透明窗上不渲染，出血区会显形为「透明边」（2026-10-15 用户实测报告，已修：对齐 toast.css 既有先例；Rust 侧 Windows 下 `set_shadow(false)` 关掉矩形投影）。**macOS 规则零改动**：CSS 仅在 `html.win` 下生效，Rust 仅 `#[cfg(windows)]` | ✅ 完成 |
| `orderFrontRegardless` 不抢焦点显示（浮动条/OCR/钉图共用） | `WS_EX_NOACTIVATE` 扩展样式 + `WM_MOUSEACTIVATE` 返回 `MA_NOACTIVATE` | **红利**：这类窗口天然接收 `WM_MOUSEMOVE`，macOS 的 `setAcceptsMouseMovedEvents`（hover tracking）问题不存在 |
| NSWindow 图层原生圆角（12px） | `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND)` | Win11 22H2+；Win10 回退现状 CSS 圆角（毛刺依旧，可接受） |
| toast 滑入动画（NSAnimationContext ease-out） | 首选：动画搬进 webview 用 CSS 做（窗口瞬显、元素滑入）；次选：16ms 定时器插值 `set_position` | 现状回退已是瞬显，可用 |
| Dock 图标显隐（ActivationPolicy） | `WS_EX_TOOLWINDOW`（不出现在任务栏） | 强化"托盘常驻"形态；纯可选 |
| 中文模型预热 | 检测 `Windows.Media.Ocr.AvailableRecognizerLanguages`，缺中文语言包时 toast 引导系统设置安装 | 语言包缺失时 OCR 会直接失败，值得做引导 |

## 七、工程与编译注意事项（Windows 构建）

- **工具链要求**：MSVC（`aarch64-pc-windows-msvc` 已装 rustup）+ **VS Build Tools 的 C++ 工作负载**（含 Windows SDK 与 MSVC ARM64 组件）——**本机已安装**（2026-10-14，`cargo build` 全目标通过，项目首次 Windows 编译成功）。
- **tauri-codegen 版本钉扎**：codegen 2.7.x 在 Windows 目标会生成对 `tauri::image::default_window_icon_from_app_icon_resource` 的调用，而 tauri 2.11.5 尚无此函数（上游版本偏差）——已在 Cargo.lock 钉 `tauri-codegen = 2.6.3`（`cargo update -p tauri-codegen --precise 2.6.3`），升级 tauri 时可移除。
- **windows crate 0.62 两个破坏性变更**：① 命名空间层级化（`windows::Media::Ocr`，不再是 `windows::Media_Ocr`）；② WinRT 异步对象迁至 `windows-future` crate（`IAsyncOperation`，用固有方法 `.join()` 阻塞等待）。标准 `regex` crate 不支持 lookaround（`(?<!\d)` 会静默编译失败——写正则时注意）。
- **状态管理时序**：Windows 上 webview 加载快于 Tauri `setup()` 完成，前端就绪即 invoke——共享状态必须在 Builder 链上 `.manage()`（窗口创建前），不能等 setup 尾部（实测 `FloatingState` 晚 manage 即 panic）。
- **vite dev 监视排除**：`server.watch.ignored` 必须排除 `src-tauri/target/**`——cargo 链接期间 `magpie.exe` 被锁，chokidar EBUSY 会崩掉整个 dev 进程。
- **vendor/wry 补丁**：`[patch.crates-io]` 指向 `../vendor/wry`（wry#1752 修复），补丁代码跨平台，Windows 构建同样生效、无已知副作用。勿清理 vendor 目录。
- **tauri features**：`macos-private-api` 在 Windows 上被忽略，无害；`tray-icon` / `global-shortcut` / `autostart` 均有 Windows 后端。
- **Win10 兼容清单（2026-10-14 全量核对）**：已用 API 全部落在 Win10 范围内——BitBlt/CAPTUREBLT（XP+）、`GetDpiForMonitor`（Win8.1+）、`SetProcessDpiAwarenessContext`（Win10 1703+）、`Windows.Media.Ocr`（Win10 10240+）、`WH_MOUSE_LL`/UIA COM（远古）、`WS_EX_NOACTIVATE`（2000+）。唯一 Win11 专属是 DWM 圆角（DWMWA_WINDOW_CORNER_PREFERENCE，22H2+）：实现时必须失败回退（Win10 上 DwmSetWindowAttribute 对未知属性返回错误即降级 CSS 圆角，不崩）。运行时前置：Win10 需 WebView2 Evergreen Runtime（Tauri 自带缺失时下载引导）。
- **验证盲区**：`cargo check` 通过 ≠ 可链接（`#[link(kind="framework")]`、未门控的 extern 声明只在链接期爆——实测 toast.rs / ocr.rs / app_picker.rs 三处）。Windows 侧常规验证 = `pnpm check` + `pnpm build` + `cargo check` + **`cargo build`（全目标）** + `cargo test`。

## 八、工作量总览（建议顺序）

| 优先级 | 工作包 | 量级 | 状态 |
|---|---|---|---|
| 0 | §五 纯修复项 ×5 + 能力门控 | 半天 | ✅ 完成（2026-10-14） |
| 1 | OCR 后端（§3.2：遮罩框选 + BitBlt + Windows.Media.Ocr，含 ocr_helper 改造） | 天级 | ✅ 完成（端到端实测通过） |
| 1.5 | 日期规则层（§3.3） | 小量级 | ✅ 完成（单测 13 项全过） |
| 2 | 捕获后端（§3.1：WH_MOUSE_LL + UIA 选区 + 闸门 v1） | spike 数天 → 周级 | ✅ 完成（2026-10-15 端到端实测：记事本/Chromium 浏览器划选 → 浮动条 31ms 弹出；winVmac #1/#2/#13 已标记） |
| 4 | 体验细节（§六：不抢焦点、圆角、任务栏、语言包引导） | 零散 | 部分完成（投影已做） |
| — | 地名 NER | 不做 | 见 §四 |

---

*本文档为 Windows 移植评估快照，随 M2 推进应将 §3.1/3.2 细化回填 docs/03 A.7 并按 AGENTS.md 纪律同步 docs/02 §3.2 契约表。*
