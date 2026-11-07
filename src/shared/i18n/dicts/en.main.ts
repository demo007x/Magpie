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
  "nav.translate": "Translate",
  "nav.search": "Search",
  "nav.obsidian": "Obsidian",
  "nav.blocklist": "Blocklist",
  "nav.general": "General",
  "nav.perms": "Permissions",
  "nav.about": "About",

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
  "capture.hint":
    "Choose which actions the floating bar shows and in what order: drag the handle to reorder, use the switch to turn one off. Switches, order and custom action edits apply right away and save automatically.",
  "capture.extractHint":
    "“Extract info” only shows up when the selected text contains a URL, email, phone number, verification code, or date{addr}.",
  "capture.extractHintAddr": " / location",
  "capture.capsuleSec": "Capsules",
  "capture.showCount": "Actions shown",
  "capture.showCountHint": "Default 4 (2–8)",
  "capture.allOff":
    "Every action is off: the floating bar will no longer appear when you select text. You can still open this window from the menu bar icon — turn any switch back on to restore it.",
  "capture.iconAlt": "Action icon",
  "capture.tagMine": "Mine",
  "capture.editActionTitle": "Edit the action (name, icon, prompt, test run)",
  "capture.keepOneAction": "Keep at least one action on",
  "capture.customMax": "Up to {max} custom actions",
  "capture.customAddTitle": "Create a custom AI action",
  "capture.addCustom": "New AI action",
  "capture.actionsSec": "Actions",
  "capture.extractSec": "Extract info",
  "capture.extractModeAria": "Extraction method",
  "capture.modeAi": "AI understanding",
  "capture.modeSystem": "System detection",
  "capture.modeAiHint": "AI understanding needs a service set up on the Model page first",
  "capture.modeAiOnHint": "More accurate, but needs a model service",
  "capture.modeSystemHint": "No setup needed — recognized right on this device",
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

  // Shortcuts page
  "sc.hint":
    "Click a box and press the new key combination — it must include ⌘ / Ctrl / Alt / Shift; press Esc to cancel. Combinations already used by other apps won't take effect. Click “Save changes” to make them permanent.",
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
  "model.title": "Model services",
  "model.hint":
    "Pick a preset to add a service — you only need the API key and model name; the default service is used by all actions. Keys are stored on this device only. Click “Save changes” to make them permanent.",
  "model.servicesSec": "Services",
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
  "model.setAsDefault": "Set as default",
  "model.delSvcTitle": "Delete this service",
  "model.delConfirmTitle": "Delete service",
  "model.delSvcText":
    "Delete “{name}”? The model name, service URL and API key will be removed too.",
  "model.keepOne": "Keep at least one model service",
  "model.newProviderName": "Custom service",

  // Translate page
  "translate.hint":
    "Use “Add service” to pick a provider; adding it turns it on right away. Switches turn services off without losing their settings, and keys are filled in inline. “Default” is the one-click option; drag to reorder. The translation direction is detected automatically. Click “Save changes” to make them permanent.",
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
  "search.title": "Search engines",
  "search.hint":
    "Drag to reorder; “Default” is the one-click option. {qq} in the link is replaced with the selected text. Click “Save changes” to make them permanent.",
  "search.setDefaultTitle": "Set as the default engine",
  "search.delEngineTitle": "Delete this engine",
  "search.keepOne": "Keep at least one search engine enabled",

  // Obsidian page
  "obsidian.hint":
    "Write captured text and screenshot results into markdown files in your vault using templates — no Obsidian plugin needed. Once configured, “Obsidian” appears in the capsules and result window. Changes take effect after saving.",
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
    "Variables: {fText} selected text · {fSource} source app · {fTime} time · {fDate} date",
  "obsidian.taskTpl": "Task template",
  "obsidian.taskTplVars":
    "Variables: {fText} task content · {fDue} due date · {fDueTag} calendar tag (omitted entirely when there is no date)",
  "obsidian.cardTpl": "Note card template",
  "obsidian.cardTplVars":
    "Variables: {fText} selected text · {fSource} source app · {fTime} time · {fDate} date. One card per file, named after the first line of the selected text (up to 20 characters).",
  "obsidian.resetTplTitle": "Restore the factory default template",
  "obsidian.excerptNote": "Multi-line selections keep their markdown quote form line by line.",

  // Prompts page
  "prompts.hint":
    "Edit the instruction each action sends to the model. {lang} resolves to Simplified Chinese or English following the interface language, {date} to today's date, and the selected text is appended. Changes take effect after saving.",
  "prompts.customized": "Customized",
  "prompts.usingDefault": "Using the default",
  "prompts.viewDefault": "View the default",
  "prompts.resetTitle": "Clear your edit and restore the default prompt",

  // Blocklist page
  "blocklist.title": "Blocked apps",
  "blocklist.hint":
    "Apps on this list won't show the floating bar when you select text. Use “Choose app…” to add and the icon on the right to remove. Changes take effect after saving.",
  "blocklist.emptyTitle": "No blocked apps yet",
  "blocklist.emptySub": "The list is empty; every app shows the floating bar when you select text.",
  "blocklist.removeTitle": "Remove from the blocklist",
  "blocklist.pickApp": "Choose app…",

  // Permissions page
  "perms.hint":
    "Text capture needs Accessibility and Input Monitoring; screenshots need Screen Recording. Come back after granting and the status refreshes on its own.",
  "perms.accessibility": "Accessibility",
  "perms.accessibilityMissing": "Required for text capture — grant it to read selected text.",
  "perms.accessibilityDesc": "Reads selected text for translate, explain and summarize.",
  "perms.inputMonitoring": "Input Monitoring",
  "perms.inputMissing": "Required for the floating bar — grant it so selecting text brings it up.",
  "perms.inputDesc": "Watches for text selection and brings up the floating bar.",
  "perms.screen": "Screen Recording",
  "perms.screenMissing": "Required for capturing text — grant it to recognize text on screen.",
  "perms.screenDesc":
    "The basis of text capture; recognition happens entirely on this device and the image never leaves it.",
  "perms.selfCheck": "Capture health check",
  "perms.selfCheckSub":
    "A check for when text capture stops working. If everything is granted but no floating bar appears, turn Magpie's Accessibility permission off and back on in System Settings, then restart the app.",
  "perms.checking": "Checking",
  "perms.granted": "Granted",
  "perms.notGranted": "Not granted",
  "perms.ok": "OK",
  "perms.bad": "Failing",
  "perms.grantCapture": "Allow text capture",
  "perms.grantInput": "Allow Input Monitoring",
  "perms.grantScreen": "Allow Screen Recording",

  // General page
  "general.hint":
    "App-level settings for appearance, launch, Dock and the result window. Changes apply immediately unless noted.",
  "general.themeSec": "Appearance",
  "general.appearance": "App appearance",
  "general.appearanceAuto": "Auto",
  "general.appearanceLight": "Light",
  "general.appearanceDark": "Dark",
  "search.addCustom": "Custom",
  "general.languageSec": "Language",
  "general.launchSec": "Launch",
  "general.uiLocaleTitle": "Interface language",
  "general.uiLocaleSub": "Follow the system or pick one; applies immediately.",
  "general.uiLocaleAuto": "Auto",
  "general.launchAtLogin": "Launch at login",
  "general.launchAtLoginSub": "Runs quietly in the menu bar after login.",
  "general.setFailed": "Couldn't update the setting: {error}",
  "general.dockSec": "Dock",
  "general.dockIcon": "Show icon in the Dock",
  "general.dockIconSub": "When off, the app runs in the menu bar only; quit from its right-click menu.",
  "general.resultSec": "Result window",
  "general.resultSize": "Default size",
  "general.sizeCompactH": "Compact · Wide",
  "general.sizeCompactV": "Compact · Tall",
  "general.sizeRoomyH": "Roomy · Wide",
  "general.sizeRoomyV": "Roomy · Tall",

  // About page
  "about.hint": "Version info, update checks and ways to reach us.",
  "about.slogan": "Glean from every selection, gain from every read",
  "about.desc": "Magpie · the reading companion that makes any selected text instantly clear",
  "about.motto": "From reading, into thought",
  "about.version": "Version {version}",
  "about.updateSec": "Updates",
  "about.checkTitle": "Check for new versions",
  "about.checking": "Checking…",
  "about.checkNow": "Check for updates",
  "about.download": "Download v{version}",
  "about.updateAvailable":
    "New version v{latest} found (you have v{current}). Click “Download” to get the installer from the release page.",
  "about.updateCurrent":
    "You're up to date (v{current}), last checked {time}. Magpie checks once a day automatically, and you can check anytime.",
  "about.updateFailed":
    "The check didn't go through this time (no network, or GitHub is temporarily unreachable). It will retry automatically next launch.",
  "about.updateIdle": "You'll be told when a new version is out — nothing installs automatically.",
  "about.feedbackSec": "Feedback",
  "about.feedbackSub": "Found a problem or have an idea? We'd love to hear it.",
  "about.feedbackFeishu": "Feishu form",
  "about.copyLog": "Copy logs",
  "about.logCopied": "Logs copied ({count} characters) — you can paste them along with your feedback",
  "about.logCopyFailed": "Couldn't copy logs: {error}",
};
