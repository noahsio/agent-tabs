import { describe, expect, it } from "vitest";
import { RpcError } from "../../src/rpc/client";
import { classifyOpen, giveUpText, heldByAnotherHostCopy, holderFrom } from "../../src/sessions/refusal";

const SOCKET = "/Users/x/.cache/omo/guard/host/agent-tabs.sock";
const HOST = { socket: SOCKET, instance: "this-host" };

/** A `session_held` refusal shaped the way OmO 5.1.59 really sends it (measured live: host-race case r6). */
function held(holder: Record<string, unknown>): RpcError {
  return new RpcError("session_held", "session_held", { holders: [holder] });
}

describe("which side of the window a failed open belongs on", () => {
  it("a_path_the_previous_host_has_not_let_go_of_is_waited_out_on_the_line", () => {
    const error = new RpcError("session_path_in_use", "session path in use", { retry_after_ms: 2_000 });
    expect(classifyOpen(error, HOST)).toEqual({ kind: "retry", text: "Файл сессии ещё держит предыдущий хост OmO" });
  });

  it.each([
    ["session_closing", "Сессия ещё закрывается"],
    ["session_busy_lifecycle", "Сессия сейчас открывается или закрывается"],
    ["host_draining", "Хост OmO останавливается"],
    ["host_stopping", "Хост OmO останавливается"],
  ])("%s_is_waited_out_on_the_line", (code, text) => {
    expect(classifyOpen(new RpcError(code, "raw"), HOST)).toMatchObject({ kind: "retry", text });
  });

  it("a_file_held_by_another_copy_of_our_own_host_is_ours_to_wait_out_and_to_own_up_to", () => {
    const error = held({ pid: 46960, cwd: "/work", host_socket: SOCKET, host_instance: "the-other-copy" });
    const failure = classifyOpen(error, HOST);
    expect(failure).toMatchObject({ kind: "retry", text: "Файл сессии держит другая копия хоста OmO (pid 46960)" });
    expect(failure.kind === "retry" && failure.holder).toMatchObject({ pid: 46960, cwd: "/work", socket: SOCKET });
  });

  it("the_resolved_spelling_of_the_same_socket_is_the_same_socket", () => {
    const error = held({ pid: 7, host_socket: "/private/tmp/a/agent-tabs.sock", host_instance: "other" });
    expect(classifyOpen(error, { socket: "/tmp/a/agent-tabs.sock", instance: "this-host" })).toMatchObject({ kind: "retry" });
  });

  it("a_file_another_program_holds_is_the_persons_to_close_so_it_goes_to_the_banner", () => {
    const error = held({ pid: 51, cwd: "/elsewhere", host_socket: "/Users/x/.omo/agent/rpc/other.sock", host_instance: "stranger" });
    expect(classifyOpen(error, HOST)).toEqual({
      kind: "banner",
      text: "Файл сессии открыт другим процессом omo (pid 51, каталог /elsewhere) — закройте его",
    });
  });

  it.each([
    ["open_failed", "open_failed: model_unavailable: no such provider"],
    ["invalid_path", "relative sessionPath"],
    ["session_reservation_limit", "64 live session paths"],
    ["unknown_session", "unknown session"],
  ])("%s_will_not_change_by_itself_so_it_goes_to_the_banner", (code, message) => {
    expect(classifyOpen(new RpcError(code, message), HOST)).toEqual({ kind: "banner", text: message });
  });

  it("a_failure_that_is_not_the_hosts_answer_at_all_goes_to_the_banner", () => {
    expect(classifyOpen(new Error("ENOENT: no session file"), HOST)).toEqual({ kind: "banner", text: "ENOENT: no session file" });
  });
});

describe("telling another copy of the host apart from the one we talk to", () => {
  it("the_host_that_answered_is_never_the_holder_even_if_it_names_no_instance", () => {
    expect(heldByAnotherHostCopy({ socket: SOCKET }, HOST)).toBe(true); // a host never names itself as a holder
    expect(heldByAnotherHostCopy({ socket: SOCKET, instance: "this-host" }, HOST)).toBe(false);
    expect(heldByAnotherHostCopy({ socket: "/other.sock", instance: "x" }, HOST)).toBe(false);
    expect(heldByAnotherHostCopy(undefined, HOST)).toBe(false);
  });

  it("session_path_in_use_names_its_owner_by_instance", () => {
    const error = new RpcError("session_path_in_use", "in use", { owner: { pid: 31, instanceId: "older-generation", current: true }, retry_after_ms: 2_000 });
    expect(holderFrom(error, HOST)).toMatchObject({ pid: 31, instance: "older-generation" });
  });

  it("the_line_that_stopped_says_who_holds_the_file_and_that_asking_again_is_pointless", () => {
    const text = giveUpText({ pid: 46960, socket: SOCKET, instance: "other" }, HOST, "последняя ошибка");
    expect(text).toContain("другая копия хоста OmO (pid 46960)");
    expect(text).toContain("повторять бесполезно");
    // Nothing proven about a holder: the last failure is all there is to say, and it is said as it came.
    expect(giveUpText(undefined, HOST, "последняя ошибка")).toBe("последняя ошибка");
  });
});
