# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-09-18

### Changed

- **Fixed Chinese text recognition**: recognized Chinese text came out garbled or empty. Recognition now uses an accurate level with automatic language detection, which also handles mixed-language content better. Supersedes the Fast-level switch from 0.1.3.
- **Toast width adapts to content**: short messages hug the text instead of filling a fixed-width slot; long messages cap at a maximum width, wrap to two lines, then truncate.
- **Smoother toast show/hide animation**: replaced the per-frame native shadow (the jank source) with a CSS-drawn shadow and an ease-out curve.

### Fixed

- Toast appearing at inconsistent positions across runs.
- Toast glass material showing a frosted band around the card, or lagging one size behind after the width changed.

## [0.1.4] - 2026-09-17

### Added

- **Appearance setting**: the appearance page now offers a Light / Dark / Follow-system theme switch. Applies instantly to every surface — main window, selection capsule, result panel, pinned images, and toasts — on both the CSS variable layer and the native window theme (NSAppearance), so glass materials stay in sync. Follow-system keeps the previous behavior untouched.
- **Editable OCR source text**: the recognized text in the result panel is now editable (plain-text only). OCR mistakes can be corrected in place before running follow-up actions like translate, explain, or search — a one-character fix instead of a re-screenshot. Caret position survives re-renders; new recognitions reset the content.
- **Two-mode source area in the result panel**: before any action runs, the source text fills the panel (scrollable) so large captures are readable without a wall of blank space; running an action smoothly collapses it to a 3-line fold (expandable up to 220px, height follows content) and hands the space to the result. Mode switches, expand, and collapse are all animated via CSS `max-height`/`flex` transitions (respects reduced-motion).
- **Delete custom search engines**: custom engines in the search engine list now show a delete button on hover. The six built-in engines are system defaults — they can be disabled and reordered but not deleted. Deleting the default engine falls the default to the next enabled one; deleting the last enabled engine is blocked.
- **Pinned-image polish**: the hover toolbar (recognize / copy / close) now uses a frosted-glass background (semi-transparent + backdrop blur) instead of an opaque patch; pinned images get a hairline border so light screenshots stay visible on light wallpapers.
- **Cursor-anchored zoom for pinned images**: scrolling now zooms around the point under the cursor (the anchored spot stays put) instead of growing from the top-left corner; zoom sensitivity is continuous and gentler — trackpad micro-scrolls no longer overshoot.

### Changed

- **Text recognition results are pinned by default**: the OCR result panel no longer vanishes on a stray click while you read the source, pin the image, or run actions — consistent with selection-result panels. Closing it (✕) still unpins for the next session.
- **Typography consistency**: 11px Chinese labels (extract groups, mini buttons) raised to 12px to avoid blurry rendering on 1x displays; footer action buttons slightly taller (24px → 26px) for a more forgiving click target.

### Fixed

- Expanding the OCR source in a small window pushed the footer action row and result area out of the panel — the expanded height was a hard 220px that couldn't flex; it now yields to the window and scrolls internally.
- The source area was not scrollable while collapsed; long source text can now be scrolled in the 3-line fold.
- Pin-image from the result panel silently did nothing: the screenshot was consumed together with the OCR pending result before the pin command could take ownership. Image ownership now lives in its own store and survives panel consumption.
- The source expand/collapse toggle disappeared after one expand-collapse round trip: overflow was measured against the container height mid-transition; it is now measured against the fold height constant.
- Wheel-zoomed pinned images drifting on screen: position is now compensated per zoom anchor and clamped to the monitor.

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
