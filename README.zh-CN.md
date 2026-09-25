<div align="center">

<img src="app-icon.png" width="100" alt="拾趣应用图标" />

# 拾趣 (Magpie)

**划词拾趣，阅有所得** —— 鼠标触发的第一文本源入口枢纽

屏幕上任何文字，鼠标一指：划词或框选，动作即时给出结果，就地处理、就地落地。

*得于阅，存于思*

[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-black)](#)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange?logo=rust)](#)
[![Tauri](https://img.shields.io/badge/Tauri-2-yellow?logo=tauri)](#)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[简体中文](./README.zh-CN.md) | [English](./README.md)

</div>

---

## 简介

**拾趣 (Magpie)** 是鼠标触发的第一文本源入口枢纽。在 macOS 的任何应用里选中文字或框选屏幕，浮动条即时提供翻译、解释、总结等动作，全程流式输出。区别于纯划词工具，拾趣以「划词 + 识图」双管线覆盖一切可见文字——零成本捕获（无障碍 API 优先，兼容模式兜底且自动还原剪贴板）+ 带上下文理解；模型 BYOK 不锁定，下游接入用户自选的专业应用，**接入而非自建**。

## 截图

![拾趣核心体验：划词弹出浮动条，流式输出结果](docs/images/hero.png)

![主窗口 · 模型设置页](docs/images/settings.png)

<p align="center">
  <img src="docs/images/settings_trans.png" width="49%" alt="主窗口 · 翻译设置" />
  <img src="docs/images/settings_search.png" width="49%" alt="主窗口 · 搜索设置" />
</p>


## 功能

- **全局划词** — 在任意应用中选中文字即可触发，拖选或双击均可，同一选区不重复弹出
- **浮动条** — 跟随鼠标上方弹出（居中对齐光标）、自动防出屏、不抢焦点，支持明暗主题；松手到弹出约 80ms
- **11 个动作** — 翻译 / 解释 / 总结（AI 生成、流式输出）+ 复制 / 搜索 / 打开链接 / 写邮件 / 复制验证码 / 复制号码 + 加入日历 / 打开地图，顺序与开关可在设置页调整
- **上下文智能动作** — 自动识别选中文本中的链接、邮箱、验证码、电话号码、日期、地点：单个实体一键直达（打开 / 写邮件 / 复制 / 加日历 / 地图），多个实体进面板分组批量操作，普通文本不会误弹
- **框选识图** — 快捷键 / 托盘框选 → Vision OCR（独立子进程隔离，崩溃不伤主应用）→ 一步式识图翻译 / 解释 / 总结；钉图（Snipaste 式）可循环回 OCR
- **结果窗** — AI 结果与识别文本开在独立常驻窗口：钉住、拖动、记忆位置与尺寸，Esc / ⌘P / ⌘W 键盘闭环
- **自定义 AI 动作** — 名称 + 提示词 + lucide 图标即成胶囊按钮（上限 10 个，与内置动作同池排序），编辑 / 试跑 / 删除在一个弹窗内闭环
- **权限独立页** — 辅助功能 / 输入监控 / 取词健康自检集中一处，未授权时一键引导开启
- **三种翻译通道** — AI 翻译（大模型）、百度翻译、DeepL；单击直达默认服务，展开列表切换
- **自定义搜索引擎** — 内置百度 AI / 百度 / Google AI / Google / 必应 / GitHub，支持任意 `{q}` 模板引擎
- **BYOK** — 自带 API Key，预设 DeepSeek，兼容任意 OpenAI 协议端点（base_url + key + model 自由填写）；翻译 / 解释 / 总结的提示词可在设置页自定义
- **菜单栏常驻** — 默认隐藏 Dock 图标，关闭主窗口仅隐藏，捕获继续工作；GitHub 更新检测（只提示，不自更新）
- **应用黑名单** — 终端、密码管理器等敏感应用内划词不触发；从系统面板选择要屏蔽的应用，系统应用也能可靠屏蔽
- **兼容模式** — 微信、Office 等特殊应用中同样可以划词，且不影响剪贴板原有内容

## 环境要求

- macOS 13+（Apple Silicon）
- Xcode Command Line Tools
- Rust 1.80+
- Node 20+
- pnpm

## 快速开始

```bash
# 克隆并安装依赖
git clone https://github.com/demo007x/Magpie.git
cd Magpie
pnpm install

# 开发运行（自动启动 vite :5173）
pnpm tauri dev
```

1. **辅助功能授权（开发模式）**：`tauri dev` 运行的是未打包二进制，不会自动出现在「辅助功能」列表。请把运行 dev 的**终端 App**（Terminal / iTerm2 / VS Code）加入 系统设置 → 隐私与安全性 → 辅助功能；打包成 .app 后无此问题
2. 在**任意应用**里拖选或双击一段文字 → 浮动条出现
3. 打开主窗口「设置」页配置 Provider（预设 DeepSeek，也可填任意 OpenAI 兼容端点）；「翻译」页可配置百度 / DeepL 密钥
4. 点「翻译 / 解释 / 总结」→ 流式结果

## 常用命令

```bash
pnpm check              # TS 类型检查（tsc --noEmit）
pnpm build              # tsc + vite build → dist/
pnpm tauri dev          # 开发运行
pnpm tauri build        # 打包（打包版需授予辅助功能权限）
cargo check             # Rust 检查（在 src-tauri/ 下执行）
cargo build             # Rust 链接验证
```

## 架构

**设计原则：Rust 管不变的，TS 管多变的。**

```
TS (WebView × 2)                        Rust 核心进程
├─ main (index.html)  设置/自检        ├─ capture/  划词捕获（CGEventTap + AX）
│    └─ invoke: get/save_settings      ├─ floating.rs  浮动条窗口定位/显隐
├─ floating (floating.html) 浮动条     ├─ settings.rs  JSON 配置 + 黑名单
│    └─ 动作注册表(ACTIONS)→prompt     ├─ ai.rs  OpenAI 协议 SSE 哑管道
│    └─ aiChat() → Channel 流          └─ main.rs  setup/托盘/事件分发
```

数据流：CGEventTap(鼠标) → detect 线程(防抖/AX 查询) → 过滤(自身 PID/黑名单/重复) → 事件 `selection://captured` → 浮动条弹出 → 用户点动作 → TS 构造 prompt → Rust 转发 SSE → 流式渲染。

- AI 传输走 Rust 哑管道而非 WebView 直连：规避 BYOK 第三方端点的 CORS 限制；prompt / 动作全部在 TS 层（动作注册表：加动作 = 注册一个对象，Rust 零改动）
- 平台分发已抽象：`capture/` 按 `#[cfg]` 选后端，两后端同一签名，Windows (M2) 实现照此接入

## 隐私与安全

- 默认仅通过无障碍 API 读取选中文本；兼容模式会模拟 ⌘C 取词并自动还原剪贴板
- API Key 明文存于本机 `settings.json`（M2 迁移系统钥匙串），仅发送到你自己配置的 LLM / 翻译端点
- 无遥测、无账号体系

## 路线图

完整、自包含的路线图见 [ROADMAP.md](ROADMAP.md)。当前优先级（M2）：**划词收藏接入**（Notion / Obsidian / flomo / Apple 备忘录，带上下文结构化送达——自定义 AI 动作已于 v0.1.6 交付）、结果窗多轮追问、Windows 版捕获（UIA 后端）、AI 搜索 + 问一问、上下文划词、API Key 迁移系统钥匙串。中期（M3）以「统一动作模型」收敛内置动作 / 自定义动作 / 接入动作 / workflow；远期（M4）提供官方托管模型实现零配置。

> 架构已为这些能力预留接口（`capture/` 平台后端、动作注册表），随里程碑逐步落地。

## 文档

| 文档                                                             | 内容                             |
| ---------------------------------------------------------------- | -------------------------------- |
| [docs/01-产品定位与规划.md](docs/01-产品定位与规划.md)           | 定位、用户分层、产品原则、发展方向、商业化 |
| [docs/02-架构设计.md](docs/02-架构设计.md)                       | 分层架构、数据流、协议、演进路线 |
| [docs/03-模块设计.md](docs/03-模块设计.md)                       | 划词捕获 / 窗口交互 / AI 服务层  |
| [docs/04-技术选型.md](docs/04-技术选型.md)                       | ADR 决策记录                     |
| [docs/05-MVP执行计划.md](docs/05-MVP执行计划.md) | M1 执行历史记录 |

## 参与贡献

欢迎 Issue 与 PR！贡献流程、本地验证标准与工程约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

本项目基于 [MIT](./LICENSE) 许可证发布。
