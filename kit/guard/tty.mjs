// Terminal confirmation for human answers (the agent's tools have no controlling terminal).
import fs from "node:fs";

/** Asks on the controlling terminal; null when there is none (the agent's tools have no tty). */
export function ttyConfirm(question) {
  let descriptor;
  try {
    descriptor = fs.openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    fs.writeSync(descriptor, question);
    const bytes = [];
    const buffer = Buffer.alloc(1);
    while (fs.readSync(descriptor, buffer, 0, 1, null) === 1 && buffer[0] !== 0x0a) bytes.push(buffer[0]);
    return /^(y|yes|д|да)$/i.test(Buffer.from(bytes).toString("utf8").trim());
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}
