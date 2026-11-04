#!/usr/bin/env node
// guardctl: answers the decision service from a terminal, over its admin socket (closed to the sandbox).
//   guardctl.mjs [--agent-dir <dir>] pending | allow <id> | deny <id>     (allow/deny confirm «да» on /dev/tty)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request, servicePaths } from "./sockets.mjs";
import { ttyConfirm } from "./tty.mjs";

const USAGE = "usage: guardctl [--agent-dir <dir>] pending | allow <id> | deny <id>";

/** io: { confirm(question) -> true | false | null (no terminal), out(line), err(line) }; resolves to the exit code. */
export async function guardctlMain(options, io = { confirm: ttyConfirm, out: console.log, err: console.error }) {
  const agentDir = options.agentDir || process.env.OMO_CODING_AGENT_DIR || path.join(os.homedir(), ".omo", "agent");
  const socket = servicePaths(agentDir).adminSock;
  const [command, id] = options.positional;
  if (command !== "pending" && command !== "allow" && command !== "deny") {
    io.err(USAGE);
    return 2;
  }
  let listed;
  try {
    listed = await request(socket, { op: "pending" });
  } catch (error) {
    io.err(`служба защиты не отвечает (${socket}): ${error?.message ?? error}`);
    return 1;
  }
  if (!Array.isArray(listed?.items)) {
    io.err(`служба защиты ответила ошибкой: ${listed?.error ?? JSON.stringify(listed)}`);
    return 1;
  }
  const items = listed.items;
  if (command === "pending") {
    if (items.length === 0) io.out("Открытых запросов нет.");
    for (const item of items) {
      const age = Math.round((Date.now() - Date.parse(item.createdAt)) / 1000);
      io.out(`${item.id}  ${age} с назад  ${item.cwd}`);
      io.out(`    ${String(item.command).slice(0, 300).replace(/\n/g, "\n    ")}`);
      if (item.code !== undefined) io.out(`    код eval:\n      ${String(item.code).slice(0, 300).replace(/\n/g, "\n      ")}`);
      io.out(`    причины: ${item.reasons.join("; ")}`);
      if (item.decider) io.out(`    решатель: ${item.decider.reason}`);
    }
    return 0;
  }
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    io.err(`Запрос ${JSON.stringify(id ?? "")} не найден среди открытых`);
    return 1;
  }
  const verb = command === "allow" ? "Разрешить один раз" : "Запретить";
  const code = item.code !== undefined ? `\n  код eval:\n  ${String(item.code).slice(0, 500)}` : "";
  const confirmed = io.confirm(`${verb}?\n  ${String(item.command).slice(0, 500)}${code}\n  (${item.cwd})\nВведите «да»: `);
  if (confirmed === null) {
    io.err("Нужен интерактивный терминал (/dev/tty): ответ должен ввести человек.");
    return 1;
  }
  if (!confirmed) {
    io.err("Отменено.");
    return 1;
  }
  const reply = await request(socket, { op: "answer", id, decision: command === "allow" ? "allow-once" : "deny", by: "cli" }).catch((error) => ({
    ok: false,
    error: error?.message ?? String(error),
  }));
  if (reply?.ok !== true) {
    io.err(`Запрос ${id} не отвечен: ${reply.error}`);
    return 1;
  }
  io.out(`${command === "allow" ? "Разрешено один раз" : "Запрещено"}: ${id}`);
  return 0;
}

function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const options = { agentDir: "", positional: [] };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--agent-dir") options.agentDir = argv[(index += 1)] ?? "";
    else options.positional.push(argv[index]);
  }
  process.exitCode = await guardctlMain(options);
}
