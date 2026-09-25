// 自定义 AI 动作的可选图标集：lucide 预置具名图标，两个 WebView 窗口共用。
// 存储约定：CustomAction.icon 存 lucide 组件名（如 "BookOpen"），查不到或未设置
// 时由调用方回落默认 Sparkles——名字即契约，改名单里的键必须同步考虑旧配置。

import type { ReactNode } from "react";
import {
  BookOpen,
  Braces,
  Briefcase,
  Bug,
  Calculator,
  CalendarClock,
  Code,
  Coffee,
  Cpu,
  Database,
  Dumbbell,
  FileText,
  Flag,
  GitBranch,
  Globe,
  GraduationCap,
  HeartPulse,
  Highlighter,
  ListChecks,
  MapPin,
  MessageSquare,
  MessagesSquare,
  NotebookPen,
  Palette,
  PenLine,
  Pill,
  Plane,
  Quote,
  Rocket,
  ScrollText,
  Send,
  ShoppingBag,
  Star,
  Terminal,
  TrendingUp,
  UtensilsCrossed,
} from "lucide-react";

/** 选择器分组名单（设置页按组渲染；顺序即展示顺序） */
export const CUSTOM_ICON_CHOICES: Array<{ group: string; names: string[] }> = [
  {
    group: "学习写作",
    names: ["BookOpen", "NotebookPen", "PenLine", "Highlighter", "ScrollText", "GraduationCap", "Quote", "FileText"],
  },
  {
    group: "语言沟通",
    names: ["MessageSquare", "MessagesSquare", "Globe", "Send"],
  },
  {
    group: "开发工具",
    names: ["Code", "Terminal", "Bug", "Braces", "GitBranch", "Database", "Cpu", "Rocket"],
  },
  {
    group: "生活",
    names: ["UtensilsCrossed", "Coffee", "Plane", "HeartPulse", "ShoppingBag", "Dumbbell", "MapPin", "Pill"],
  },
  {
    group: "效率其他",
    names: ["ListChecks", "CalendarClock", "Briefcase", "TrendingUp", "Palette", "Calculator", "Star", "Flag"],
  },
];

// 名字 → lucide 组件（与名单同键维护）
const CUSTOM_ICON_COMPONENTS: Record<string, (typeof BookOpen) | undefined> = {
  BookOpen,
  NotebookPen,
  PenLine,
  Highlighter,
  ScrollText,
  GraduationCap,
  Quote,
  FileText,
  MessageSquare,
  MessagesSquare,
  Globe,
  Send,
  Code,
  Terminal,
  Bug,
  Braces,
  GitBranch,
  Database,
  Cpu,
  Rocket,
  UtensilsCrossed,
  Coffee,
  Plane,
  HeartPulse,
  ShoppingBag,
  Dumbbell,
  MapPin,
  Pill,
  ListChecks,
  CalendarClock,
  Briefcase,
  TrendingUp,
  Palette,
  Calculator,
  Star,
  Flag,
};

/** 图标名 → JSX 节点；未设置/查不到返回 null（调用方回落默认 Sparkles） */
export function customIconNode(name: string | undefined, size = 14): ReactNode {
  const C = name ? CUSTOM_ICON_COMPONENTS[name] : undefined;
  return C ? <C size={size} strokeWidth={1.75} /> : null;
}
