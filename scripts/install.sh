#!/bin/sh
# Builds, packages and installs the extension into the selected VS Code installation.
set -eu
cd "$(dirname "$0")/.."

if [ -n "${AGENT_TABS_CODE:-}" ]; then
  SYSTEM_CODE="$(command -v "$AGENT_TABS_CODE" || true)"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  SYSTEM_CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
else
  SYSTEM_CODE="$(command -v code || true)"
fi
if [ -z "$SYSTEM_CODE" ] || [ ! -x "$SYSTEM_CODE" ]; then echo "VS Code CLI not found; set AGENT_TABS_CODE" >&2; exit 1; fi
EXTENSION_ID="local.agent-tabs"
if [ -n "${AGENT_TABS_SECOND_VSCODE:-}" ]; then
  case "$AGENT_TABS_SECOND_VSCODE" in
    /*) SECOND_ROOT="$AGENT_TABS_SECOND_VSCODE" ;;
    *) SECOND_ROOT="$HOME/$AGENT_TABS_SECOND_VSCODE" ;;
  esac
  SECOND_CODE="$SECOND_ROOT/Visual Studio Code.app/Contents/Resources/app/bin/code"
  SECOND_DATA="$SECOND_ROOT/code-portable-data"
  [ -x "$SECOND_CODE" ] || { echo "VS Code CLI not found in AGENT_TABS_SECOND_VSCODE" >&2; exit 1; }
fi

npm ci
npm run build
rm -f agent-tabs-*.vsix
npm run package
VSIX="$(ls -t agent-tabs-*.vsix | head -n 1)"
VERSION="$(node -p 'require("./package.json").version')"

system_code() {
  if [ -n "${AGENT_TABS_EXTENSIONS_DIR:-}" ]; then set -- "$@" --extensions-dir "$AGENT_TABS_EXTENSIONS_DIR"; fi
  if [ -n "${AGENT_TABS_USER_DATA_DIR:-}" ]; then set -- "$@" --user-data-dir "$AGENT_TABS_USER_DATA_DIR"; fi
  env -u VSCODE_PORTABLE -u VSCODE_IPC_HOOK -u VSCODE_IPC_HOOK_CLI -u VSCODE_CWD "$SYSTEM_CODE" "$@"
}

system_code --install-extension "$VSIX" --force

system_code --list-extensions | grep -qx "$EXTENSION_ID" || { echo "FAIL: $EXTENSION_ID missing in system VS Code" >&2; exit 1; }
if [ -n "${AGENT_TABS_SECOND_VSCODE:-}" ]; then
  mkdir -p "$SECOND_DATA"
  second_code() { env -u VSCODE_IPC_HOOK -u VSCODE_IPC_HOOK_CLI -u VSCODE_CWD VSCODE_PORTABLE="$SECOND_DATA" "$SECOND_CODE" "$@"; }
  second_code --install-extension "$VSIX" --force
  second_code --list-extensions | grep -qx "$EXTENSION_ID" || { echo "FAIL: $EXTENSION_ID missing in second VS Code" >&2; exit 1; }
fi
if [ "${AGENT_TABS_SKIP_OMO_SETUP:-0}" != 1 ]; then node kit/setup-omo.mjs --env system; fi
echo "ok: $EXTENSION_ID $VERSION installed"
