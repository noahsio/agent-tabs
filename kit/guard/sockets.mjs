// Unix sockets of the decision service: JSON-lines framing, private paths, a one-shot client.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// sockaddr_un.sun_path is 104 bytes on macOS, one of them the terminating NUL.
export const MAX_SOCKET_PATH = 103;
// A service.lock younger than this belongs to a service that is starting (ruling P28).
export const LOCK_STARTING_MS = 10_000;
const MAX_LINE = 1024 * 1024;

/** The service's files under <agentDir>/guard/ (here, not in service.mjs, so clients never load the service). */
export function servicePaths(agentDir) {
  const dir = path.join(agentDir, "guard");
  return {
    dir,
    hookSock: path.join(dir, "hook.sock"),
    adminSock: path.join(dir, "admin.sock"),
    lock: path.join(dir, "service.lock"),
    rules: path.join(dir, "rules.json"),
    cache: path.join(dir, "cache.json"),
  };
}

export function checkSocketPath(file) {
  const bytes = Buffer.byteLength(file);
  if (bytes > MAX_SOCKET_PATH) throw new Error(`путь сокета длиннее ${MAX_SOCKET_PATH} байт (${bytes}): ${file}`);
}

/** Creates `dir` (and parents) and makes it 0700. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function writeLine(socket, value) {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(value)}\n`);
}

/** Calls onMessage(parsed | undefined) for every line; undefined = not JSON. Oversized input closes the socket. */
export function readLines(socket, onMessage) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) {
      socket.destroy();
      return;
    }
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      onMessage(message);
    }
  });
}

/** True when something accepts connections on the unix socket `file`. */
export function socketAlive(file) {
  return new Promise((resolve) => {
    const probe = net.createConnection(file);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * True while a decision service may own `<agentDir>/guard/rules.json`: one of its sockets answers, or its lock is fresh
 * (a service that is starting and has not listened yet). False only when no service runs: then the file is free to write.
 */
export async function serviceMayRun(agentDir) {
  const paths = servicePaths(agentDir);
  if ((await socketAlive(paths.adminSock)) || (await socketAlive(paths.hookSock))) return true;
  try {
    return Date.now() - fs.statSync(paths.lock).mtimeMs < LOCK_STARTING_MS;
  } catch {
    return false;
  }
}

/** Listens on `file` (0600). A stale file is unlinked; a live listener means another service owns it. */
export async function listen(file, onConnection) {
  checkSocketPath(file);
  if (fs.existsSync(file)) {
    if (await socketAlive(file)) throw new Error(`служба защиты уже запущена: ${file}`);
    fs.rmSync(file, { force: true });
  }
  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(file, 0o600);
  return server;
}

/** One request, the first reply line; rejects when the socket is absent or closes without a reply. */
export function request(file, message, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`нет ответа за ${timeoutMs} мс: ${file}`));
    }, timeoutMs);
    let replied = false;
    socket.on("connect", () => writeLine(socket, message));
    readLines(socket, (reply) => {
      if (replied) return;
      replied = true;
      clearTimeout(timer);
      socket.destroy();
      if (reply === undefined) reject(new Error(`ответ не JSON: ${file}`));
      else resolve(reply);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!replied) reject(new Error(`соединение закрыто без ответа: ${file}`));
    });
  });
}
