import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { createTelegram, latestPrivateChat, loadTelegramConfig, resolveTelegramConfig, telegramKeyFile } from "../../kit/guard/telegram.mjs";
import { makeTmp } from "./helpers";

/** Records answers like the service does: first answer wins. */
function answers() {
  const given = new Map<string, string>();
  const answer = (id: string, decision: string) => (given.has(id) ? false : (given.set(id, decision), true));
  return { given, answer };
}

describe("telegram", () => {
  it("reads the supervisor tg.env; absent config -> disabled", () => {
    const dir = makeTmp("omo-tg-");
    const file = path.join(dir, "tg.env");
    expect(loadTelegramConfig(file)).toBeNull();
    fs.writeFileSync(file, "# c\nTG_BOT_TOKEN='123:abc'\nTG_CHAT_ID=42\nTG_TIMEOUT=300\n");
    expect(loadTelegramConfig(file)).toEqual({ token: "123:abc", chatId: "42" });
    fs.writeFileSync(file, "TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=42\nTG_USER_ID=7\n");
    expect(loadTelegramConfig(file)).toEqual({ token: "123:abc", chatId: "42", userId: "7" });
    fs.writeFileSync(file, "TG_BOT_TOKEN=\n");
    expect(loadTelegramConfig(file)).toBeNull();
  });

  it("sends a request with buttons and turns a callback into an answer (fake transport)", async () => {
    const calls: { method: string; params: any }[] = [];
    let updates: any[] = [];
    const transport = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "getUpdates") return { ok: true, result: updates.filter((update) => update.update_id >= (params.offset ?? 0)) };
      return { ok: true, result: { message_id: 7 } };
    };
    const telegram = createTelegram({ token: "123:abc", chatId: "42" }, transport);
    await telegram.sendRequest({ id: "abc123abc123", cwd: "/work/proj", command: "git push <x>", reasons: ["git-push: git push"], decider_reason: "ask" });
    const sent = calls.find((call) => call.method === "sendMessage")!;
    expect(sent.params.chat_id).toBe("42");
    expect(sent.params.text).toContain("git push &lt;x&gt;");
    expect(JSON.stringify(sent.params.reply_markup)).toContain("ag:a:abc123abc123");

    const press = (update_id: number, data: string, chat = 42) => ({
      update_id,
      callback_query: { id: `q${update_id}`, data, from: { id: chat }, message: { chat: { id: chat } } },
    });
    const { given, answer } = answers();
    updates = [press(10, "a:1"), press(11, "ag:a:abc123abc123")];
    await telegram.pollOnce(answer);
    expect(given.get("abc123abc123")).toBe("allow");
    // The supervisor's own callback (update 10) is never confirmed by our offset.
    await telegram.pollOnce(answer);
    const offsets = calls.filter((call) => call.method === "getUpdates").map((call) => call.params.offset ?? 0);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(10);
  });

  it("ignores presses from another chat or, when TG_USER_ID is set, another user", async () => {
    const updates = [
      { update_id: 1, callback_query: { id: "a", data: "ag:a:aaaaaaaaaaaa", from: { id: 5 }, message: { chat: { id: 99 } } } },
      { update_id: 2, callback_query: { id: "b", data: "ag:a:bbbbbbbbbbbb", from: { id: 5 }, message: { chat: { id: 42 } } } },
      { update_id: 3, callback_query: { id: "c", data: "ag:d:cccccccccccc", from: { id: 7 }, message: { chat: { id: 42 } } } },
    ];
    const transport = async (method: string) => (method === "getUpdates" ? { ok: true, result: updates } : { ok: true });
    const { given, answer } = answers();
    await createTelegram({ token: "t", chatId: "42", userId: "7" }, transport).pollOnce(answer);
    expect([...given.entries()]).toEqual([["cccccccccccc", "deny"]]);
  });
});

describe("telegram config per environment", () => {
  it("the_key_file_token_goes_with_the_chat_from_the_rules", () => {
    const agentDir = makeTmp("omo-tg-agent-");
    const tgEnv = path.join(agentDir, "tg.env");
    fs.writeFileSync(tgEnv, "TG_BOT_TOKEN=old:legacy\nTG_CHAT_ID=1\n");
    const keyFile = telegramKeyFile(agentDir);
    expect(keyFile).toBe(path.join(agentDir, "keys", "telegram.key"));
    // no key file: the supervisor's tg.env, as before
    expect(resolveTelegramConfig({ keyFile, tgEnvPath: tgEnv, human: { telegramChat: "42" } })).toEqual({ token: "old:legacy", chatId: "1" });
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, "123:new-token\n");
    expect(resolveTelegramConfig({ keyFile, tgEnvPath: tgEnv, human: { telegramChat: "42", telegramUser: "7" } })).toEqual({ token: "123:new-token", chatId: "42", userId: "7" });
    // a key without a chat is not a configuration (never half of tg.env)
    expect(resolveTelegramConfig({ keyFile, tgEnvPath: tgEnv, human: {} })).toBeNull();
  });

  it("the_latest_private_chat_that_wrote_to_the_bot_is_found", () => {
    const message = (update_id: number, chat: Record<string, unknown>, from = 7) => ({ update_id, message: { chat, from: { id: from }, text: "/start" } });
    expect(latestPrivateChat([])).toBeUndefined();
    expect(
      latestPrivateChat([
        message(1, { id: 100, type: "private" }, 100),
        message(2, { id: -5, type: "group" }),
        message(3, { id: 200, type: "private" }, 200),
        { update_id: 4, callback_query: { id: "x" } },
        message(5, { id: -6, type: "supergroup" }),
      ]),
    ).toEqual({ chatId: "200", userId: "200" });
  });
});
