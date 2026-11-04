import { describe, expect, it, vi } from "vitest";
import type { HostMessage } from "../../src/panel/protocol";
import { sendAndAck } from "../../src/panel/send";

const message = { type: "send", id: "7", text: "hello", mode: "auto" } as const;

describe("sendAndAck", () => {
  it("acks_a_successful_send", async () => {
    const acks: HostMessage[] = [];
    await sendAndAck({ send: vi.fn(async () => true) }, message, (ack) => acks.push(ack));
    expect(acks).toEqual([{ type: "sent", id: "7", ok: true }]);
  });

  it("the_send_id_is_the_messages_client_id", async () => {
    const send = vi.fn(async () => true);
    await sendAndAck({ send }, { ...message, images: [{ mimeType: "image/png", data: "QUJD" }] }, () => undefined);
    expect(send).toHaveBeenCalledWith("hello", "auto", [{ mimeType: "image/png", data: "QUJD" }], "7");
  });

  it("a_throwing_send_is_still_acked_as_not_sent", async () => {
    const acks: HostMessage[] = [];
    const controller = { send: vi.fn(async (): Promise<boolean> => Promise.reject(new Error("socket gone"))) };
    await expect(sendAndAck(controller, message, (ack) => acks.push(ack))).rejects.toThrow("socket gone");
    expect(acks).toEqual([{ type: "sent", id: "7", ok: false }]);
  });

  it("no_session_is_acked_as_not_sent", async () => {
    const acks: HostMessage[] = [];
    await sendAndAck(undefined, message, (ack) => acks.push(ack));
    expect(acks).toEqual([{ type: "sent", id: "7", ok: false }]);
  });
});
