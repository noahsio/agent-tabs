import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FailureClass } from "../sessions/ladderFailure";
import { writeOmoFile } from "./files";
import { DEFAULT_LADDER } from "./ladderDefault";
import {
  ASK_LABEL,
  FAILURE_CLASSES,
  isFailureClass,
  LADDER_VERSION,
  migrateLadder,
  parseAction,
  parseLadder,
  type Ladder,
  type LadderRungView,
  type LadderSectionAction,
  type LadderSectionView,
  type Rung,
} from "./ladderShape";
import type { EnvPaths } from "./paths";
import type { RolesView } from "./roles";
import { FieldErrors, type SettingsSectionHost } from "./service";

/**
 * Where this environment's model ladder lives, and the settings section that edits it. Its shape — and the one
 * boundary check over it — is in `./ladderShape`, which the webview imports too and which therefore has no `node:`.
 */
export * from "./ladderShape";

const ROLLING = { backup: "rolling" as const };

/** This environment's ladder file: `<agentDir>/agent-tabs/ladder.json`, like every other per-environment plugin file. */
export function ladderFile(paths: EnvPaths): string {
  return path.join(paths.pluginDir, "ladder.json");
}

/**
 * This environment's ladder, brought up to the current shape; a missing, unreadable or unparseable file gives the
 * spec's default and never throws. Reading never writes — the migrated value is persisted by the next save, so a
 * window that only looks at the ladder leaves the person's file exactly as it found it.
 */
export function readLadder(paths: EnvPaths): Ladder {
  try {
    const stored = parseLadder(JSON.parse(fs.readFileSync(ladderFile(paths), "utf8")));
    return stored === undefined ? DEFAULT_LADDER : migrateLadder(stored);
  } catch {
    return DEFAULT_LADDER;
  }
}

export function writeLadder(paths: EnvPaths, ladder: Ladder): void {
  fs.mkdirSync(paths.pluginDir, { recursive: true });
  const stamped: Ladder = { version: LADDER_VERSION, rungs: ladder.rungs };
  writeOmoFile(ladderFile(paths), `${JSON.stringify(stamped, null, 2)}\n`, ROLLING);
}

// ---------- the settings section ----------

export interface LadderDeps {
  paths: EnvPaths;
  /** The same model options «Модели и роли» offers, grouped by connection. */
  models: () => Promise<RolesView["models"]>;
  /** The ladder changed: every open modal re-reads it, and the next failure walks the new one. */
  changed: () => void;
}

const TOP_IS_FIXED = "Первая ступенька — модель, с которой сессия начинает: её нельзя убрать, и отвечать ей не на что";
const NO_SUCH_RUNG = "Такой ступеньки больше нет — откройте настройки заново";

/**
 * «Лесенка моделей» on the host: the rungs of this environment's ladder, each with its action and the failures it
 * answers. Every action rewrites `<agentDir>/agent-tabs/ladder.json` whole, through the same rolling-backup write the
 * other sections use, and the walk reads that file fresh at every step.
 */
export class LadderHost implements SettingsSectionHost<LadderSectionAction> {
  readonly section = "ladder" as const;

  constructor(private readonly deps: LadderDeps) {}

  parse(raw: Record<string, unknown>): LadderSectionAction | undefined {
    const id = typeof raw["id"] === "string" && raw["id"] !== "" ? raw["id"] : undefined;
    switch (raw["kind"]) {
      case "rung.add":
      case "reset":
        return { kind: raw["kind"] };
      case "rung.remove":
        return id === undefined ? undefined : { kind: "rung.remove", id };
      case "rung.move": {
        const to = raw["to"];
        return id === undefined || typeof to !== "number" || !Number.isInteger(to) ? undefined : { kind: "rung.move", id, to };
      }
      case "rung.action": {
        const action = parseAction(raw["action"]);
        return id === undefined || action === undefined ? undefined : { kind: "rung.action", id, action };
      }
      case "rung.on": {
        const { failure, on } = raw;
        return id === undefined || !isFailureClass(failure) || typeof on !== "boolean" ? undefined : { kind: "rung.on", id, failure, on };
      }
      default:
        return undefined;
    }
  }

  async view(): Promise<LadderSectionView> {
    // A model list that will not load must not hide the ladder: the rungs show by id and nothing is called missing.
    const models = await this.deps.models().catch(() => []);
    const served = new Map(models.flatMap((group) => group.items.map((item) => [item.value, item.label] as const)));
    return {
      rungs: readLadder(this.deps.paths).rungs.map((rung) => {
        if (rung.action.kind === "ask") return { ...rung, label: ASK_LABEL };
        if (rung.action.kind === "text") return { ...rung, label: rung.action.text };
        const label = served.get(`${rung.action.provider}/${rung.action.id}`);
        return { ...rung, label: label ?? rung.action.id, ...(models.length > 0 && label === undefined ? { missing: true as const } : {}) };
      }),
      models,
    };
  }

  async perform(action: LadderSectionAction): Promise<void> {
    if (action.kind === "reset") {
      this.save(DEFAULT_LADDER);
      return;
    }
    const rungs = readLadder(this.deps.paths).rungs.slice();
    if (action.kind === "rung.add") {
      this.save({ rungs: [...rungs, { id: randomUUID().slice(0, 8), action: { kind: "ask" }, on: [] }] });
      return;
    }
    const at = rungs.findIndex((rung) => rung.id === action.id);
    if (at < 0) throw new FieldErrors(NO_SUCH_RUNG, []);
    switch (action.kind) {
      case "rung.remove":
        if (at === 0) throw new FieldErrors(TOP_IS_FIXED, []);
        rungs.splice(at, 1);
        break;
      case "rung.move": {
        // Clamped, not refused: dragging past either end is a gesture, not a mistake.
        const to = Math.min(Math.max(action.to, 0), rungs.length - 1);
        const [moved] = rungs.splice(at, 1);
        rungs.splice(to, 0, moved as Rung);
        break;
      }
      case "rung.action":
        rungs[at] = { ...(rungs[at] as Rung), action: action.action };
        break;
      case "rung.on": {
        if (at === 0) throw new FieldErrors(TOP_IS_FIXED, []);
        const rung = rungs[at] as Rung;
        const on = FAILURE_CLASSES.filter((failure) => (failure === action.failure ? action.on : rung.on.includes(failure)));
        rungs[at] = { ...rung, on };
        break;
      }
    }
    this.save({ rungs });
  }

  private save(ladder: Ladder): void {
    writeLadder(this.deps.paths, ladder);
    this.deps.changed();
  }
}
