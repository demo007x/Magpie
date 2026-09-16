# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-09-16

### Added

- **Footer layout for the result window**: the action row is now a footer pinned to the window bottom edge — stable with or without results, during streaming, and while resizing. The secondary menu (service/engine chips) is part of the footer: expanding it grows the window downward by exactly the menu height and collapsing shrinks it back, while the footer and content never move.
- **Window dragging from anywhere**: press and hold any blank area of the panel to drag it — works on the very first press, with no prior click needed to focus. Position and size are persisted on release, so the panel reopens where you left it.
- **Two-phase text recognition**: the result panel pops up immediately after region selection, showing the captured screenshot preview with a "recognizing" placeholder; recognized text fills in automatically when done. Perceived wait drops from the whole pipeline to just the capture.
- **Live Liquid Glass toggle**: theme settings now offer a single on/off switch (on by default); toggling mounts/unmounts the glass material at runtime with no restart. The tint picker was removed.

### Changed

- **Window size is user-owned**: width and height only change by dragging, clamped to 320–560 × 200–800; content never resizes the window. The one exception: expanding the secondary menu grows the window downward by the menu height, collapsing back on close.
- **Secondary menu interaction rules**: clicking a menu item keeps the menu open and moves the selected highlight to it (no longer stuck on the default service); the chevron is the only open/close toggle; clicking any primary action button collapses an expanded menu; new results reset both menu and selection.
- **Faster OCR**: recognition level switched from Accurate to Fast — several times quicker on screenshots with no noticeable quality difference.

### Fixed

- A family of result-panel layout desync bugs: the action row jumping when the secondary menu opened or closed, leftover empty space after collapsing, and the footer floating mid-window. Stale frozen heights now self-clear via resize confirmation, a timeout fallback, and result resets.
- Secondary menu invisible in fresh OCR results before running any action.
- First drag gesture on the result window swallowed by app activation; focus is now applied on plain clicks instead of presses.
- Deprecation warning from an `objc2 msg_send!` call (missing commas between selector arguments); the build is now warning-free.

## [0.1.2] - 2026-09-14

### Added

- **Global shortcut for text recognition (OCR)**: customizable global hotkey to start screen text recognition anytime; the tray menu shows the current shortcut, the settings page offers key recording, and changes take effect immediately.
- **Global toast notifications**: recognition failures and other errors now show in a lightweight bubble window that follows the cursor and auto-dismisses after 4 seconds — visible even in menu-bar-only mode with the main window hidden.
- **Summarize & Search actions in the OCR panel**: summarize the recognized text with AI, or search it with the default search engine. Translate and Search support secondary menus (service/engine selection) that expand right below the action row.
- **Dedicated result window for selection actions**: AI results (translate/explain/summarize) and extracted info now open in a standalone window below the capsule — pinned by default, freely draggable, immune to stray clicks. The window position and size are remembered across closes and app restarts ("pin it where you like it").
- **Keyboard support in the result window**: click the panel to focus, then `Esc`/`⌘W` closes, `⌘P` toggles pin (Bob-style).
- **User-resizable result window**: drag the bottom edge (height only) or the bottom-right corner (width + height limit, 320–560 × 200–800). Size is persisted with the position; short results still auto-shrink within your limits.

### Changed

- **Refined visual theme for all popovers** ("Queyu" design language): capsule, result panel, OCR panel, and toast share a clean white (dark: deep violet-tinted) surface, 12px corner radius, layered native window shadow, and an indigo brand accent.
- **OCR panel redesigned**:
  - Panel height adapts to content — no more large empty areas.
  - Action buttons are pinned to the bottom while results scroll independently in the middle.
  - Streaming output sticks to the bottom by default; scrolling up pauses auto-follow and shows a "jump to bottom" button — reading at your own pace.
  - The expand/collapse toggle for recognized text only appears when the text exceeds 3 lines.
- **More compact selection capsule**: tighter button height/spacing, 12px labels, hairline separators between action groups, smooth hover transitions.
- **Reworked settings navigation** to match the product flow: 划词 → 快捷键 → 模型服务 → 翻译 → 搜索引擎 → 禁用应用 → 权限 → 关于.
- **Smoother streaming**: chunk updates are batched (~60ms) for silky long-text rendering; repeated queries within 5 minutes return instantly from cache.
- Result panel typography opened up (13px/1.85, looser paragraphs & lists); "thinking" placeholder now breathes; completion flashes a green dot; original text styled in quote blue.
- **Result panel width now follows the capsule width** — no abrupt width jump when opening results.

### Fixed

- OCR result panel not appearing on consecutive recognitions when content size was unchanged.
- App crash on recognition failure (macOS UI API called from a background thread).
- Verbose error toasts on recognition failure; now shows concise reasons such as "未识别到文字" (no text recognized).
- Spurious blockquote styling in translation results caused by model-emitted markdown `>` markers (prompt constraint + parsing fallback).
- Search action in the OCR context now searches the recognized text instead of the previous selection.
- `pnpm tauri dev` failing to start due to an invalid esbuild build-script approval placeholder.
- Main window showing a stale hardcoded version; it now reads the real app version at runtime.
- CI universal build missing the `ocr_helper` extra binary (now lipo-ed before bundling).
