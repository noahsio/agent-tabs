"""Collects tool_use calls from Claude Code transcripts (read-only) into <raw_dir>/calls.jsonl.

Usage: python3 -I extract.py <raw_dir> <projects_root> [<projects_root> ...]
Commands and paths are redacted before they touch the disk.
"""
import json
import os
import sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from redact import redact  # noqa: E402


def main(raw_dir: str, roots: list) -> None:
    os.makedirs(raw_dir, exist_ok=True)
    seen = set()
    files = 0
    broken = 0
    with open(os.path.join(raw_dir, 'calls.jsonl'), 'w') as out:
        for root in roots:
            for dirpath, _dirnames, filenames in os.walk(root):
                for filename in filenames:
                    if not filename.endswith('.jsonl'):
                        continue
                    path = os.path.join(dirpath, filename)
                    real = os.path.realpath(path)
                    if real in seen:
                        continue
                    seen.add(real)
                    project = os.path.relpath(path, root).split(os.sep)[0]
                    files += 1
                    try:
                        handle = open(path, errors='replace')
                    except OSError:
                        continue
                    with handle:
                        for line in handle:
                            if '"tool_use"' not in line:
                                continue
                            try:
                                event = json.loads(line)
                            except ValueError:
                                broken += 1
                                continue
                            for record in tool_calls(event, project, 'subagents' in path):
                                out.write(json.dumps(record) + '\n')
    with open(os.path.join(raw_dir, 'extract.json'), 'w') as meta:
        json.dump({'files': files, 'broken_lines': broken, 'roots': len(roots)}, meta)
    print(f'transcripts: {files}, unreadable lines: {broken}', file=sys.stderr)


def tool_calls(event: dict, project: str, subagent: bool) -> list:
    message = event.get('message')
    if not isinstance(message, dict) or not isinstance(message.get('content'), list):
        return []
    records = []
    for item in message['content']:
        if not isinstance(item, dict) or item.get('type') != 'tool_use':
            continue
        name = item.get('name')
        tool_input = item.get('input') or {}
        record = {'tool': name, 'project': project, 'ts': event.get('timestamp'), 'cwd': event.get('cwd'), 'sub': subagent}
        if name == 'Bash' and isinstance(tool_input.get('command'), str):
            record['command'] = redact(tool_input['command'])
        elif name in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit'):
            target = tool_input.get('file_path') or tool_input.get('notebook_path')
            record['path'] = redact(target) if isinstance(target, str) else None
        elif name == 'WebFetch':
            try:
                record['host'] = urlparse(tool_input.get('url', '')).hostname
            except ValueError:
                pass
        records.append(record)
    return records


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit('usage: extract.py <raw_dir> <projects_root> [...]')
    main(sys.argv[1], sys.argv[2:])
