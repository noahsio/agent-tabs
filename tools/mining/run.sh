#!/bin/sh
# Rebuilds the real-command corpus from Claude Code transcripts (read-only).
# Usage: sh tools/mining/run.sh [projects_root ...]
#   default roots: ~/.claude/projects and $CLAUDE_CONFIG_DIR/projects
#   output: $MINING_OUT (default .superpowers/research/actions/): corpus.jsonl, summary.md, classified.md; intermediates in raw/
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=${MINING_OUT:-$repo/.superpowers/research/actions}
if [ "$#" -eq 0 ]; then
  set -- "$HOME/.claude/projects"
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then set -- "$@" "$CLAUDE_CONFIG_DIR/projects"; fi
fi
mkdir -p "$out/raw"
python3 -I "$here/extract.py" "$out/raw" "$@"
python3 -I "$here/analyze.py" "$out/raw"
node "$here/classify-run.mjs" "$out/raw"
python3 -I "$here/gen.py" "$out/raw" "$out"
