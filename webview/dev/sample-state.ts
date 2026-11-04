import type { ModelInfo, SessionItem, StateMessage } from "../../src/panel/protocol";

/** Generic content mirroring docs/design/2026-11-03-chat-mockup-v3.html, for the dev harness only. */
export type Sample = { message: StateMessage; sessions: SessionItem[]; models: ModelInfo[] };

const MINUTE = 60_000;

/** A fixed state message, session list and model list; `now` anchors the relative times. */
export function createSample(now: number): Sample {
  const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 10, 3, hours, minutes, seconds).getTime();
  const models: ModelInfo[] = [
    { provider: "gw-anthropic", id: "claude-opus-5-5", name: "Opus 5.5" },
    { provider: "gw-anthropic", id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { provider: "gw-anthropic", id: "claude-haiku-5-5", name: "Haiku 5.5" },
    { provider: "gw-openai", id: "gpt-6-astra", name: "GPT 6 Astra" },
    { provider: "gw-openai", id: "gpt-6-1-sol", name: "GPT 6.1 Sol" },
    { provider: "gw-openai", id: "gpt-5-6-sol", name: "GPT 5.6 Sol" },
  ];
  const opus = { provider: "gw-anthropic", id: "claude-opus-5-5" };
  const message: StateMessage = {
    type: "state",
    reconnectable: true,
    tab: { modelMode: "auto", durableId: "d1" },
    models,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    commands: [
      { name: "reflect", description: "Разобрать прошлые ошибки и записать в память", source: "extension", syntax: "slash" },
      { name: "resume", description: "Продолжить прошлую сессию проекта", source: "extension", syntax: "slash" },
      { name: "review-work", description: "Ревью сделанной работы (навык OmO)", source: "extension", syntax: "slash" },
      { name: "skill:receiving-code-review", description: "из каталога навыков", source: "skill", syntax: "dollar" },
      { name: "release-checklist", description: "шаблон проекта · .omo/prompts", source: "prompt", syntax: "slash" },
    ],
    state: {
      blocks: [
        { kind: "user", id: "u1", text: "каталог иногда отдаёт пустой список после смены ноды — разберись и почини, ulw", timestamp: at(20, 10), images: [{ id: "u1:0", mimeType: "image/png", name: "screenshot.png" }] },
        { kind: "assistant", id: "a1", text: "", thinking: "…", streaming: false, thinkingMs: 4000, timestamp: at(20, 11) },
        { kind: "tool", id: "t1", name: "read", summary: "app/Sources/Launcher/CatalogService.swift", args: {}, output: "", truncated: false, state: "ok", timestamp: at(20, 11, 5) },
        { kind: "tool", id: "t2", name: "task", summary: "", args: {}, output: "", truncated: false, state: "ok", role: "explore", model: "Opus 5.5", description: "Найти, где пустой ответ ноды перезаписывает кэш", durationMs: 2 * MINUTE, timestamp: at(20, 11, 10) },
        { kind: "assistant", id: "a2", text: "Причина в `refetch()`: пустой `[]` от ноды после failover считается успехом и затирает кэш на диске.", thinking: "", streaming: false, timestamp: at(20, 11, 40) },
        { kind: "tool", id: "t3", name: "task", summary: "", args: {}, output: "", truncated: false, state: "running", role: "deep-high", model: "GPT 6 Astra", description: "Правка CatalogService.swift", timestamp: at(20, 11, 50) },
      ],
      dialogs: [],
      agents: [
        { id: "task:1", label: "Правка CatalogService.swift", role: "deep-high", activity: "пишет код · Edit CatalogService.swift", model: "GPT 6 Astra", status: "running", startedAt: now - 102_000, tokens: 200_800 },
        { id: "task:2", label: "Ревью плана", role: "plan-reviewer", activity: "проверяет шаги 2–4", model: "GPT 6 Astra", status: "running", startedAt: now - 31_000, tokens: 41_300 },
        { id: "task:3", label: "Поиск, где пустой ответ затирает кэш", role: "explore", activity: "готово · нашёл refetch() в CatalogService", model: "Opus 5.5", status: "done", startedAt: now - 5 * MINUTE, endedAt: now - 5 * MINUTE + 125_000, tokens: 58_100 },
        { id: "task:4", label: "Прогон тестов каталога", role: "quick", activity: "ждёт правку", model: "GPT 6 Astra", status: "waiting" },
      ],
      running: true,
      activity: "tool",
      activityTool: "task",
      title: "Кэш каталога: TTL и фоллбек",
      contextTokens: 754_900,
      autoModel: opus,
      model: opus,
      thinkingLevel: "xhigh",
    },
  };
  const session = (n: number, title: string, ago: number, extra: Partial<SessionItem> = {}): SessionItem => ({
    sessionPath: `/sessions/${n}.jsonl`,
    durableId: `d${n}`,
    title,
    updatedAt: now - ago,
    running: false,
    pinned: false,
    archived: false,
    current: false,
    ...extra,
  });
  const sessions = [
    session(1, "Кэш каталога: TTL и фоллбек", 10_000, { current: true }),
    session(2, "Миграция пулов на v2", 12 * MINUTE, { running: true }),
    session(3, "Ревью NodeProxy", 3 * 60 * MINUTE),
    session(4, "Почему падает InstanceManagerTests", 2 * 24 * 60 * MINUTE),
    session(5, "Старый эксперимент с кэшем", 9 * 24 * 60 * MINUTE, { archived: true }),
  ];
  return { message, sessions, models };
}

/** An SVG gradient as a data URL: stands in for a real screenshot in the harness. */
export function placeholderImage(from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="240" height="160" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
