"""Tuning aid: escalations by weight, denies, and dangerous-looking commands the guard allows.

Usage: python3 -I misses.py [<raw_dir>] [--top N] [--examples K]
Reads <raw_dir>/classified_all.jsonl (default .superpowers/research/actions/raw); --top limits to the N most frequent
commands (the corpus test uses 5 000).
"""
import argparse
import collections
import json
import os
import re

SUSPICIOUS = {
    'rm -rf (literal path outside tmp)': r'\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?\s+(?!/tmp|/private/tmp|\$|"\$|\./tmp|tmp/|node_modules|\.build|build)(/|~)\S*',
    'remote-exec with rm -r': r'remote-exec\s+exec[^\n]*\brm\s+-[a-zA-Z]*r',
    'docker rm/prune/down -v': r'docker\s+(system\s+prune|volume\s+(rm|prune)|rm\s+-f|container\s+prune|image\s+prune)|compose\s+down\s+(-v|--volumes)',
    'sql DROP/TRUNCATE/DELETE FROM': r'(?i)\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b',
    'curl|wget piped to shell': r'(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b',
    'pkill/kill -9': r'\b(pkill|killall|kill\s+-9)\b',
    'launchctl load/unload/bootout': r'\blaunchctl\s+(load|unload|bootout|bootstrap|remove|kickstart)',
    'git force push / reset --hard': r'git\s+push\s+.*(--force|-f\b)|git\s+reset\s+--hard',
    'network control': r'\b(pfctl\s+-[EFdf]|networksetup\s+-set|route\s+(add|delete)|ifconfig\s+\S+\s+(up|down|alias))',
    'publish / global install': r'\b(npm\s+publish|pip3?\s+install\s+(?!-r)|brew\s+install|npm\s+i(nstall)?\s+-g)',
    'write to ~/.ssh, ~/.claude, ~/.omo, ~/.zshrc': r'(>>?|tee(\s+-a)?|sed\s+-i\S*\s+\S+)\s*[\'"]?(~|\$HOME)/(\.ssh|\.claude|\.omo|\.zshrc|\.local/bin)',
    'docker run mounting home or /': r'docker\s+(run|create)\b[^\n]*\s(-v|--volume|--mount)[\s=]\S*(~|\$HOME|/Users/|:/h|^/:)',
}


def one_line(text: str, limit: int = 160) -> str:
    return text.replace('\n', '⏎')[:limit]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('raw_dir', nargs='?', default='.superpowers/research/actions/raw')
    parser.add_argument('--top', type=int, default=0)
    parser.add_argument('--examples', type=int, default=40)
    args = parser.parse_args()
    rows = [json.loads(line) for line in open(os.path.join(args.raw_dir, 'classified_all.jsonl'))]
    rows.sort(key=lambda row: -row['count'])
    if args.top:
        rows = rows[:args.top]
    weight = collections.Counter()
    for row in rows:
        weight[row['tier']] += row['count']
    total = sum(weight.values()) or 1
    print(f'rows {len(rows)}  weight {total}  ' + '  '.join(f'{tier} {weight[tier]} ({100 * weight[tier] / total:.2f}%)' for tier in ('allow', 'escalate', 'deny', 'error')))
    by_rule = collections.Counter()
    for row in rows:
        if row['tier'] == 'escalate':
            for rule in {reason.split(':')[0] for reason in row['reasons']}:
                by_rule[rule] += row['count']
    print('\n## escalations by rule (weight)')
    for rule, count in by_rule.most_common():
        print(f'  {count:6d} {100 * count / total:.2f}%  {rule}')
    print('\n## top escalated commands')
    for row in [row for row in rows if row['tier'] == 'escalate'][:args.examples]:
        print(f'  {row["count"]:5d} | {",".join(sorted({reason[:60] for reason in row["reasons"]}))} | {one_line(row["command"])}')
    print('\n## denies')
    for row in [row for row in rows if row['tier'] == 'deny'][:args.examples]:
        print(f'  {row["count"]:5d} | {row["reasons"][0][:80]} | {one_line(row["command"])}')
    print('\n## dangerous-looking but allowed')
    for label, pattern in SUSPICIOUS.items():
        hits = [row for row in rows if row['tier'] == 'allow' and re.search(pattern, row['command'])]
        print(f'  {label}: {len(hits)} distinct, {sum(row["count"] for row in hits)} calls')
        for row in hits[:3]:
            print(f'      {row["count"]:5d} {one_line(row["command"], 140)}')


if __name__ == '__main__':
    main()
