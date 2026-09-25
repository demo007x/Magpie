# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.7] - 2026-09-25

### Added

- **Scene exit actions: Add to Calendar & Open in Maps** — select a sentence with a date ("周四下午3点开会") and a calendar button appears on the capsule, prefilling a new event in the system Calendar; select a place ("国贸B座" / "北京天安门") and a maps button opens the native Maps app. Dates use Apple's NSDataDetector (offline, deterministic, handles Chinese relative dates); places use Apple's NaturalLanguage named-entity recognition (`NLTagger` placeName, offline on-device) — precision-first: junk like bare type words ("校区/园区") and sentence fragments are never surfaced, and missed detections simply mean no button. Both live in the existing entity-extraction framework (single entity → direct capsule button; multiple → the extract panel with per-row actions) and can be toggled per-action in settings. Zero AI APIs, zero external services, zero new permissions.
- **Custom action icons**: pick a lucide icon (36 presets in 5 groups) when creating or editing a custom action, so your own actions no longer all share the sparkle. The choice shows on the capsule, the overflow panel, and the OCR result window; unset falls back to the default. Stored as the icon name in settings — older configs without the field keep working.

### Changed

- **Custom action editing moves into a dialog**: the settings list row no longer expands inline — a pencil button opens a dialog containing the name, prompt, icon picker (grouped), the try-run panel, and delete with an inline confirm step. Writing a prompt, testing it, and tweaking it now happens in one place instead of jumping between the row and a separate dialog.
- **Adaptive selection debounce**: drag-selection now waits only 30ms before the accessibility query (the selection is already final on mouse-up), while double/triple-click keeps the configurable 200ms wait (the app computes the selection after mouse-up). Perceived capsule latency drops from ~250ms to ~80ms on drag.
- **Capsule placement**: the floating bar now always appears centered above the mouse cursor (16px card gap, flipping below near the screen top), replacing both the old bottom-right anchoring and an experimental selection-anchored variant — Chromium/Electron apps don't expose selection geometry, so one consistent anchor won out (ADR-06).
- **OCR source text typography**: the recognized-source area now shares the result area's reading metrics (13px / 1.8 line height / letter spacing) in a neutral gray-blue, with a left quote bar marking it as source and a faint hover tint hinting that the text is editable in place; the collapsed three-line fold height was re-derived for the new metrics.

### Fixed

- **Range-fallback text capture never worked**: the AXValue type constant for `CFRange` was wrong (3 = CGRect instead of 4), so the "AXSelectedTextRange + AXStringForRange" fallback (needed by WeChat and other Qt-drawn text views) silently failed on every attempt and slid into clipboard compatibility mode. Now functional.
- **Result-window title ignored the running action**: a 识图总结 (⌃⇧D) session showed the generic 识图取字 title. The title (and icon) now follows the current action — 识图翻译 / 识图解释 / 识图总结 — while pure text recognition keeps 识图取字.
- **Dev-only double event handling**: event listeners registered in the React effect could leak across StrictMode remounts (cleanup ran before `listen()` resolved), making every selection event be handled twice in dev builds.

## [0.1.6] - 2026-09-21

### Added

- **Custom actions**: create your own capsule actions (name + prompt, up to 10). They sit alongside the built-ins in the same reorderable list, and each one has a 试跑 panel that sends your sample text through the default model so you can check the prompt before using it.
- **Prompt 设置 page**: edit the instructions behind 翻译 / 解释 / 总结. What the editor shows is exactly what gets sent; the selected text follows as content. Edited actions are marked, and the default can be restored.
- **Capsule action count**: choose how many actions the capsule shows at once (2–8, default 4). The rest fold into a ˅ menu instead of squeezing the bar.
- **Update checks**: a new GitHub release is checked once a day and on demand from 设置 › 关于, with a menu-bar toast when one is found. The app never updates itself — 下载 opens the release page in your browser. Checks only read public release info and send no local data.
- **Esc closes the capsule** while it is visible.
- **Delete confirmations** for model services and custom actions, so an API key or a written prompt cannot disappear with one mis-click.

### Changed

- **Settings pages restructured**: 划词 is now three cards — 胶囊 (action count) / 动作 / 提取信息 — because 打开链接 / 写邮件 / 复制号码 / 复制验证码 only appear when the selection contains a URL, e-mail, phone number or code, so their relative order is meaningless. The custom-action try-run moved into a modal, which frees most of the row height.
- **All settings copy rewritten** to say what the page edits and how, in one product register instead of feature introductions; each page now states honestly whether a change reaches the capsule live or needs 保存更改.
- **Delete buttons unified** across model services, custom actions, search engines and disabled apps: one borderless icon button that turns red on hover.
- **保存更改 pinned to the bottom of the window** on every page, so long lists don't end at the bottom edge.
- **Pinning is now your preference**: a new result no longer re-pins the panel, so Esc and clicking away close it once you un-pin. Pinned or still-generating panels ignore the close.
- **Capsule and result panel surface**: dropped the frosted-glass material for a solid card with a hairline border and a CSS shadow; result panels can split into separate cards.
- **试跑 input**: the sample text is now something you paste in, replacing a fixed example sentence that the model sometimes answered as if it were a translation request.

### Fixed

- **Buttons that silently did nothing**: `window.alert` / `confirm` are no-ops in the embedded web view, so validation reminders never appeared and custom actions could not be deleted at all. Reminders now go through the global toast, confirmations through a modal.
- **Icon and label misaligned** inside buttons such as 删除.

## [0.1.5] - 2026-09-18

### Added

- **Three one-step recognition shortcuts**: 识图翻译 / 识图解释 / 识图总结 — press the shortcut, select a screen region, and the recognized text is automatically translated (via your default translate service), explained, or summarized in the result panel. Each has a customizable global shortcut (default ⌥T / ⌥E / ⌥D) with reset-to-default in the settings page.
- **All recognition actions in the tray menu**: 识图取字 / 识图翻译 / 识图解释 / 识图总结 now appear in the right-click tray menu (grouped, each showing its current shortcut), so every shortcut-triggerable action is also reachable by mouse.

### Changed

- **Fixed Chinese text recognition**: recognized Chinese text came out garbled or empty. Recognition now uses an accurate level with automatic language detection, which also handles mixed-language content better. Supersedes the Fast-level switch from 0.1.3.
- **Toast width adapts to content**: short messages hug the text instead of filling a fixed-width slot; long messages cap at a maximum width, wrap to two lines, then truncate.
- **Smoother toast show/hide animation**: replaced the per-frame native shadow (the jank source) with a CSS-drawn shadow and an ease-out curve.
- **Recognition features renamed for clarity**: 文本识别 → 识图取字, and the new one-step actions follow the same 识图X naming across the tray menu, settings, and result panel.
- **识图翻译 follows your translate settings**: the one-step shortcut and tray item use the configured default translate service (Baidu / DeepL / AI) instead of always using AI.
- **Extract panel polish**: row actions (打开 / 邮件 / 复制) appear on hover as an overlay instead of occupying a permanent column; each group shows an item count; rows are tighter; URLs show the domain emphasized with the path dimmed, and long links are collapsed to head + tail (hover shows the full address).
- **Source expand toggle moved**: the recognized-text expand/collapse chevron now sits on the divider below the source area instead of floating over the text, so every line uses the full width.
- **Shortcuts settings rows match the other pages** in spacing and hairline dividers.

### Fixed

- Toast appearing at inconsistent positions across runs.
- Toast glass material showing a frosted band around the card, or lagging one size behind after the width changed.
- Text selected together with surrounding page content (e.g. a Google result line "https://obsidian.md · 翻译此页") produced a broken URL that opened a blank page; page text glued onto the domain is now trimmed off.
- URLs with less common domains (such as `.sh` / `.md`) were not recognized at all; URL detection is now pattern-based (scheme + host) instead of a fixed domain-suffix list.

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
