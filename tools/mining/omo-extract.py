"""Collects every assistant tool call from OmO session journals (read-only) into one deduplicated JSONL corpus.

Usage: python3 -I omo-extract.py <out.jsonl> <agent_dir> [<agent_dir> ...]
Reads every *.jsonl under a `sessions` directory below each agent dir (top-level sessions and task children under
projects/*/senpi-task/children/**/sessions/**). One row per distinct (agent_dir, cwd, tool, input):
{"tool", "input", "cwd", "agent_dir", "count"}. Every string is redacted before it touches the disk; image payloads are dropped.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from redact import redact  # noqa: E402

IMAGE_KEYS = {'image_data', 'image_data_list'}


def scrub(value, key: str = ''):
    if key in IMAGE_KEYS:
        return '‹image›'
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        return {name: scrub(item, name) for name, item in value.items()}
    return value


def journals(agent_dir: str):
    for dirpath, _dirnames, filenames in os.walk(agent_dir):
        if 'sessions' not in os.path.relpath(dirpath, agent_dir).split(os.sep):
            continue
        for filename in filenames:
            if filename.endswith('.jsonl'):
                yield os.path.join(dirpath, filename)


def calls_of(path: str):
    cwd = ''
    with open(path, errors='replace') as handle:
        for line in handle:
            if '"session"' not in line and '"toolCall"' not in line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('type') == 'session' and isinstance(event.get('cwd'), str):
                cwd = event['cwd']
            message = event.get('message')
            if not isinstance(message, dict) or message.get('role') != 'assistant' or not isinstance(message.get('content'), list):
                continue
            for item in message['content']:
                if isinstance(item, dict) and item.get('type') == 'toolCall' and isinstance(item.get('name'), str):
                    yield cwd, item['name'], item.get('arguments')


def main(out_path: str, agent_dirs: list) -> None:
    rows = {}
    files = 0
    for agent_dir in agent_dirs:
        agent_dir = os.path.abspath(os.path.expanduser(agent_dir))
        for path in journals(agent_dir):
            files += 1
            for cwd, tool, arguments in calls_of(path):
                row = {'tool': tool, 'input': scrub(arguments), 'cwd': redact(cwd), 'agent_dir': agent_dir}
                key = json.dumps(row, sort_keys=True, ensure_ascii=False)
                if key in rows:
                    rows[key]['count'] += 1
                else:
                    rows[key] = {**row, 'count': 1}
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w') as out:
        for row in rows.values():
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
    total = sum(row['count'] for row in rows.values())
    print(f'journals: {files}, calls: {total}, distinct: {len(rows)}', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit('usage: omo-extract.py <out.jsonl> <agent_dir> [<agent_dir> ...]')
    main(sys.argv[1], sys.argv[2:])
