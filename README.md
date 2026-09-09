<div align="center">

<img src="app-icon.png" width="100" alt="Magpie app icon" />

# Magpie (拾趣)

**Understand as you read** — an AI reading companion that explains any text selection

Select text in any app and an instant floating bar offers translate / explain / summarize — gradually settling every bit of understanding into your personal knowledge base.

[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-black)](#)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange?logo=rust)](#)
[![Tauri](https://img.shields.io/badge/Tauri-2-yellow?logo=tauri)](#)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[简体中文](./README.zh-CN.md) | [English](./README.md)

</div>

---

## Introduction

**Magpie (拾趣)** is an AI reading companion: select text in *any* macOS app and a floating bar instantly offers translate / explain / summarize with streaming output. Unlike pure translation tools, Magpie centers on the selection itself — zero-cost capture via Accessibility APIs (never touches the clipboard) — and will gradually settle every bit of understanding into your personal knowledge base.

## Screenshots

![Magpie in action: select text anywhere → floating bar → streaming result](docs/images/hero.png)

![Main window · model settings](docs/images/settings.png)

<p align="center">
  <img src="docs/images/settings_trans.png" width="49%" alt="Main window · translate settings" />
  <img src="docs/images/settings_search.png" width="49%" alt="Main window · search settings" />
</p>

## Implemented Features (M1 / MVP)

- **Clipboard-free capture** — global text selection via macOS Accessibility APIs (CGEventTap + AX); drag-select or double-click triggers it. **Never touches the clipboard**
- **Floating bar** — frosted-glass capsule near your cursor, auto edge-clamping, never steals focus, light/dark theme aware
- **Five actions** — Translate / Explain / Summarize (streaming AI) + Copy / Search (local); order and visibility configurable
- **Three translation channels** — AI translation (LLM), Baidu Translate, and DeepL; click for the default, expand to switch
- **Custom search engines** — ships with Baidu AI / Baidu / Google AI / Google / Bing / GitHub; any `{q}` URL template works
- **BYOK** — bring your own API key; DeepSeek preset, works with any OpenAI-compatible endpoint
- **Menu bar resident** — Dock icon hidden by default; closing the main window just hides it while capture keeps running
- **App blocklist** — no triggering inside terminals, password managers, or other sensitive apps

## Prerequisites

- macOS 13+ (Apple Silicon)
- Xcode Command Line Tools
- Rust 1.80+
- Node 20+
- pnpm

## Getting Started

```bash
# Clone and install dependencies
git clone https://github.com/demo007x/Magpie.git
cd Magpie
pnpm install

# Run in development mode (starts vite on :5173)
pnpm tauri dev
```

1. **Accessibility permission (dev mode)**: the unpacked dev binary won't appear in the Accessibility list automatically. Add the **terminal app** running `tauri dev` (Terminal / iTerm2 / VS Code) under System Settings → Privacy & Security → Accessibility. Not an issue for the packaged .app
2. Drag-select or double-click text in **any app** → the floating bar appears
3. Configure a provider in the main window (DeepSeek preset, or any OpenAI-compatible endpoint); Baidu / DeepL keys go in the Translate page
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
TS (WebView × 2)                          Rust core process
├─ main (index.html)  settings/self-check ├─ capture/  selection capture (CGEventTap + AX)
│    └─ invoke: get/save_settings         ├─ floating.rs  floating bar window mgmt
├─ floating (floating.html) bar           ├─ settings.rs  JSON config + blocklist
│    └─ action registry (ACTIONS)→prompt  ├─ ai.rs  dumb OpenAI SSE pipe
│    └─ aiChat() → Channel stream         └─ main.rs  setup/tray/event dispatch
```

Data flow: CGEventTap (mouse) → detect thread (debounce / AX query) → filter (own PID / blocklist / duplicates) → event `selection://captured` → floating bar → user picks an action → prompt built in TS → Rust pipes SSE → streamed rendering.

- AI traffic goes through a dumb Rust pipe instead of direct WebView fetch, avoiding CORS issues with third-party BYOK endpoints. All prompts/actions live in the TS layer — adding an action = registering one object, zero Rust changes.
- Platform dispatch is abstracted: `capture/` picks a backend via `#[cfg]`, both share one signature; the Windows (M2) backend plugs in the same way.

## Privacy & Security

- Selection capture **never reads or writes the clipboard** (pure Accessibility APIs)
- API keys are stored in plaintext in local `settings.json` (moving to the system keychain in M2) and are sent only to the LLM / translation endpoints you configure
- No telemetry, no accounts

## Future Plans

> The architecture already reserves hooks for these capabilities (platform capture backends, the action registry); they will land milestone by milestone.

**M2 — multi-platform & smarter selection**

- Windows capture (UIA backend; platform dispatch already reserved)
- AI search & follow-up Q&A (multi-turn with a tool loop)
- Context-aware selection (deep understanding using surrounding text)
- Custom actions (extend the action registry with your own)
- Global shortcut to summon the floating bar
- Move API keys to the system keychain

**M3 — knowledge-base flywheel**

- Clip-to-collection: settle every bit of understanding into a personal knowledge base

**M4 — zero configuration**

- Hosted models (no BYOK required) and accounts

## Docs

Design documents are written in Simplified Chinese:

| Doc                                                              | Content                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/01-PRD-MVP.md](docs/01-PRD-MVP.md)                         | Product requirements, scope, acceptance criteria     |
| [docs/02-架构设计.md](docs/02-架构设计.md)                       | Layered architecture, data flow, protocol, evolution |
| [docs/03-模块设计-划词捕获.md](docs/03-模块设计-划词捕获.md)     | Highest-risk module: CGEventTap + AX                 |
| [docs/04-模块设计-窗口与交互.md](docs/04-模块设计-窗口与交互.md) | Floating bar / main window specs                     |
| [docs/05-模块设计-AI服务层.md](docs/05-模块设计-AI服务层.md)     | Action registry, prompts, streaming protocol         |
| [docs/06-技术选型.md](docs/06-技术选型.md)                       | ADR decision records                                 |
| [docs/07-MVP执行计划.md](docs/07-MVP执行计划.md)                 | Task breakdown & acceptance status                   |

## License

Released under the [MIT](./LICENSE) license.
