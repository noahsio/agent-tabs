import type { Block } from "./model";

const TOTAL_MAX = 12_000;
const NEWEST_MAX = 4_000;
const OLDER_MAX = 1_200;

type Message = { role: "user" | "assistant"; text: string };

/** The person's words keep their start (the ask); a reply keeps its end, where it reports and asks back. */
function clip({ role, text }: Message, max: number): string {
  if (text.length <= max) return text;
  return role === "user" ? `${text.slice(0, max)}…` : `…${text.slice(-max)}`;
}

/**
 * The latest part of a conversation, as the next-message guess reads it: the person's messages and the agent's replies
 * (never a tool's input or output), oldest first, each in a <user> or <assistant> tag; a turn's texts between its tool
 * calls are one reply. The newest message keeps up to 4 000 characters, each older one up to 1 200, and older ones stop
 * coming once 12 000 are taken. Undefined unless the conversation ends with a reply to a message of the person's.
 */
export function recentConversation(blocks: readonly Block[]): string | undefined {
  const messages: Message[] = [];
  for (const block of blocks) {
    if ((block.kind !== "user" && block.kind !== "assistant") || block.text.trim() === "") continue;
    const last = messages[messages.length - 1];
    if (last?.role === block.kind) last.text = `${last.text}\n\n${block.text.trim()}`;
    else messages.push({ role: block.kind, text: block.text.trim() });
  }
  if (messages[messages.length - 1]?.role !== "assistant" || !messages.some((message) => message.role === "user")) return undefined;
  const taken: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Message;
    const text = clip(message, index === messages.length - 1 ? NEWEST_MAX : OLDER_MAX);
    if (taken.length >= 2 && total + text.length > TOTAL_MAX) break;
    taken.unshift(`<${message.role}>\n${text}\n</${message.role}>`);
    total += text.length;
  }
  return `<conversation>\n${taken.join("\n")}\n</conversation>`;
}
