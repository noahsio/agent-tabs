import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  excerpt,
  forkAvailability,
  MessageActions,
  rewindAvailability,
  rewoundNotice,
  type ActionsController,
} from "../../src/panel/messageActions";
import { Checkpointer } from "../../src/rewind/checkpointer";
import type { Entry } from "../../src/rewind/edits";
import type { ForkDraft } from "../../src/rewind/fork";
import type { RewoundMessage } from "../../src/panel/protocol";
import { takeSnapshot } from "../../src/rewind/snapshot";
import { CheckpointStore, type CheckpointPoint } from "../../src/rewind/store";
import { makeRepo } from "../helpers/gitRepo";

const user = (id: string, parentId: string | null, text: string, clientMessageId: string): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: [{ type: "text", text }], clientMessageId, timestamp: 1 },
});
const writes = (id: string, parentId: string, paths: string[]): Entry[] => [
  {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: paths.map((path, index) => ({ type: "toolCall", id: `${id}-${index}`, name: "write", arguments: { path, content: "" } })) },
  },
  ...paths.map((path, index) => ({
    type: "message",
    id: `${id}-r${index}`,
    parentId: index === 0 ? id : `${id}-r${index - 1}`,
    message: { role: "toolResult", toolCallId: `${id}-${index}`, toolName: "write", isError: false },
  })),
];

describe("message actions", () => {
  let repo: string;
  let realRepo: string;
  let store: CheckpointStore;
  let checkpointer: Checkpointer;
  let entries: Entry[];
  let leafId: string | null;
  let running: boolean;
  let liveCwds: string[];
  let noted: [string, string][];
  let opened: [string, ForkDraft | undefined][];
  let agentFilesAtFork: boolean[];
  let sessionPath: string;
  let actions: MessageActions;

  beforeEach(async () => {
    repo = await makeRepo({ "keep.txt": "k" });
    realRepo = realpathSync(repo);
    const agentDir = mkdtempSync(join(tmpdir(), "agent-tabs-actions-"));
    store = new CheckpointStore(agentDir);
    checkpointer = new Checkpointer({ store, agentDir });
    const point = async (clientMessageId: string): Promise<void> => {
      const id = `p-${clientMessageId}`;
      const { commit, skipped } = await takeSnapshot(realRepo, id);
      await store.append("s1", [{ type: "point", id, clientMessageId, repo: realRepo, commit, skipped, at: Date.now() }]);
    };
    // turn 1: the agent writes x; turn 2: the agent writes y and z
    await point("c1");
    writeFileSync(join(repo, "x"), "x1");
    await point("c2");
    mkdirSync(join(repo, "ro"));
    writeFileSync(join(repo, "y"), "y");
    writeFileSync(join(repo, "ro/z"), "z");
    entries = [
      { type: "model_change", id: "m0", parentId: null },
      user("u1", "m0", "First", "c1"),
      ...writes("a1", "u1", ["x"]),
      user("u2", "a1-r0", "Fix the bug\nsecond line", "c2"),
      ...writes("a2", "u2", ["y", "ro/z"]),
      user("u3", "a1-r0", "other branch", "c3"),
    ];
    leafId = "a2-r1";
    running = false;
    liveCwds = [];
    noted = [];
    opened = [];
    agentFilesAtFork = [];
    const sessions = mkdtempSync(join(tmpdir(), "agent-tabs-sessions-"));
    sessionPath = join(sessions, "2026-11-04T09-00-00-000Z_s1.jsonl");
    writeFileSync(sessionPath, [{ type: "session", version: 3, id: "s1", cwd: realRepo }, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const controller: ActionsController = {
      cwd: repo,
      sessionUuid: "s1",
      get state() {
        return { running } as ActionsController["state"];
      },
      tabState: { modelMode: "auto", sessionPath },
      journal: async () => ({ entries, leafId }),
      note: (level, text) => noted.push([level, text]),
    };
    actions = new MessageActions({
      controller,
      checkpointer,
      runningCwds: async () => liveCwds,
      openFork: (path, draft) => {
        opened.push([path, draft]);
        agentFilesAtFork.push(existsSync(join(repo, "y")) || existsSync(join(repo, "ro/z")));
      },
    });
  });

  /** What the confirmation does: preview, then rewind with the preview's fingerprint. */
  async function confirmed(blockId: string, fork: boolean): Promise<RewoundMessage> {
    const preview = await actions.preview(blockId, fork);
    return (await actions.rewind(blockId, fork, preview.ok ? preview.fingerprint : "none")).rewound;
  }

  it("availability_reasons_in_order", () => {
    const point: CheckpointPoint = { id: "p", clientMessageId: "c", repo: "/r", commit: "abc", skipped: [], at: 1 };
    expect(rewindAvailability({ repo: undefined, sent: "steer", point: undefined, snapshotExists: false, busy: true })).toEqual({ ok: false, reason: "Откат кода работает только в git-проекте" });
    expect(rewindAvailability({ repo: "/r", sent: "steer", point: undefined, snapshotExists: false, busy: true })).toEqual({ ok: false, reason: "Для сообщения, отправленного во время работы, откат недоступен" });
    expect(rewindAvailability({ repo: "/r", sent: undefined, point, snapshotExists: false, busy: true })).toEqual({ ok: false, reason: "Снимок не сохранился" });
    expect(rewindAvailability({ repo: "/r", sent: undefined, point: undefined, snapshotExists: false, busy: false })).toEqual({ ok: false, reason: "Снимок не сохранился" });
    expect(rewindAvailability({ repo: "/r", sent: undefined, point, snapshotExists: true, busy: true })).toEqual({ ok: false, reason: "Дождитесь конца хода" });
    expect(rewindAvailability({ repo: "/r", sent: undefined, point, snapshotExists: true, busy: false })).toEqual({ ok: true });
    expect(forkAvailability(true)).toEqual({ ok: false, reason: "Дождитесь конца хода" });
    expect(forkAvailability(false)).toEqual({ ok: true });
  });

  it("excerpt_is_the_first_non_empty_line_up_to_40_characters", () => {
    expect(excerpt("\n  \nFix the bug\nmore")).toBe("Fix the bug");
    expect(excerpt("x".repeat(41))).toBe(`${"x".repeat(40)}…`);
    expect(excerpt("x".repeat(40))).toBe("x".repeat(40));
  });

  it("menu_answers_both_availabilities", async () => {
    expect(await actions.menu("c2")).toEqual({ type: "messageActions", blockId: "c2", fork: { ok: true }, rewind: { ok: true } });
    expect((await actions.menu("u:5")).rewind).toEqual({ ok: false, reason: "Снимок не сохранился" });
  });

  it("rewind_is_busy_when_another_live_session_in_the_same_repo_runs", async () => {
    liveCwds = [join(repo, "sub")];
    const menu = await actions.menu("c2");
    expect(menu.rewind).toEqual({ ok: false, reason: "Дождитесь конца хода" });
    expect(menu.fork).toEqual({ ok: true });
    liveCwds = [mkdtempSync(join(tmpdir(), "other-"))];
    expect((await actions.menu("c2")).rewind).toEqual({ ok: true });
  });

  it("fork_is_busy_only_while_its_own_session_runs", async () => {
    running = true;
    expect((await actions.menu("c2")).fork).toEqual({ ok: false, reason: "Дождитесь конца хода" });
    expect(await actions.fork("c2")).toEqual({ ok: false, reason: "Дождитесь конца хода" });
    expect(await actions.forkSession()).toEqual({ ok: false, reason: "Дождитесь конца хода" });
    expect(opened).toEqual([]);
  });

  it("fork_session_takes_the_active_branch_up_to_the_leaf_and_every_checkpoint_on_it", async () => {
    expect(await actions.forkSession()).toEqual({ ok: true });
    const [[path, draft]] = opened as [[string, ForkDraft | undefined]];
    expect(draft).toBeUndefined();
    const [head, ...lines] = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as { id: string; parentSession?: string });
    expect(head?.parentSession).toBe(sessionPath);
    expect(lines.map((entry) => entry.id)).toEqual(["m0", "u1", "a1", "a1-r0", "u2", "a2", "a2-r0", "a2-r1"]);
    expect([...(await store.read(head?.id as string)).points.keys()]).toEqual(["c1", "c2"]);
  });

  it("fork_session_of_a_session_without_messages_is_refused", async () => {
    leafId = null;
    expect(await actions.forkSession()).toEqual({ ok: false, reason: "В сессии ещё нет сообщений" });
    leafId = "not-written-yet";
    expect(await actions.forkSession()).toMatchObject({ ok: false });
    expect(opened).toEqual([]);
  });

  it("preview_lists_items_from_the_active_branch_after_the_point", async () => {
    expect(await actions.preview("c2", false)).toEqual({
      type: "rewindPreview",
      blockId: "c2",
      fork: false,
      excerpt: "Fix the bug",
      ok: true,
      fingerprint: expect.any(String),
      items: [
        { path: "y", action: "delete", changed: "unknown" },
        { path: "ro/z", action: "delete", changed: "unknown" },
      ],
    });
    const first = await actions.preview("c1", true);
    expect(first.ok && first.items.map((item) => item.path)).toEqual(["x", "y", "ro/z"]);
  });

  it("message_off_the_active_branch_cannot_be_rewound", async () => {
    leafId = "u3";
    expect(await actions.preview("c2", false)).toMatchObject({ ok: false, reason: "Сообщение не в текущей ветке разговора" });
    expect((await actions.rewind("c2", false, "x")).rewound).toMatchObject({ ok: false, reason: "Сообщение не в текущей ветке разговора" });
    expect(existsSync(join(repo, "y"))).toBe(true);
  });

  it("rewind_applies_records_after_hashes_and_adds_the_notice", async () => {
    const result = await confirmed("c2", false);
    expect(result).toEqual({ type: "rewound", blockId: "c2", ok: true, count: 2 });
    expect(noted).toEqual([["info", "Откатили 2 файла к сообщению «Fix the bug»"]]);
    expect((await store.read("s1")).after.get(join(realRepo, "y"))).toBeNull();
    expect(existsSync(join(repo, "y"))).toBe(false);
    expect(readFileSync(join(repo, "x"), "utf8")).toBe("x1");
    expect(opened).toEqual([]);
  });

  it("notice_uses_russian_plural_forms", () => {
    expect([1, 2, 5, 11, 21, 22, 112].map((count) => rewoundNotice(count, "x"))).toEqual([
      "Откатили 1 файл к сообщению «x»",
      "Откатили 2 файла к сообщению «x»",
      "Откатили 5 файлов к сообщению «x»",
      "Откатили 11 файлов к сообщению «x»",
      "Откатили 21 файл к сообщению «x»",
      "Откатили 22 файла к сообщению «x»",
      "Откатили 112 файлов к сообщению «x»",
    ]);
  });

  it("rewind_refuses_when_a_turn_started_after_the_preview", async () => {
    const preview = await actions.preview("c2", false);
    running = true;
    expect((await actions.rewind("c2", false, preview.ok ? preview.fingerprint : "")).rewound).toEqual({ type: "rewound", blockId: "c2", ok: false, reason: "Дождитесь конца хода" });
    expect(existsSync(join(repo, "y"))).toBe(true);
  });

  it("fork_and_rewind_forks_only_after_a_successful_rewind", async () => {
    chmodSync(join(repo, "ro"), 0o555);
    try {
      const failed = await confirmed("c2", true);
      expect(failed).toMatchObject({ ok: false });
      expect(!failed.ok && failed.reason).toContain("y");
      expect(!failed.ok && failed.reason).toContain("ro/z");
      expect(opened).toEqual([]);
      expect((await store.read("s1")).after.get(join(realRepo, "y"))).toBeNull(); // what went through is recorded
    } finally {
      chmodSync(join(repo, "ro"), 0o755);
    }
    expect(await confirmed("c2", true)).toMatchObject({ ok: true });
    expect(opened).toHaveLength(1);
    expect(agentFilesAtFork).toEqual([false]);
  });

  it("fork_writes_the_file_copies_checkpoints_and_opens_a_tab_with_the_draft", async () => {
    expect(await actions.fork("c2")).toEqual({ ok: true });
    const [[path, draft]] = opened as [[string, ForkDraft]];
    expect(draft).toEqual({ text: "Fix the bug\nsecond line", images: [] });
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0] as string) as { id: string; parentSession: string };
    expect(header.parentSession).toBe(sessionPath);
    const copied = await store.read(header.id);
    expect([...copied.points.keys()]).toEqual(["c1"]);
    expect(await actions.fork("nope")).toEqual({ ok: false, reason: "Сообщение не найдено в журнале сессии" });
  });

  it("the_menu_and_preview_answer_even_when_live_sessions_cannot_be_listed", async () => {
    const failing = new MessageActions({
      controller: { cwd: repo, sessionUuid: "s1", state: { running: false } as ActionsController["state"], tabState: { modelMode: "auto", sessionPath }, journal: async () => ({ entries, leafId }), note: () => undefined },
      checkpointer,
      runningCwds: () => Promise.reject(new Error("not connected")),
      openFork: () => undefined,
    });
    const reason = "Не удалось проверить, не идёт ли ход в другой сессии этого проекта";
    expect((await failing.menu("c2")).rewind).toEqual({ ok: false, reason });
    expect(await failing.preview("c2", false)).toMatchObject({ ok: false, reason });
  });

  it("a_file_edited_while_the_confirmation_is_open_is_not_overwritten", async () => {
    const preview = await actions.preview("c2", false);
    writeFileSync(join(repo, "y"), "the person's edit");
    const { rewound, preview: fresh } = await actions.rewind("c2", false, preview.ok ? preview.fingerprint : "");
    expect(rewound).toEqual({ type: "rewound", blockId: "c2", ok: false, reason: "Файлы изменились — проверьте список ещё раз" });
    expect(readFileSync(join(repo, "y"), "utf8")).toBe("the person's edit");
    expect(fresh).toMatchObject({ type: "rewindPreview", blockId: "c2", ok: true });
    expect(fresh?.ok && fresh.fingerprint).not.toBe(preview.ok && preview.fingerprint);
    expect(noted).toEqual([]);
  });

  it("a_new_agent_edit_after_the_preview_stops_the_rewind", async () => {
    const preview = await actions.preview("c2", false);
    writeFileSync(join(repo, "w"), "w");
    entries = [...entries.slice(0, -1), ...writes("a3", "a2-r1", ["w"]), entries[entries.length - 1] as Entry];
    leafId = "a3-r0";
    const { rewound, preview: fresh } = await actions.rewind("c2", false, preview.ok ? preview.fingerprint : "");
    expect(rewound.ok).toBe(false);
    expect(existsSync(join(repo, "y"))).toBe(true);
    expect(existsSync(join(repo, "w"))).toBe(true);
    expect(fresh?.ok && fresh.items.map((item) => item.path)).toEqual(["y", "ro/z", "w"]);
  });

  it("a_failing_log_read_answers_with_its_reason", async () => {
    const broken = new MessageActions({
      controller: { cwd: repo, sessionUuid: "bad/id", state: { running: false } as ActionsController["state"], tabState: { modelMode: "auto", sessionPath }, journal: async () => ({ entries, leafId }), note: () => undefined },
      checkpointer,
      runningCwds: async () => [],
      openFork: () => undefined,
    });
    expect((await broken.menu("c2")).rewind).toMatchObject({ ok: false });
    expect(await broken.preview("c2", false)).toMatchObject({ ok: false });
    expect((await broken.rewind("c2", false, "x")).rewound).toMatchObject({ ok: false });
  });
});
