import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientProof, serverProof } from "../../src/rpc/auth";

describe("socket auth proofs", () => {
  const key = Buffer.from("ab".repeat(32), "hex");

  it("proofs_match_known_vector", () => {
    const expectedServer = createHmac("sha256", key).update("senpi-rpc-server\nL1\nCN\nSN", "utf8").digest("hex");
    const expectedClient = createHmac("sha256", key).update("senpi-rpc-client\nL1\nSN\nCN", "utf8").digest("hex");
    expect(serverProof(key, "L1", "CN", "SN")).toBe(expectedServer);
    expect(clientProof(key, "L1", "SN", "CN")).toBe(expectedClient);
    expect(expectedServer).not.toBe(expectedClient);
  });
});
