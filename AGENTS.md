# AGENTS.md

This file provides guidance to AI coding agents (Lingma / Claude Code / Cursor, etc.) when working with code in this repository.

本文件是唯一的 Agent 指南（原 CLAUDE.md 已并入并删除），更新指南只改这里。

## 项目

**拾趣 (Magpie)**：鼠标触发的第一文本源入口枢纽——屏幕上任何文字（划词/识图），即时动作、就地落地。macOS 优先（Windows 为 M2，接口已预留）。Tauri 2 + Rust + React/TS。文档是权威规格：`docs/01-产品定位与规划`、`docs/02-架构设计`、`docs/03-模块设计`，其中 `docs/02 §3.2` 是 Rust↔TS 事件/命令契约表——改协议须同步文档。

## 常用命令

```bash
pnpm install            # 安装前端依赖
pnpm tauri dev          # 开发运行（自动起 vite :5173，需授予辅助功能权限才能划词）
pnpm check              # 仅 TS 类型检查（tsc --noEmit）
pnpm build              # tsc + vite build → dist/
cargo check             # 在 src-tauri/ 下执行
cargo build             # 链接验证（FFI 符号错误只有链接时暴露，cargo check 不够）
pnpm tauri build        # 打包（需 src-tauri/icons/ 齐全，缺失时用 pnpm tauri icon app-icon.png 生成）
pnpm build:mac          # universal-apple-darwin 通用包
```

无测试框架（MVP）；验证方式 = `pnpm check` + `cargo check` + `cargo build`，交互验证走 `pnpm tauri dev` 真机划词。

**坑**：`tauri::generate_context!` 在编译期读取 `../dist` 与 `icons/`。若 cargo 报 icon/dist 缺失，先跑 `pnpm build`（dist）或 `pnpm tauri icon`（图标）再重试。

## 架构：Rust 管不变的，TS 管多变的

前端是多入口 MPA（vite 三入口）：`main`（index.html，设置/自检）、`floating`（floating.html，浮动条/OCR 面板/钉图复用）、`toast`（toast.html，全局轻提示）。

Rust 侧 `src-tauri/src/`：

- `capture/` 划词捕获（最高风险模块）：`#[cfg]` 分发 macos/other 后端，两后端同一 `start(tx, debounce_ms)` 签名；Windows 实现进 `capture/windows.rs` 时照此接入，勿在 worker 层加平台分支。
- `floating.rs` 浮动条窗口定位/尺寸/显隐、`toast.rs` 全局提示、`pin.rs` 钉图窗口（复用 floating.html，按 label 前缀 `pin-` 进入钉图渲染模式）。
- `ocr.rs` + `src/bin/ocr_helper.rs`：框选截图 + Vision 识别**全部隔离在子进程**——AppKit/Vision 的 ObjC 异常或崩溃只杀子进程，主应用不 abort。
- `settings.rs` JSON 配置 + 黑名单、`ai.rs` OpenAI 协议 SSE 哑管道（无 AI 逻辑）、`app_picker.rs` 系统应用选择、`update.rs` GitHub Releases 更新检测、`main.rs` setup/命令注册/事件分发/托盘。

数据流：CGEventTap(鼠标) → detect 线程(防抖/AX 查询) → `capture::spawn_worker` 过滤(自身PID/黑名单/重复) → emit `selection://captured` → TS `show_floating_bar` → 用户点动作 → TS `aiChat`(Channel 流式) → Rust `ai_chat` 转发 SSE。

关键非显性设计（改代码前先懂）：

- **kAX* 常量必须 dlsym**（`capture/macos.rs::ax_consts`）：这些 AX 数据常量不在 SDK tbd 导出表里，直接 `extern static` 能过 check 但链接必败（函数可以用 `ApplicationServices` 伞框架链接，常量不行）。别"简化"回 extern。
- **AI 传输走 Rust 哑管道而非 WebView 直连**（ADR-03）：BYOK 任意第三方端点大概率无 CORS 头；`ai.rs` 只做协议转发，prompt/动作/agent 全部在 TS 层（`src/shared/actions.ts` 动作注册表：加动作 = 注册对象，Rust 零改动）。
- **浮动条的 dismiss 逻辑**：普通单击 → `selection://dismiss`；点击浮动条自身用 `floating::rect_contains`（Rust 侧坐标抑制）避免误关——浮动条窗口不抢焦点，点击它不会改变聚焦进程。
- **浮动条是预建常驻隐藏窗口**（show/hide 而非创建/销毁），定位用鼠标逻辑坐标 + `monitor_bounds` 防出屏钳制（多显示器 DPI 转换都在 `floating.rs`）。
- **settings.rs 与 `src/shared/types.ts` 是同一契约的两面**：serde `rename_all=camelCase` + 容器级 `default`（向前兼容旧配置文件）。改字段两边必须同步。
- **AppKit 调用只在主线程**：窗口操作（如 toast 的 `show_without_activation`）从后台线程直接调会 SIGILL，一律经 `run_on_main_thread` 派发；toast 消息用 `eval` 直调 `window.__toastShow` 而非事件系统（webview listen 注册时序不稳）。
- **手写 ObjC FFI 需谨慎**：`app_picker.rs` 用 rfd 而非裸 NSOpenPanel（ObjC 异常会穿透 Rust FFI 直接 abort）；新增 AppKit 交互优先考虑成熟 crate。
- **wry 上游崩溃补丁以 vendor 目录保留**（wry#1752，nil URL 导致进程 abort）：`src-tauri/Cargo.toml` 的 `[patch.crates-io]` 指向 `../vendor/wry`。勿清理 vendor 目录或该 patch 配置。
- **更新检测只做提示不做自更新**：GitHub 匿名 API 60 次/小时限流，后台检查按 24h 节流且结果落盘（`update.json` 与 settings 同目录）；网络失败一律静默。

## 约定

- 决策记录（为什么不用 Electron/LangChain、为什么无剪贴板等）见 `docs/04-技术选型.md`（ADR），翻案先改 ADR。
- 产品边界：不做程序员向功能（报错/代码解释）；AX 取词不碰剪贴板，仅兼容模式兜底时模拟 ⌘C 且自动还原快照（ADR-05）；捕获失败静默。
- 截屏框选等模态鼠标操作期间须持 `CaptureMuteGuard` 静音捕获管线，防止误触发划词 → AX 查询 → 模态会话内 ObjC 异常。
- API Key 目前明文存 `settings.json`（ADR-07，M2 迁 keyring），设置页已向用户明示——不要在别处引入新的密钥落盘点。
- 文档与 UI 文案用简体中文；代码注释密度向现有文件看齐（各模块头部有大段"为什么"注释，改代码前先读该模块头注释）。
