<div align="center">

<img src="app-icon.png" width="100" alt="Magpie app icon" />

# Magpie (拾趣)

**Understand as you read** — the entry hub for the first text source, triggered by your mouse

Every piece of text on your screen is one mouse gesture away: select or capture it, and actions return results in place — processed where you saw it, landed where you want it.

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black)](#)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange?logo=rust)](#)
[![Tauri](https://img.shields.io/badge/Tauri-2-yellow?logo=tauri)](#)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[简体中文](./README.zh-CN.md) | [English](./README.md)

</div>

---

## Introduction

**Magpie (拾趣)** is a text-selection AI tool: select text in *any* app on macOS or Windows, or capture a region of the screen, and a floating bar appears on the spot — translate, explain and summarize stream in; URLs, phone numbers and dates are extracted in one step; results go straight into Obsidian or a pre-filled calendar event. It covers more than selectable text: content in images, videos and scans can be recognized and handled the same way. Bring your own model service, with no vendor lock-in; downstream, it connects to the apps you already use — **integrate, don't rebuild**.

**Website**: [demo007x.github.io/Magpie](https://demo007x.github.io/Magpie/) — product intro & screenshots

### Why Magpie

We handle a lot of text with the mouse every day, and every kind of text has its own disconnected path:

- A new word or an English paragraph: copy, switch to a translator, switch back, find where you were
- Text in images, videos and scans can't be selected — a screenshot or retyping is the only way to keep it
- A passage you don't follow: copy, open a search box, paste, enter
- A long article you want summarized, and a blank chat box to start from
- URLs, phone numbers and event details scattered through a block of text, copied one by one
- Note-takers reopening the app and hunting for the right file just to save one line

Each step takes seconds, but they all break the same thing: attention. Dozens of app switches, covered windows and rebuilt contexts a day add up to more than lost time — they fragment your train of thought.

Magpie exists to make on-screen text actionable where it is: select to translate, explain or save; capture to recognize; extract information in one step; write results straight into Obsidian. What it replaces is not any one app but the copy → switch → paste → switch-back routine itself, repeated dozens of times a day.

## Screenshots

![Magpie in action: select text anywhere → floating bar → streaming result](docs/images/hero.png)

![Main window · model settings](docs/images/settings.png)

<p align="center">
  <img src="docs/images/settings_trans.png" width="49%" alt="Main window · translate settings" />
  <img src="docs/images/settings_search.png" width="49%" alt="Main window · search settings" />
</p>

## Features

<!-- This section lists CAPABILITIES only: what the product can do, one line each
     (what it is + how to trigger it). Do NOT add: performance numbers ("xx ms"),
     micro-interactions (shortcuts, dismiss behavior), resilience or optimization
     notes (helper-process isolation, caching) — those belong to the CHANGELOG's
     Changed/Fixed entries, or nowhere at all. Update this section only when a
     capability changes; releases do not touch it. -->

- **Global selection capture** — select text in any app to trigger the bar; drag-select or double-click both work
- **Floating bar** — pops above the mouse cursor, auto edge-clamping, never steals focus; light / dark / follow-system themes; native per-card shadows on Windows
- **Eleven actions** — Translate / Explain / Summarize (AI-generated, streamed) + Copy / Search / Open Link / Compose Email / Copy Code / Copy Phone + Add to Calendar / Open in Maps; order and visibility configurable in settings
- **Context-aware actions** — links, emails, verification codes, phone numbers, dates and places in the selected text are detected automatically: a single entity is one click away (open / compose / copy / calendar / maps), multiple entities open a grouped panel for batch operations; with a model service configured, dates and places are understood by the AI in context (date ranges, event titles), and calendar events carry the source link, selected text and invitees
- **Save to Obsidian** — write the selection or OCR result straight into your vault as a daily-note excerpt, a task line or a knowledge card, each with its own template; no Obsidian plugin required
- **Screen OCR** — a custom global hotkey or the tray menu starts a region capture, on-device OCR reads the text, with one-step OCR translate / explain / summarize; Snipaste-style pinned images can loop back into OCR
- **Result window** — AI results and recognized text open in a standalone persistent window that can be pinned, dragged, and remembers position & size, with default-size presets in the appearance settings
- **Custom AI actions** — a name + prompt + icon become capsule buttons (up to 10, ordered with the built-ins), with a try-run preview
- **Dedicated permissions page (macOS)** — Accessibility, Input Monitoring, and a capture health check in one place, with one-click guided authorization; the Windows build needs no permission grants
- **Ten translation channels** — AI translation (LLM) plus nine machine-translation engines: Google, Microsoft, DeepL, Baidu, Youdao, Tencent, Alibaba, Volcengine and Caiyun; click runs the default, the chevron lists them all, and services can be added, paused or reordered anytime
- **Custom search engines** — ships with Baidu AI / Baidu / Google AI / Google / Bing / GitHub; any `{q}` URL template works
- **BYOK model services** — bring your own API key; one-click presets for DeepSeek, Volcengine (Doubao), Zhipu, Kimi, Qwen, Xiaomi MiMo, SiliconFlow, OpenAI, xAI and OpenRouter, plus any OpenAI-compatible endpoint — in both Chat Completions and OpenAI Responses forms; the prompts behind Translate / Explain / Summarize are customizable
- **Tray resident** — lives in the menu bar (macOS) / system tray (Windows); closing the main window just hides it while capture keeps running; GitHub update notifications
- **App blocklist** — selection is disabled inside terminals, password managers, and other sensitive apps; system apps are reliably covered
- **Compatibility mode (macOS)** — text selection also works in WeChat, Office, and similar apps, without disturbing your clipboard contents

## Prerequisites

- macOS 13+ (Apple Silicon or Intel) or Windows 10+ (x64)
- Rust 1.80+ — macOS: Xcode Command Line Tools; Windows: MSVC build tools (Visual Studio or Build Tools)
- Node 20+
- pnpm

## Getting Started

```bash
# Install Rust via rustup if not present (Prerequisites require Rust 1.80+;
# without it `pnpm tauri dev` fails with "No such file or directory" on cargo)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone and install dependencies
git clone https://github.com/demo007x/Magpie.git
cd Magpie
pnpm install

# Run in development mode (starts vite on :5173)
pnpm tauri dev
```

1. **Accessibility permission (dev mode, macOS)**: the unpacked dev binary won't appear in the Accessibility list automatically. Add the **terminal app** running `tauri dev` (Terminal / iTerm2 / VS Code) under System Settings → Privacy & Security → Accessibility. Not an issue for the packaged .app. On Windows, no permission grants are needed
2. Drag-select or double-click text in **any app** → the floating bar appears
3. Add a model service on the **Model** page — pick a preset, paste your key, confirm the model name — or point it at any OpenAI-compatible endpoint; add translation services with their keys on the **Translate** page
4. Click Translate / Explain / Summarize → streaming results

## Commands

```bash
pnpm check              # TS type check (tsc --noEmit)
pnpm build              # tsc + vite build → dist/
pnpm tauri dev          # development run
pnpm tauri build        # package the app
cargo check             # Rust check (run in src-tauri/)
cargo build             # Rust link verification
```

## Architecture

**Design principle: Rust owns the stable parts, TypeScript owns the fast-moving parts.**

```
TS (WebView × N)                          Rust core process
├─ main (index.html)  settings/self-check ├─ capture/  selection capture (macOS: CGEventTap + AX · Windows: mouse hook + UIA)
│    └─ invoke: get/save_settings         ├─ floating.rs  floating-bar window mgmt (one card per window on Windows)
├─ floating (floating.html) bar           ├─ settings.rs  JSON config + blocklist
│    └─ action registry (ACTIONS)→prompt  ├─ ai.rs  dumb OpenAI SSE pipe
│    └─ aiChat() → Channel stream         └─ main.rs  setup/tray/event dispatch
```

Data flow: platform capture (macOS: CGEventTap + AX · Windows: low-level mouse hook + UI Automation) → detect thread (gates / selection query) → filter (own PID / blocklist / duplicates) → event `selection://captured` → floating bar → user picks an action → prompt built in TS → Rust pipes SSE → streamed rendering.

- AI traffic goes through a dumb Rust pipe instead of direct WebView fetch, avoiding CORS issues with third-party BYOK endpoints. All prompts/actions live in the TS layer — adding an action = registering one object, zero Rust changes.
- Platform dispatch is abstracted: `capture/` picks a backend via `#[cfg]`, and both backends share one signature — macOS (CGEventTap + AX) and Windows (WH_MOUSE_LL hooks + UI Automation) both ship.

## Privacy & Security

- macOS: selection is read via Accessibility APIs by default; the built-in compatibility mode simulates ⌘C and restores the clipboard afterwards
- Windows: selection is read via UI Automation (WH_MOUSE_LL hooks) — no clipboard use and no system-permission grants; apps running as administrator are out of reach (UIPI)
- API keys are stored in plaintext in local `settings.json` (moving to the system keychain in M2) and are sent only to the LLM / translation endpoints you configure
- No telemetry, no accounts

## Feedback

Run into a problem or have an idea? Scan the QR code (Feishu form, no account needed) or [open it directly](https://tvxjr8zl48.feishu.cn/share/base/form/shrcnF78Kl495G3iUVz8iWvnA6e). In the app, **设置 › 关于 › 反馈问题** (also in the tray menu) jumps to the form or to [GitHub Issues](https://github.com/demo007x/Magpie/issues), and **复制日志** copies the run log to paste with your report. A web page can open that panel directly via `magpie://feedback`.

<p>
  <img src="docs/images/feedback-qrcode.png" width="160" alt="Feedback form QR code (Feishu)" />
</p>

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full, self-contained roadmap. Top priorities (M2): **clip-to-collection** into Notion / flomo / Apple Notes (Obsidian shipped in v0.1.9; custom AI actions in v0.1.6), follow-up Q&A in the result window, AI search & Q&A, context-aware selection, and moving API keys to the system keychain. Windows capture (UIA backend) shipped in v0.1.14. Mid-term (M3) converges built-ins, custom actions, integrations, and workflows into one unified action model; long-term (M4) adds hosted models for zero configuration.

> The architecture already reserves hooks for these capabilities (platform capture backends, the action registry); they will land milestone by milestone.

## Docs

Design documents are written in Simplified Chinese:

| Doc                                                              | Content                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/01-产品定位与规划.md](docs/01-产品定位与规划.md)           | Positioning, users, principles, roadmap, monetization |
| [docs/02-架构设计.md](docs/02-架构设计.md)                       | Layered architecture, data flow, protocol, evolution |
| [docs/03-模块设计.md](docs/03-模块设计.md)                       | Capture / windows & UI / AI service layer            |
| [docs/04-技术选型.md](docs/04-技术选型.md)                       | ADR decision records                                 |
| [docs/05-MVP执行计划.md](docs/05-MVP执行计划.md)                 | M1 execution history                                 |

## Contributing

Issues and PRs are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) (written in Simplified Chinese) for the contribution process, local verification standards, and engineering conventions.


## Star History

<a href="https://www.star-history.com/?repos=demo007x%2Fmagpie&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=demo007x/magpie&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=demo007x/magpie&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=demo007x/magpie&type=date&legend=top-left" />
 </picture>
</a>

## License

Released under the [MIT](./LICENSE) license.
