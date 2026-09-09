import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiEvent, ChatMessage } from "./types";

export interface AiStreamHandlers {
  onDelta(content: string): void;
  onDone(): void;
  onError(message: string): void;
}

// 流式对话：Rust 哑管道（解决 CORS，兼容任意 OpenAI 兼容端点）
// 约定：请求发出前的配置类错误走 Promise rejection；请求/流中途错误走 onerror 事件
export function aiChat(
  messages: ChatMessage[],
  providerId: string | null,
  h: AiStreamHandlers,
): void {
  const channel = new Channel<AiEvent>();
  channel.onmessage = (msg) => {
    if (msg.type === "delta") h.onDelta(msg.content);
    else if (msg.type === "done") h.onDone();
    else if (msg.type === "error") h.onError(msg.message);
  };
  invoke("ai_chat", { messages, providerId: providerId ?? null, channel }).catch(
    (err) => h.onError(String(err)),
  );
}
