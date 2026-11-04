/**
 * OmO's end-of-turn hand-off block ("Ask / For you / Now / Next"), recognised with OmO 5.1.59's own rules
 * (`splitHandoffBlocks` / `parseHandoff` in its binary), so the feed shows what its TUI shows.
 *
 * Rules mirrored: the text is split into paragraphs on blank lines; a paragraph is a hand-off when its labels
 * (Ask, wanted, For you, You need, Now, Next - case-sensitive, optional ** around, ASCII or full-width colon,
 * found anywhere in the paragraph) read exactly `Ask,wanted,For you,Now,Next` or `Ask,For you,Now,Next` with
 * nothing before the first label, or `You need,Now,Next` with the outcome text before it. Paragraphs inside a
 * code fence (a line starting with ``` or ~~~ toggles it; a paragraph holding a fence marker never matches)
 * are never parsed. Slots are the text between a label and the next one, trimmed, with a trailing " -" removed.
 */

export type Handoff = {
  kind: "handoff";
  ask?: string;
  wanted?: string;
  /** "For you" (or, in the `You need` shape, the outcome followed by the needs). */
  answer?: string;
  now?: string;
  next?: string;
};
export type HandoffSegment = { kind: "text"; text: string } | Handoff;

const LABEL = /(?:\*{1,2})?\b(Ask|wanted|For you|You need|Now|Next)(?:\*{1,2})?\s*[:：](?:\*{1,2})?/gu;
const CLAUDE_SHAPES = ["Ask,wanted,For you,Now,Next", "Ask,For you,Now,Next"];
const GPT_SHAPE = "You need,Now,Next";

type Hit = { label: string; start: number; end: number };

function labelsOf(paragraph: string): Hit[] {
  return [...paragraph.matchAll(LABEL)].map((match) => ({
    label: match[1] ?? "",
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function slot(paragraph: string, hits: Hit[], label: string): string | undefined {
  const at = hits.findIndex((hit) => hit.label === label);
  if (at < 0) return undefined;
  const from = hits[at]?.end ?? 0;
  const to = hits[at + 1]?.start ?? paragraph.length;
  const text = paragraph.slice(from, to).trim().replace(/\s+-$/u, "");
  return text === "" ? undefined : text;
}

function parseHandoff(paragraph: string): Handoff | undefined {
  const hits = labelsOf(paragraph);
  const shape = hits.map((hit) => hit.label).join(",");
  const before = paragraph.slice(0, hits[0]?.start ?? 0).trim();
  const block: Handoff = { kind: "handoff", now: slot(paragraph, hits, "Now"), next: slot(paragraph, hits, "Next") };
  if (CLAUDE_SHAPES.includes(shape)) {
    if (before !== "") return undefined;
    return { ...block, ask: slot(paragraph, hits, "Ask"), wanted: slot(paragraph, hits, "wanted"), answer: slot(paragraph, hits, "For you") };
  }
  if (shape !== GPT_SHAPE || before === "") return undefined;
  const needs = slot(paragraph, hits, "You need");
  return { ...block, answer: needs === undefined ? before : `${before} ${needs}` };
}

/** The message as text and hand-off segments, or undefined when it holds no hand-off (render it as before). */
export function splitHandoff(text: string): HandoffSegment[] | undefined {
  const parts = text.split(/(\n[ \t]*\n)/u); // even indexes: paragraphs, odd: their blank-line separators
  const segments: HandoffSegment[] = [];
  let prose = "";
  let inFence = false;
  let found = false;
  const flush = (): void => {
    if (prose.trim() !== "") segments.push({ kind: "text", text: prose.trim() });
    prose = "";
  };
  for (let index = 0; index < parts.length; index += 2) {
    const paragraph = parts[index] ?? "";
    const separator = parts[index + 1] ?? "";
    const fences = paragraph.match(/^\s*(?:```|~~~)/gmu)?.length ?? 0;
    const handoff = !inFence && fences === 0 ? parseHandoff(paragraph.trim()) : undefined;
    if (fences % 2 === 1) inFence = !inFence;
    if (handoff === undefined) {
      prose += paragraph + separator;
      continue;
    }
    found = true;
    flush();
    segments.push(handoff);
  }
  flush();
  return found ? segments : undefined;
}

/** A card row with nothing to say: empty, or just "none" / "нет". */
export function isNone(value: string | undefined): boolean {
  if (value === undefined) return true;
  return /^(?:none|нет)?[\s.!;,]*$/iu.test(value.trim());
}
