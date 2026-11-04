import type { OutgoingImage } from "../sessions/controller";
import type { HostMessage, WebviewMessage } from "./protocol";

type Sender = { send(text: string, mode: "auto" | "followUp", images: OutgoingImage[], clientMessageId: string): Promise<boolean> };

/** Sends (the webview's id is the message's clientMessageId) and always answers: no session, a failed send and a throw all ack `ok: false`. */
export async function sendAndAck(
  controller: Sender | undefined,
  message: Extract<WebviewMessage, { type: "send" }>,
  ack: (reply: HostMessage) => void,
): Promise<void> {
  let ok = false;
  try {
    ok = controller !== undefined && (await controller.send(message.text, message.mode, message.images ?? [], message.id));
  } finally {
    ack({ type: "sent", id: message.id, ok });
  }
}
