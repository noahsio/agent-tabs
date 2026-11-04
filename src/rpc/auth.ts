import { createHmac } from "node:crypto";

function proof(label: string, key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key)
    .update([label, ...parts].join("\n"), "utf8")
    .digest("hex");
}

/** Proof the server must present: HMAC(key, "senpi-rpc-server\n<launch>\n<clientNonce>\n<serverNonce>"). */
export function serverProof(
  key: Buffer,
  launchId: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return proof("senpi-rpc-server", key, [launchId, clientNonce, serverNonce]);
}

/** Proof the client must present: HMAC(key, "senpi-rpc-client\n<launch>\n<serverNonce>\n<clientNonce>"). */
export function clientProof(
  key: Buffer,
  launchId: string,
  serverNonce: string,
  clientNonce: string,
): string {
  return proof("senpi-rpc-client", key, [launchId, serverNonce, clientNonce]);
}
