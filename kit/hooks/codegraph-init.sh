#!/bin/sh
# SessionStart hook: build a CodeGraph index for the session's git repository the first time it is opened.
# Opt out with OMO_CODEGRAPH_AUTOINIT=0. Always exits 0 with JSON on stdout.
CODEGRAPH="${OMO_CODEGRAPH_BIN:-codegraph}"

finish() { echo '{}'; exit 0; }

[ "${OMO_CODEGRAPH_AUTOINIT:-1}" = "0" ] && finish

input="$(cat)"
cwd=""
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
fi
repo="$(git -C "${cwd:-$PWD}" rev-parse --show-toplevel 2>/dev/null)" || finish
[ -d "$repo/.codegraph" ] && finish

# The index keeps its own .gitignore, which leaves .codegraph/ itself untracked.
exclude="$(git -C "$repo" rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname "$exclude")"
grep -qx '.codegraph/' "$exclude" 2>/dev/null || echo '.codegraph/' >> "$exclude"

# Detached: the session starts at once, and the MCP server picks the index up when it is ready.
nohup "$CODEGRAPH" init --yes "$repo" </dev/null >/dev/null 2>&1 &
finish
