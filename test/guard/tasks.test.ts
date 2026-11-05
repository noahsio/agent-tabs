import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRegistry } from "../../src/guard/tasks";

let dirs: string[] = [];

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "at-tasks-"));
  dirs.push(dir);
  return dir;
}

/** One of OmO's senpi-task records, as it writes them under the agent dir. */
function task(
  dir: string,
  project: string,
  fields: { task_id: string; child_session_id?: string; parent_session_id?: string; root_session_id?: string; depth?: number },
): void {
  const tasks = join(dir, "projects", project, "senpi-task", "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, `${fields.task_id}.json`), JSON.stringify({ status: "running", depth: 1, ...fields }));
}

/** The journal OmO keeps for a task's child session, by name only (the replay never opens it). */
function journal(dir: string, project: string, taskId: string, session: string): void {
  const holder = join(dir, "projects", project, "senpi-task", "children", taskId, "sessions", taskId);
  mkdirSync(holder, { recursive: true });
  writeFileSync(join(holder, `2026-11-05T09-30-27-938Z_${session}.jsonl`), "");
}

const UUID_A = "6f251c0d-2723-49e4-b58b-4444068f91a5";
const UUID_B = "7cd9c43f-f679-4072-88cf-9924b648814f";

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("TaskRegistry", () => {
  it("a_childs_request_resolves_to_the_session_that_spawned_it", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1", root_session_id: "root-1" });
    expect(new TaskRegistry(dir).rootOf("child-a")).toBe("root-1");
  });

  it("a_session_no_task_claims_resolves_to_nothing", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1", root_session_id: "root-1" });
    expect(new TaskRegistry(dir).rootOf("root-1")).toBeUndefined(); // a tab's own session is not a child
    expect(new TaskRegistry(dir).rootOf("a-terminal")).toBeUndefined();
  });

  it("a_grandchild_resolves_through_two_hops_when_no_root_is_recorded", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1" });
    task(dir, "proj-1", { task_id: "st_b", child_session_id: "grandchild-b", parent_session_id: "child-a", depth: 2 });
    expect(new TaskRegistry(dir).rootOf("grandchild-b")).toBe("root-1");
  });

  it("omos_own_root_session_id_is_taken_over_the_walk", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_b", child_session_id: "grandchild-b", parent_session_id: "child-a", root_session_id: "root-1", depth: 2 });
    expect(new TaskRegistry(dir).rootOf("grandchild-b")).toBe("root-1"); // the parent's record is not even needed
  });

  it("a_cycle_or_a_chain_without_end_resolves_to_nothing_instead_of_spinning", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "a", parent_session_id: "b" });
    task(dir, "proj-1", { task_id: "st_b", child_session_id: "b", parent_session_id: "a" });
    expect(new TaskRegistry(dir).rootOf("a")).toBeUndefined();
  });

  it("records_of_every_project_of_the_environment_are_read", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1", root_session_id: "root-1" });
    task(dir, "proj-2", { task_id: "st_b", child_session_id: "child-b", parent_session_id: "root-2", root_session_id: "root-2" });
    const registry = new TaskRegistry(dir);
    expect(registry.rootOf("child-a")).toBe("root-1");
    expect(registry.rootOf("child-b")).toBe("root-2");
  });

  it("the_two_agent_dirs_never_cross", () => {
    const system = agentDir();
    const portable = agentDir();
    task(system, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-system", root_session_id: "root-system" });
    task(portable, "proj-1", { task_id: "st_b", child_session_id: "child-b", parent_session_id: "root-portable", root_session_id: "root-portable" });
    expect(new TaskRegistry(system).rootOf("child-b")).toBeUndefined();
    expect(new TaskRegistry(portable).rootOf("child-a")).toBeUndefined();
  });

  it("a_missing_or_unreadable_registry_resolves_to_nothing_and_never_throws", () => {
    const empty = agentDir();
    expect(new TaskRegistry(join(empty, "nope")).rootOf("child-a")).toBeUndefined();
    const broken = agentDir();
    const tasks = join(broken, "projects", "proj-1", "senpi-task", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "st_a.json"), "{ not json");
    task(broken, "proj-1", { task_id: "st_b", child_session_id: "child-b", parent_session_id: "root-1", root_session_id: "root-1" });
    expect(new TaskRegistry(broken).rootOf("child-b")).toBe("root-1"); // the broken file is skipped, the rest still answers
  });

  it("a_task_written_after_the_first_miss_is_found_once_the_index_may_be_rebuilt", () => {
    const dir = agentDir();
    let clock = 1000;
    const registry = new TaskRegistry(dir, { staleMs: 100, now: () => clock });
    expect(registry.rootOf("child-a")).toBeUndefined();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1", root_session_id: "root-1" });
    expect(registry.rootOf("child-a")).toBeUndefined(); // within staleMs the index is reused, no new read
    clock += 101;
    expect(registry.rootOf("child-a")).toBe("root-1");
  });

  it("a_hit_is_answered_from_the_index_without_reading_the_registry_again", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1", root_session_id: "root-1" });
    let clock = 1000;
    const registry = new TaskRegistry(dir, { staleMs: 100, now: () => clock });
    expect(registry.rootOf("child-a")).toBe("root-1");
    const after = registry.reads;
    clock += 10_000; // long past stale: a hit still costs nothing
    expect(registry.rootOf("child-a")).toBe("root-1");
    expect(registry.reads).toBe(after);
  });

  it("a_session_the_record_no_longer_names_is_found_by_its_journal", () => {
    // OmO re-pointed child_session_id at a replacement; the session that asked still has its journal under the task.
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "the-replacement", parent_session_id: "root-1", root_session_id: "root-1" });
    journal(dir, "proj-1", "st_a", UUID_A);
    expect(new TaskRegistry(dir).rootOf(UUID_A)).toBe("root-1");
  });

  it("a_journal_whose_task_record_is_gone_resolves_to_nothing", () => {
    const dir = agentDir();
    journal(dir, "proj-1", "st_orphan", UUID_B);
    expect(new TaskRegistry(dir).rootOf(UUID_B)).toBeUndefined();
  });

  it("the_journal_names_are_read_only_when_the_records_miss_and_at_most_once_a_window", () => {
    const dir = agentDir();
    task(dir, "proj-1", { task_id: "st_a", child_session_id: "child-a", parent_session_id: "root-1", root_session_id: "root-1" });
    let clock = 1000;
    const registry = new TaskRegistry(dir, { staleMs: 10, layoutStaleMs: 1000, now: () => clock });
    expect(registry.rootOf("child-a")).toBe("root-1");
    expect(registry.layoutReads).toBe(0); // the records answered: the layout was never walked
    for (let i = 0; i < 5; i++) {
      clock += 50; // past staleMs every time, so the records are re-read…
      registry.rootOf(`unknown-${i}`);
    }
    expect(registry.reads).toBe(6);
    expect(registry.layoutReads).toBe(1); // …but the layout only once in its own window
  });

  it("a_burst_of_misses_reads_the_registry_once", () => {
    const dir = agentDir();
    let clock = 1000;
    const registry = new TaskRegistry(dir, { staleMs: 250, now: () => clock });
    for (let i = 0; i < 20; i++) registry.rootOf(`unknown-${i}`);
    expect(registry.reads).toBe(1);
  });
});
