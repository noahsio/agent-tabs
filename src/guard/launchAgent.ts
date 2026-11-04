import { createHash } from "node:crypto";
import path from "node:path";

/** One decision service per agent dir: the label names it by the agent dir as OmO is given it. */
export function serviceLabel(agentDir: string): string {
  return `local.agent-tabs.guard.${createHash("sha256").update(agentDir).digest("hex").slice(0, 8)}`;
}

export function launchAgentPath(home: string, label: string): string {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const string = (value: string): string => `<string>${xml(value)}</string>`;

/** The LaunchAgent that keeps the decision service (`node service.mjs --agent-dir <dir>`) running for the user. */
export function launchAgentPlist(spec: { label: string; node: string; serviceScript: string; agentDir: string; logFile: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${string(spec.label)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[spec.node, spec.serviceScript, "--agent-dir", spec.agentDir].map((arg) => `    ${string(arg)}`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  ${string(spec.logFile)}`,
    "  <key>StandardErrorPath</key>",
    `  ${string(spec.logFile)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
