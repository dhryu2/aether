// 서버가 가진 대화 전체를 마크다운 파일로 만든다. 화면 꼬리가 아니라 사건 목록이 입력이다.
import { agentEventsOf } from "./agentEvents";
import type { AgentEvent } from "./types";

export type TranscriptLabels = {
  user: string;
  images: (count: number) => string;
  tool: (name: string, target?: string) => string;
};

export const transcriptLabelsKo: TranscriptLabels = {
  user: "사용자",
  images: (count) => `이미지 ${count}개`,
  tool: (name, target) => (target ? `도구: ${name} ${target}` : `도구: ${name}`),
};

type TranscriptEvent = {
  kind?: string;
  text?: string;
  images?: unknown[];
  events?: Array<{ type?: string; text?: string; name?: string; target?: string }>;
};

export function eventsToMarkdown(events: readonly TranscriptEvent[], labels: TranscriptLabels = transcriptLabelsKo): string {
  const blocks: string[] = [];
  for (const event of events) {
    if (event.kind === "user_msg") {
      const text = event.text?.trim() ?? "";
      const count = event.images?.length ?? 0;
      const imageLine = count > 0 ? labels.images(count) : "";
      const body = [text, imageLine].filter(Boolean).join("\n\n");
      if (body) blocks.push(`## ${labels.user}\n\n${body}`);
      continue;
    }
    if (event.kind !== "agent" || !event.events) continue;
    for (const piece of agentEventsOf(event as { events?: AgentEvent[] }) ?? []) {
      if (piece.type === "text_delta" || piece.type === "commands_available") continue;
      if ((piece.type === "text" || piece.type === "user_text") && piece.text?.trim()) {
        blocks.push(piece.type === "user_text" ? `## ${labels.user}\n\n${piece.text.trim()}` : piece.text.trim());
      } else if (piece.type === "tool_call") {
        blocks.push(labels.tool(piece.name?.trim() || "tool", piece.target?.trim() || undefined));
      }
    }
  }
  if (blocks.length === 0) return "";
  return `${blocks.join("\n\n")}\n`;
}
