// ---- 图标（lucide-react 图标库，统一 14px / 1.75 描边，随文字色）----
// 从 App.tsx 拆出：pops.tsx（分离卡的弹层窗口是哑渲染端）与 App 共用同一套图标语言
import {
  AlignLeft,
  CalendarDays,
  Check,
  ClipboardCheck,
  Copy,
  ExternalLink,
  Languages,
  Lightbulb,
  Mail,
  MapPin,
  NotebookPen,
  Phone,
  ScanSearch,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { customIconNode } from "../shared/icons";

export const ICONS: Record<string, ReactNode> = {
  copy: <Copy size={14} strokeWidth={1.75} />,
  search: <Search size={14} strokeWidth={1.75} />,
  translate: <Languages size={14} strokeWidth={1.75} />,
  explain: <Lightbulb size={14} strokeWidth={1.75} />,
  summarize: <AlignLeft size={14} strokeWidth={1.75} />,
  link: <ExternalLink size={14} strokeWidth={1.75} />,
  email: <Mail size={14} strokeWidth={1.75} />,
  code: <ClipboardCheck size={14} strokeWidth={1.75} />,
  tel: <Phone size={14} strokeWidth={1.75} />,
  date: <CalendarDays size={14} strokeWidth={1.75} />,
  obsidian: <NotebookPen size={14} strokeWidth={1.75} />,
  addr: <MapPin size={14} strokeWidth={1.75} />,
  __extract: <ScanSearch size={14} strokeWidth={1.75} />,
  // 自定义动作共用一枚图标：用户自己起的名字已经是辨识度，不做图标选择器
  __custom: <Sparkles size={14} strokeWidth={1.75} />,
};

// 自定义动作带 icon（lucide 名，shared/icons.tsx）时优先用之；未设置/查不到
// 回落内置表，再回落默认 Sparkles
export const iconOf = (id: string, icon?: string) =>
  customIconNode(icon, 14) ?? ICONS[id] ?? ICONS.__custom;

// 13px 工具钮图标（面板头部/钉图工具条用）
export const CopyIcon = <Copy size={13} strokeWidth={1.75} />;
export const CheckIcon = <Check size={13} strokeWidth={2} className="ok" />;
export const CloseIcon = <X size={13} strokeWidth={1.75} />;
