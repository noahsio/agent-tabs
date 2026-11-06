import { existsSync, writeFileSync } from "node:fs";

/**
 * A scratch-host extension that kills one turn the way OmO's own machinery does.
 *
 * The in-process extension API's `abort(source)` is one of the three callers in the binary that pass provenance
 * `"system"` (the other two are the deadline tracker and compaction), and `before_provider_request` fires after the
 * payload is built and right before it is sent — after `responseTiming.requested()`. An abort from there therefore
 * leaves exactly the shape the person's journal shows: an assistant message with `stopReason: "aborted"`, no content,
 * `endedAt − requestedAt` of about a millisecond, and a `turn-end-liveness` entry whose verdict is
 * `{kind: "stalled", reason: "aborted", abortSource: "system"}`.
 *
 * Only the first request of the scratch agent dir is killed — the marker file outlives session reloads — so the one
 * resend that follows is answered, and the recovery can be watched end to end. `OMO_TEST_KILL_MARKER` names it — an
 * `OMO_*` name, because the host inherits only allowlisted variable names.
 */
export default function killFirstRequest(pi: any): void {
  pi.on("before_provider_request", (_event: unknown, ctx: any) => {
    const marker = process.env["OMO_TEST_KILL_MARKER"];
    if (marker === undefined || existsSync(marker)) return undefined;
    writeFileSync(marker, "killed\n");
    ctx.abort("system");
    return undefined;
  });
}
