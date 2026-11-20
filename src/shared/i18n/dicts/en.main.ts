// main 域词典（英文）：键集以 zh.main.ts 为类型约束，缺键/多键编译期报错。
import type { zhMain } from "./zh.main";

export const enMain: Record<keyof typeof zhMain, string> = {
  "main.settings": "Settings",

  // App shell (App.tsx)
  "main.appName": "Magpie",
  "main.loading": "Loading…",
  "main.saveFailed": "Couldn't save: {error}",
  "main.uiBroken": "Something went wrong in the interface",

  // Sidebar navigation (page titles reuse the same keys)
  "nav.capture": "Capture",
  "nav.shortcuts": "Shortcuts",
  "nav.model": "Model",
  "nav.prompts": "Prompts",
  "nav.vision": "Vision",
  "nav.translate": "Translate",
  "nav.speech": "Read aloud",
  "nav.search": "Search",
  "nav.obsidian": "Obsidian",
  "nav.anki": "Anki",
  "nav.dict": "Dictionary",
  "nav.blocklist": "Blocked apps",
  "nav.general": "General",
  "nav.perms": "Permissions",
  "nav.about": "About",
  "nav.group.ai": "AI services",
  "nav.group.dest": "Save to",
  "nav.group.app": "Settings",

  // Shared across pages
  "common.dragToSort": "Drag to reorder",
  "common.saved": "Saved",
  "common.saveChanges": "Save changes",
  "common.default": "Default",
  "common.collapse": "Show less",
  "common.expandEdit": "Edit",
  "common.addService": "Add service",
  "common.custom": "Custom",
  "common.setDefaultDisabled": "Turn it on first to set it as default",
  "common.resetDefault": "Reset to default",
  "common.done": "Done",

  // Capture page
  "capture.actionsHint":
    "Drag the handle to reorder, use the switch to turn one off; changes apply right away and save automatically.",
  "capture.extractHint":
    "These actions only show up when the selected text contains a URL, email, phone number, verification code, or date{addr}.",
  "capture.extractHintAddr": " / location",
  "capture.showCount": "Actions shown",
  "capture.showCountHint": "Default 4 (2–8)",
  "capture.allOff":
    "Every action is off, so the floating bar won't appear on selection. Turn any switch back on to restore it.",
  "capture.iconAlt": "Action icon",
  "capture.tagMine": "Mine",
  "capture.editActionTitle": "Edit the action (name, icon, prompt, test run)",
  "capture.keepOneAction": "Keep at least one action on",
  "capture.customMax": "Up to {max} custom actions",
  "capture.customAddTitle": "Create a custom AI action",
  "capture.addCustom": "New AI action",
  "capture.extractModeAria": "Extraction method",
  "capture.modeAi": "AI understanding",
  "capture.modeSystem": "System detection",
  "capture.modeAiHint": "AI understanding needs a service set up on the Model page first",
  "capture.modeAiOnHint": "More accurate, but needs a model service",
  "capture.modeSystemHint": "No setup needed, recognized right on this device",
  "capture.newAction": "New action",
  "capture.tryNeedPrompt": "Enter a prompt first",
  "capture.tryNeedSample": "Enter a sample text first",
  "capture.customModalTitle": "Custom action “{name}”",
  "capture.confirmDelete": "Delete?",
  "capture.nameField": "Name (shown on the capsule button; keep it short)",
  "capture.namePh": "e.g. Translate terms",
  "capture.promptField":
    "Prompt (the instruction sent to the model; the selected text is appended automatically, no placeholder needed)",
  "capture.promptPh":
    "e.g. Translate the text below into English, keep technical terms with the original in parentheses, and output only the translation.",
  "capture.iconField": "Icon (shown on the left of the capsule button)",
  "capture.iconTabsAria": "Icon groups",
  "capture.iconGroupAria": "Icons · {group}",
  "capture.iconDefaultAria": "Default icon",
  "capture.trySampleField": "Test run: sample text (sent to the model as the selected text; not saved)",
  "capture.trySamplePh":
    "Paste some text to process, e.g. The committee deferred the decision pending further audit evidence.",
  "capture.generating": "Generating…",
  "capture.tryRun": "Test run",

  // Capture popup mode
  "capture.modeAria": "When to show the capsule",
  "capture.modeAlways": "Show on select",
  "capture.modeAlwaysSub": "Show the capsule as soon as you select text.",
  "capture.modeCtrl": "Show on Ctrl",
  "capture.modeCtrlSub":
    "Select text, then hold Ctrl (⌘ on macOS) to show the capsule. Useful when other apps already pop up on selection.",

  // Compatibility lookup allowlist (Windows only, capture page): per-app opt-in
  "capture.compatTitle": "Apps that hide their text",
  "capture.compatSub":
    "Add an app here and, when you select text in it, we’ll press the copy key once to grab that text and then put your clipboard back exactly as it was. This only happens in apps that don’t report their selection; every other app is untouched. With an empty list we never press a key for you.",
  "capture.compatRisk":
    "Heads-up: if that copy key does nothing in the app, we’ll try Ctrl+C once — and Ctrl+C interrupts a command that’s still running (an embedded terminal, for example). Only add apps you really need.",
  "capture.compatEmpty": "The list is empty.",
  "capture.compatPick": "Choose app…",
  "capture.compatRemove": "Remove from the list",

  // Shortcuts page
  "sc.hint":
    "Click a box and press the new key combination. It must include ⌘ / Ctrl / Alt / Shift; press Esc to cancel. Combinations already used by other apps won't take effect. Save to apply.",
  "sc.ocr.label": "Capture text from screen",
  "sc.ocr.desc": "Frame any area of the screen, then pick an action to recognize it.",
  "sc.ocrTranslate.label": "Capture and translate",
  "sc.ocrTranslate.desc": "Frame a screenshot and the captured text is translated automatically.",
  "sc.ocrExplain.label": "Capture and explain",
  "sc.ocrExplain.desc": "Frame a screenshot and AI explains what it captured.",
  "sc.ocrSummarize.label": "Capture and summarize",
  "sc.ocrSummarize.desc": "Frame a screenshot and AI boils it down to the key points.",
  "sc.fileOcr.label": "Text from images in Finder",
  "sc.fileOcr.desc": "Read text from the selected image files; from there it works like screen capture.",
  "sc.pressKeys": "Press a shortcut…",
  "sc.recordPh": "Click to record, e.g. {example}",
  "sc.needMod": "Include at least one modifier key",
  "sc.resetTitle": "Reset to the default shortcut",
  "sc.reset": "Reset",

  // Model services page
  "model.hint":
    "Pick a preset to add a service. You only need the API key and model name; the default service is used by all actions. Keys are stored on this device only. Save to apply.",
  "model.unnamedSvc": "Unnamed service",
  "model.noModel": "No model set",
  "model.fName": "Name",
  "model.fModel": "Model",
  "model.fForm": "API style",
  "model.fBaseUrl": "Service URL",
  "model.fApiKey": "API key",
  "model.formChat": "Chat · universal",
  "model.thinking": "Thinking mode",
  "model.thinkingSub": "On: answers are more accurate but slower. Off: faster.",
  "vision.hint":
    "When on, the model reads the image directly for the matching action (the screenshot is sent to your configured model service); needs a configured model service, and local recognition is used if the request fails. Vision translate always uses the model, not machine-translation services.",
  "vision.ocr": "Recognize text",
  "vision.translate": "Translate",
  "vision.explain": "Explain",
  "vision.summarize": "Summarize",
  "model.setAsDefault": "Set as default",
  "model.delSvcTitle": "Delete this service",
  "model.delConfirmTitle": "Delete service",
  "model.delSvcText":
    "Delete “{name}”? The model name, service URL and API key will be removed too.",
  "model.keepOne": "Keep at least one model service",
  "model.newProviderName": "Custom service",

  // Translate page
  "translate.hint":
    "The default service is the one-click option in Translate; drag to reorder the list. Translation direction is detected automatically. Save to apply.",
  "translate.setDefaultTitle": "Set as the default translate service",
  "translate.enableHint": "Turn on to show it in the Translate list",
  "translate.removeSvcTitle": "Remove this service",
  "translate.removeSvcAria": "Remove {name}",
  "translate.keepOne": "Keep at least one translate service",
  "translate.collapseCfg": "Hide settings",
  "translate.expandCfg": "Show settings",
  "translate.goModel": "Go to Model services",
  "translate.removeTitle": "Remove translate service",
  "translate.removeText":
    "Remove “{name}”? Keys you entered will be deleted too. To keep them, just turn the service off.",

  // Search engines page
  "search.hint":
    "Drag to reorder; “Default” is the one-click option. {qq} in the link is replaced with the selected text. Save to apply.",
  "search.setDefaultTitle": "Set as the default engine",
  "search.delEngineTitle": "Delete this engine",
  "search.keepOne": "Keep at least one search engine enabled",

  // Obsidian page
  "obsidian.hint":
    "Write captured text and screenshot results into markdown files in your vault using templates. No Obsidian plugin needed. Once configured, “Obsidian” appears in the capsules and result window. Save to apply.",
  "obsidian.vaultTitle": "Vault folder",
  "obsidian.vaultSet": "Connected. Writes stay inside this folder.",
  "obsidian.vaultUnset": "Pick the folder that contains .obsidian.",
  "obsidian.pickDir": "Choose folder…",
  "obsidian.clearVault": "Clear vault folder",
  "obsidian.dailyFolder": "Daily notes folder (path inside the vault; leave empty for the root)",
  "obsidian.dailyFolderPh": "e.g. Journal",
  "obsidian.dailyFileName": "Daily note filename format (same as the Daily Notes plugin)",
  "obsidian.taskFile": "Tasks file (path inside the vault; leave empty to append to today's daily note)",
  "obsidian.taskFilePh": "e.g. Tasks/todo.md",
  "obsidian.cardFolder": "Note cards folder (path inside the vault)",
  "obsidian.templatesSec": "Templates",
  "obsidian.excerptTpl": "Excerpt template",
  "obsidian.excerptTplVars":
    "Variables: {fText} selected text · {fSource} source app · {fTime} time · {fDate} date · {fLink} source page URL (empty outside browsers)",
  "obsidian.taskTpl": "Task template",
  "obsidian.taskTplVars":
    "Variables: {fText} task content · {fDue} due date · {fDueTag} calendar tag (omitted entirely when there is no date) · {fLink} source page URL (empty outside browsers)",
  "obsidian.cardTpl": "Note card template",
  "obsidian.cardTplVars":
    "Variables: {fText} selected text · {fSource} source app · {fTime} time · {fDate} date · {fLink} source page URL (empty outside browsers). One card per file, named after the first line of the selected text (up to 20 characters).",
  "obsidian.resetTplTitle": "Restore the factory default template",
  "obsidian.excerptNote": "Multi-line selections keep their markdown quote form line by line. Lines containing {fLink} are omitted when no link is available.",

  // Anki page
  "anki.hint":
    "Turn a selection into an Anki card in one click: the original text on the front, the translation, explanation or summary you just got on the back. Requires Anki running locally with the AnkiConnect add-on. Save to apply.",
  "anki.connectUrl": "AnkiConnect URL (default localhost:8765)",
  "anki.test": "Re-detect",
  "anki.testing": "Detecting…",
  "anki.testOk": "Connected",
  "anki.testFail": "Connection failed: make sure Anki is running with the AnkiConnect add-on installed",
  "anki.autoFail": "Anki not detected. It will connect automatically once Anki is running",
  "anki.tutorialLink": "Anki setup guide",
  "anki.companionHint":
    "Creates a \"Magpie\" deck in Anki, plus two card templates: Word and Content.",
  "anki.companionCreate": "Set up in one click",
  "anki.companionUse": "Existing decks and templates are not created twice",
  "anki.readyBadge": "Ready",
  "anki.companionCreating": "Setting up…",
  "anki.customTypeInUse": "Using your own note type \"{name}\".",
  "anki.defaultCardLabel": "Default card type",
  "anki.defaultCardAuto": "Auto",
  "anki.defaultCardWord": "Word",
  "anki.defaultCardContent": "Content",
  "anki.deckLabel": "Default deck",
  "anki.deckPlaceholder": "Choose a deck",
  "anki.modelLabel": "Note type",
  "anki.modelPlaceholder": "Choose a note type",
  "anki.pickEmpty": "Available after connecting",
  "anki.setupTitle": "Create Magpie companion decks?",
  "anki.setupText":
    "Magpie will create two decks in your Anki — \"Magpie::Word cards\" and \"Magpie::Content cards\" — with matching note types, so you can turn selections into cards in one click. To use your own deck instead, choose \"I'll pick\", then select an existing deck below.",
  "anki.setupCancel": "I'll pick",
  "anki.setupConfirm": "Create companion decks",

  // 词典页（离线查词，ADR-11）
  "dict.hint":
    "Select an English word and get dictionary meanings instantly — offline, no model credits. The dictionary belongs to the dictionary app on your computer; Magpie only reads it. Changes apply after saving.",
  "dict.stateReady": "Dictionary ready — {count} entries",
  "dict.stateUnset": "No dictionary found yet",
  "dict.stateMissing": "This dictionary file can't be found — it may have moved or been deleted",
  "dict.stateUnknown": "This file can't be read — it may not be a supported dictionary",
  "dict.fileLabel": "Dictionary file",
  "dict.choose": "Choose file…",
  "dict.autoDetected": "Auto-detected",
  "dict.chosenManually": "Chosen manually",
  "dict.useAuto": "Use auto-detection",
  "dict.autoHint": "If a compatible dictionary app is installed, it works with nothing to set up.",
  "dict.enOnly": "The dictionary covers English entries only; use Translate for Chinese or long passages.",
  "dict.sourceTitle": "Where the entries come from",
  "dict.credit":
    "Entries come from Aictionary's open-source local dictionary (built on a Wiktionary snapshot), licensed CC BY-SA 4.0.",
  "dict.sourceLink": "Project page",

  // Prompts page
  "prompts.hint":
    "Edit the instruction each action sends to the model. {lang} resolves to Simplified Chinese or English following the interface language, {date} to today's date, and the selected text is appended. Save to apply.",
  "prompts.customized": "Customized",
  "prompts.usingDefault": "Using the default",
  "prompts.viewDefault": "View the default",
  "prompts.resetTitle": "Clear your edit and restore the default prompt",

  // Blocklist page
  "blocklist.title": "Blocked apps",
  "blocklist.hint":
    "Apps on this list won't show the floating bar when you select text. Use “Choose app…” to add and the icon on the right to remove. Save to apply.",
  "blocklist.emptyTitle": "No blocked apps yet",
  "blocklist.removeTitle": "Remove from the blocklist",
  "blocklist.pickApp": "Choose app…",

  // Permissions page
  "perms.accessibility": "Accessibility",
  "perms.accessibilityMissing": "Required for text capture. Grant it to read selected text.",
  "perms.accessibilityDesc": "Reads selected text for translate, explain and summarize.",
  "perms.inputMonitoring": "Input Monitoring",
  "perms.inputMissing": "Required for the floating bar. Grant it so selecting text brings it up.",
  "perms.inputDesc": "Watches for text selection and brings up the floating bar.",
  "perms.screen": "Screen Recording",
  "perms.screenMissing": "Required for capturing text. Grant it to recognize text on screen.",
  "perms.screenDesc":
    "The basis of text capture; recognition runs on this device by default, and screenshots are sent to your model service only when vision processing is turned on.",
  "perms.selfCheck": "Capture health check",
  "perms.selfCheckSub":
    "A check for when text capture stops working: if all permissions are granted but no floating bar appears, turn Magpie's Accessibility off and back on in System Settings, then restart the app.",
  "perms.checking": "Checking",
  "perms.granted": "Granted",
  "perms.notGranted": "Not granted",
  "perms.ok": "OK",
  "perms.bad": "Failing",
  "perms.grantCapture": "Allow text capture",
  "perms.grantInput": "Allow Input Monitoring",
  "perms.grantScreen": "Allow Screen Recording",

  // General page
  "general.appearance": "App appearance",
  "general.appearanceAuto": "Auto",
  "general.appearanceLight": "Light",
  "general.appearanceDark": "Dark",
  "search.addCustom": "Custom",
  "general.uiLocaleTitle": "Interface language",
  "general.uiLocaleSub": "Follow the system or pick one; applies immediately.",
  "general.uiLocaleAuto": "Auto",
  "general.launchAtLogin": "Launch at login",
  "general.launchAtLoginSub": "Runs quietly in the menu bar after login.",
  "general.autoUpdateCheck": "Check for updates automatically",
  "general.autoUpdateCheckSub": "Checks periodically and lets you know when a new version is out.",
  "general.setFailed": "Couldn't update the setting: {error}",
  "general.dockIcon": "Show icon in the Dock",
  "general.dockIconSub": "When off, the app runs in the menu bar only; quit from its right-click menu.",
  "general.resultSize": "Default size",
  "general.sizeCompactH": "Compact · Wide",
  "general.sizeCompactV": "Compact · Tall",
  "general.sizeRoomyH": "Roomy · Wide",
  "general.sizeRoomyV": "Roomy · Tall",

  // Read-aloud page
  "speech.hint":
    "Read text aloud with voices that live on your computer. Download once, then it works offline. Nothing you read is uploaded.",
  "speech.installTitle": "Voice pack",
  "speech.installSub": "About {size} MB to download; download once, then it works offline.",
  "speech.installSubNoNum": "Download once, then it works offline.",
  "speech.download": "Download voice pack",
  "speech.downloading": "Downloading {percent}%",
  "speech.downloadingInd": "Downloading…",
  "speech.extracting": "Installing…",
  "speech.recommended": "Recommended",
  "speech.speed": "Speed",
  "speech.speed_slow": "Slow",
  "speech.speed_normal": "Normal",
  "speech.speed_fast": "Fast",
  "speech.downloadFailed": "Download failed: {error}",
  "speech.zhSec": "Chinese voices",
  "speech.enSec": "English voices",
  "speech.preview": "Preview",
  "speech.stop": "Stop",
  "speech.previewFailed": "Couldn't read it aloud: {error}",
  "speech.sampleZh": "今天我们来学习一篇关于旅行的课文。",
  "speech.sampleEn": "Never stop learning, because life never stops teaching.",
  "speech.default": "Default",
  "speech.voiceZhF": "Female {n}",
  "speech.voiceZhM": "Male {n}",
  "speech.voiceEnF": "US female {n}",
  "speech.voiceEnUk": "UK female",
  "speech.unsupported": "Read-aloud isn't available on this system yet.",
  "speech.enable": "Read-aloud feature",
  "speech.enableSub": "Turning it off deletes the downloaded voice pack. Download again to use it later.",
  "speech.offTitle": "Turn off read-aloud and delete the voice pack?",
  "speech.offText": "The downloaded voice files (about {size} MB) will be deleted. You can download them again anytime.",
  "speech.offTextNoNum": "The downloaded voice files will be deleted. You can download them again anytime.",
  "speech.offConfirm": "Turn off & delete",
  "speech.uninstallFailed": "Couldn't turn it off: {error}",

  // About page
  "about.tagline": "An immersive, customizable AI selection tool",
  "about.slogan": "Glean from every selection, gain from every read",
  "about.version": "Version {version}",
  "about.checkTitle": "Check for new versions",
  "about.checking": "Checking…",
  "about.checkNow": "Check for updates",
  "about.updateTo": "Update to v{version}",
  "about.updateAvailable":
    "New version v{latest} found (you have v{current}). Click “Update” to install in one step.",
  "about.updateCurrent": "You're up to date (v{current}), last checked {time}.",
  "about.updateFailed": "GitHub is temporarily unreachable.",
  "about.updateIdle": "You'll be told when a new version is out. Updating always asks first.",
  "about.feedbackSub": "Found a problem or have an idea? We'd love to hear it",
  "about.feedbackFeishu": "Feishu form",
  "about.starLead": "If Magpie has genuinely made things easier for you, ",
  "about.starAction": "give it a Star ★ on GitHub,",
  "about.shareLead": "and share that ease with more people: ",
  "about.shareAction": "copy share text",
  "about.shareText":
    "Magpie: a free AI selection tool for macOS & Windows. Select any text to translate, explain or summarize in place, and save straight into Obsidian or Anki. {url}",
  "about.shareCopied": "Share text copied. Paste it to a friend",
  "about.copyLog": "Copy logs",
  "about.logCopied": "Logs copied ({count} characters). You can paste them along with your feedback",
  "about.logCopyFailed": "Couldn't copy logs: {error}",

  // In-app update (update modal)
  "update.title": "Update available",
  "update.body": "Magpie v{latest} is ready. Updating closes and reopens the app.",
  "update.whatsNew": "See what's new",
  "update.later": "Later",
  "update.installNow": "Update now",
  "update.preparing": "Preparing download…",
  "update.downloading": "Downloading {pct}%",
  "update.installFailed": "The update didn't complete. Please try again later.",
};
