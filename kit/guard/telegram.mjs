// Optional Telegram answerer. Per environment: the bot token in `<agentDir>/keys/telegram.key`, the chat (and optional
// user) in the rules (`human.telegramChat`, `human.telegramUser`). Without a key file: the supervisor bot's tg.env
// (TG_BOT_TOKEN, TG_CHAT_ID, optional TG_USER_ID), as before.
// Buttons carry `ag:a:<id>` / `ag:d:<id>`; a press in the configured chat (by the configured user, if set)
// becomes an answer to the decision service. The command text is sent to Telegram (a third party).
// Updates of other bot users (the supervisor daemon's `a:`/`d:` callbacks) are never confirmed by our offset.
// The token is never logged: errors are reduced to their name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TG_ENV = path.join(os.homedir(), ".claude", "skills", "supervisor", "tg.env");
const CALLBACK_RE = /^ag:([ad]):([0-9a-f]{12})$/;

/** {token, chatId, userId?} from a supervisor tg.env, or null when absent/incomplete. */
export function loadTelegramConfig(file = DEFAULT_TG_ENV) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const values = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const equals = line.indexOf("=");
    if (!line || line.startsWith("#") || equals < 0) continue;
    values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  if (!values.TG_BOT_TOKEN || !values.TG_CHAT_ID) return null;
  const config = { token: values.TG_BOT_TOKEN, chatId: values.TG_CHAT_ID };
  if (values.TG_USER_ID) config.userId = values.TG_USER_ID;
  return config;
}

/** Where an environment keeps its bot token (the keys dir: 0700, closed to agents' writes). */
export function telegramKeyFile(agentDir) {
  return path.join(agentDir, "keys", "telegram.key");
}

function readToken(file) {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * {token, chatId, userId?} or null. A key file makes the environment's own setting the only one (its chat from `human`,
 * never half of tg.env); without one, the tg.env.
 */
export function resolveTelegramConfig({ keyFile, tgEnvPath, human }) {
  const token = readToken(keyFile);
  if (token === undefined) return loadTelegramConfig(tgEnvPath);
  if (typeof human?.telegramChat !== "string" || human.telegramChat === "") return null;
  return { token, chatId: human.telegramChat, ...(typeof human.telegramUser === "string" && human.telegramUser ? { userId: human.telegramUser } : {}) };
}

/** The most recent private chat that wrote to the bot, from a getUpdates result: {chatId, userId} or undefined. */
export function latestPrivateChat(updates) {
  for (const update of [...(Array.isArray(updates) ? updates : [])].reverse()) {
    const message = update?.message;
    if (message?.chat?.type !== "private" || message.chat.id === undefined) continue;
    return { chatId: String(message.chat.id), userId: String(message.from?.id ?? message.chat.id) };
  }
  return undefined;
}

export function httpTransport(token, fetchFn = fetch) {
  return async (method, params, timeoutMs = 10_000) => {
    try {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, timeoutMs))),
      });
      return await response.json();
    } catch (error) {
      return { ok: false, error: error?.name ?? "error" };
    }
  };
}

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** transport(method, params, timeoutMs) -> Telegram JSON reply; injectable for tests. */
export function createTelegram(config, transport = httpTransport(config.token)) {
  let offset;
  const handled = new Set();
  return {
    async sendRequest(request, timeoutMs) {
      const lines = [
        `<b>Решатель просит подтверждения</b> · <code>${escapeHtml(path.basename(request.cwd || "") || "?")}</code>`,
        `<pre>${escapeHtml(truncate(request.command, 1800))}</pre>`,
        `Причина: ${escapeHtml(truncate(request.reasons.join("; "), 400))}`,
      ];
      if (request.decider_reason) lines.push(`Решатель: ${escapeHtml(truncate(request.decider_reason, 300))}`);
      const reply = await transport("sendMessage", {
        chat_id: config.chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Разрешить один раз", callback_data: `ag:a:${request.id}` },
            { text: "Запретить", callback_data: `ag:d:${request.id}` },
          ]],
        },
      }, timeoutMs);
      return Boolean(reply?.ok);
    },

    /**
     * One short poll: answers our callbacks; advances the offset only over updates nobody else needs.
     * `answer`: `(id, "allow" | "deny") -> boolean` (false: already answered; first answer wins).
     */
    async pollOnce(answer, timeoutMs) {
      const reply = await transport("getUpdates", { offset, timeout: 0, allowed_updates: ["callback_query"] }, timeoutMs);
      if (!reply?.ok || !Array.isArray(reply.result)) return;
      let confirmable = true;
      for (const update of reply.result) {
        const data = update?.callback_query?.data;
        const match = typeof data === "string" ? CALLBACK_RE.exec(data) : null;
        const query = update?.callback_query;
        const fromConfiguredChat =
          String(query?.message?.chat?.id) === String(config.chatId) && (!config.userId || String(query?.from?.id) === String(config.userId));
        if (match && fromConfiguredChat && !handled.has(update.update_id)) {
          handled.add(update.update_id);
          const written = answer(match[2], match[1] === "a" ? "allow" : "deny");
          await transport("answerCallbackQuery", { callback_query_id: query.id, text: written ? "Принято" : "Уже отвечено" }, timeoutMs);
        }
        if (!match && update?.callback_query) confirmable = false;
        if (confirmable) offset = update.update_id + 1;
      }
    },
  };
}
