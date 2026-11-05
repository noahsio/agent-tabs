"""Aggregates <raw_dir>/calls.jsonl into <raw_dir>/stats.json and <raw_dir>/corpus_all.jsonl (distinct commands by count).

Usage: python3 -I analyze.py <raw_dir>
"""
import collections
import ipaddress
import json
import os
import re
import sys

HOME = os.path.expanduser('~')
MAX_COMMAND = 200000  # long heredoc commands must keep their terminator line
HEAD_SUBCOMMANDS = {'git', 'docker', 'npm', 'swift', 'codegraph', 'xcodebuild', 'pnpm', 'yarn', 'cargo', 'brew', 'gh',
                    'launchctl', 'kubectl', 'defaults', 'security', 'plutil', 'codesign', 'xcrun', 'make', 'pip', 'systemctl'}
IP_RE = re.compile(r'(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d])(?!\.\d)')
HOST_RE = re.compile(r'(?:https?|wss?|ftp)://(?:[^/\s@"\']+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)')
SSH_RE = re.compile(r'\b(?:ssh|scp|sftp|rsync|sshpass)\b[^|;\n]*?\b[\w.-]+@([A-Za-z0-9.-]+)')
REDIRECT_RE = re.compile(r'(?<![<>&0-9])>{1,2}\s*("[^"]+"|\'[^\']+\'|[^\s&|;<>()]+)')
TEE_RE = re.compile(r'\btee\s+(?:-a\s+)?("[^"]+"|\S+)')
SENSITIVE = ('.omo', '.local/bin', '~/.claude', '.claude/settings', '/Library/LaunchAgents', 'LaunchDaemons', 'crontab',
             '/etc/hosts', '.zshrc', '.ssh/')


def strip_head(command: str) -> str:
    rest = command.strip()
    for _ in range(6):
        rest = rest.lstrip()
        for pattern in (r'^cd\s+("[^"]*"|\'[^\']*\'|\S+)\s*(&&|;)\s*', r'^(sudo(\s+-\S+)*|env|nohup|time|command|exec)\s+',
                        r'^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|\'[^\']*\'|\S*)\s+'):
            match = re.match(pattern, rest)
            if match:
                rest = rest[match.end():]
                break
        else:
            break
    return rest


def head(command: str) -> str:
    words = strip_head(command).split()
    if not words:
        return '(empty)'
    first = os.path.basename(words[0]) if words[0].startswith(('/', './', '~/')) else words[0]
    first = first.strip('()`"\'{')
    if len(words) > 1 and re.fullmatch(r'[a-z][a-z0-9:_-]*', words[1]) and first in HEAD_SUBCOMMANDS:
        return f'{first} {words[1]}'
    return first


def is_private(ip: str) -> bool:
    address = ipaddress.ip_address(ip)
    return address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified


def location(path: str) -> str:
    if not path:
        return 'other'
    path = path.replace('~', HOME, 1) if path.startswith('~') else path
    if path.startswith(('/tmp', '/private/tmp', '/var/folders', '/private/var/folders')):
        return '/tmp'
    for prefix, label in ((HOME + '/.omo', '~/.omo'), (HOME + '/.local/bin', '~/.local/bin'), (HOME + '/.claude', '~/.claude*'),
                          (HOME + '/Library', '~/Library'), (HOME + '/.', '~/.dotdirs other'), (HOME, '~ other')):
        if path.startswith(prefix):
            return label
    if path.startswith(('/Applications', '/usr', '/etc', '/opt', '/Volumes')):
        return 'system (' + path.split('/')[1] + ')'
    return 'other'


def main(raw_dir: str) -> None:
    tools = collections.Counter()
    heads = collections.Counter()
    ips = collections.Counter()
    hosts = collections.Counter()
    write_targets = collections.Counter()
    projects = collections.Counter()
    web_hosts = collections.Counter()
    mcp = collections.Counter()
    bash_writes = collections.Counter()
    sensitive = collections.Counter()
    commands = collections.Counter()
    command_project = collections.defaultdict(collections.Counter)
    command_cwd = collections.defaultdict(collections.Counter)
    with open(os.path.join(raw_dir, 'calls.jsonl')) as calls:
        for line in calls:
            record = json.loads(line)
            tool = record['tool']
            tools[tool] += 1
            projects[record['project']] += 1
            if tool and tool.startswith('mcp__'):
                mcp[tool] += 1
            if tool == 'WebFetch' and record.get('host'):
                web_hosts[record['host']] += 1
            if tool in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit') and record.get('path'):
                write_targets[location(record['path'])] += 1
            if tool != 'Bash' or not isinstance(record.get('command'), str):
                continue
            command = record['command'][:MAX_COMMAND]
            commands[command] += 1
            command_project[command][record['project']] += 1
            command_cwd[command][record.get('cwd') or ''] += 1
            heads[head(command)] += 1
            for ip in set(IP_RE.findall(command)):
                ips[ip] += 1
            for host in set(HOST_RE.findall(command)) | set(SSH_RE.findall(command)):
                hosts[host] += 1
            for target in REDIRECT_RE.findall(command) + TEE_RE.findall(command):
                target = target.strip('"\'')
                if target.startswith(('/', '~')) and target != '/dev/null':
                    bash_writes[location(target)] += 1
            for key in SENSITIVE:
                if key in command:
                    sensitive[key] += 1
    stats = {'tools': tools, 'heads': heads.most_common(200), 'ips': [(ip, count, is_private(ip)) for ip, count in ips.most_common(300)],
             'hosts': hosts.most_common(300), 'write_targets': write_targets, 'projects': projects.most_common(),
             'web_hosts': web_hosts.most_common(50), 'mcp': mcp.most_common(40), 'bash_writes': bash_writes, 'sensitive': sensitive,
             'distinct': len(commands), 'total_bash': sum(commands.values())}
    with open(os.path.join(raw_dir, 'stats.json'), 'w') as handle:
        json.dump(stats, handle, default=list)
    with open(os.path.join(raw_dir, 'corpus_all.jsonl'), 'w') as handle:
        for command, count in commands.most_common():
            row = {'command': command, 'project': command_project[command].most_common(1)[0][0],
                   'cwd': command_cwd[command].most_common(1)[0][0], 'count': count}
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    print(f'distinct bash commands: {len(commands)}, calls: {sum(commands.values())}', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: analyze.py <raw_dir>')
    main(sys.argv[1])
