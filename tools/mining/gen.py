"""Writes corpus.jsonl (top 5 000 commands by count), summary.md and classified.md from the intermediates in <raw_dir>.

Usage: python3 -I gen.py <raw_dir> <out_dir>
"""
import collections
import json
import os
import sys

CORPUS_SIZE = 5000


def one_line(text: str, limit: int) -> str:
    return text.replace('\n', ' ⏎ ')[:limit].replace('|', '\\|').replace('`', '´')


def table(header: str, rows: list) -> list:
    columns = header.count('|') - 1
    return [header, '|' + '---|' * columns] + rows


def write_corpus(raw_dir: str, out_dir: str) -> int:
    written = 0
    with open(os.path.join(raw_dir, 'corpus_all.jsonl')) as source, open(os.path.join(out_dir, 'corpus.jsonl'), 'w') as corpus:
        for line in source:
            row = json.loads(line)
            corpus.write(json.dumps({key: row[key] for key in ('command', 'project', 'cwd', 'count')}, ensure_ascii=False) + '\n')
            written += 1
            if written >= CORPUS_SIZE:
                break
    return written


def write_summary(raw_dir: str, out_dir: str) -> None:
    stats = json.load(open(os.path.join(raw_dir, 'stats.json')))
    meta = json.load(open(os.path.join(raw_dir, 'extract.json')))
    tools = stats['tools']
    lines = ['# Сводка по реальным действиям агентов', '',
             f'Транскриптов: {meta["files"]} (корней: {meta["roots"]}); только tool_use, без текста диалогов. '
             f'Вызовов: **{sum(tools.values())}**, проектов: **{len(stats["projects"])}**. '
             f'Bash: {stats["total_bash"]} вызовов, {stats["distinct"]} уникальных команд (после редакции секретов).', '',
             '## Вызовы по инструментам', '']
    lines += table('| tool | вызовов |', [f'| {name} | {count} |' for name, count in sorted(tools.items(), key=lambda item: -item[1])])
    lines += ['', '## Топ-60 голов Bash-команд', '']
    lines += table('| # | голова | вызовов |', [f'| {index} | `{name}` | {count} |' for index, (name, count) in enumerate(stats['heads'][:60], 1)])
    lines += ['', '## IP-литералы: публичные (топ 30)', '']
    lines += table('| IP | вызовов |', [f'| {ip} | {count} |' for ip, count, private in stats['ips'] if not private][:30])
    lines += ['', '## IP-литералы: частные и loopback (топ 12)', '']
    lines += table('| IP | вызовов |', [f'| {ip} | {count} |' for ip, count, private in stats['ips'] if private][:12])
    lines += ['', '## Хосты из URL и ssh/scp (топ 40)', '']
    lines += table('| host | вызовов |', [f'| {host} | {count} |' for host, count in stats['hosts'][:40]])
    lines += ['', '## Цели записи (Write/Edit/MultiEdit/NotebookEdit)', '']
    lines += table('| расположение | вызовов |', [f'| {name} | {count} |' for name, count in sorted(stats['write_targets'].items(), key=lambda item: -item[1])])
    lines += ['', '## Запись из Bash (редиректы и tee, грубо)', '']
    lines += table('| расположение | вызовов |', [f'| {name} | {count} |' for name, count in sorted(stats['bash_writes'].items(), key=lambda item: -item[1])])
    lines += ['', 'Упоминания чувствительных мест: ' + ', '.join(f'`{key}` {count}' for key, count in stats['sensitive'].items()), '']
    lines += ['## Проекты (топ 12)', '']
    lines += table('| проект | вызовов |', [f'| `{name}` | {count} |' for name, count in stats['projects'][:12]])
    with open(os.path.join(out_dir, 'summary.md'), 'w') as handle:
        handle.write('\n'.join(lines) + '\n')


def write_classified(raw_dir: str, out_dir: str) -> None:
    rows = [json.loads(line) for line in open(os.path.join(raw_dir, 'classified_all.jsonl'))]
    tier_count = collections.Counter()
    tier_weight = collections.Counter()
    rule_weight = collections.Counter()
    rule_count = collections.Counter()
    for row in rows:
        tier_count[row['tier']] += 1
        tier_weight[row['tier']] += row['count']
        if row['tier'] == 'escalate':
            row['ids'] = sorted({reason.split(':')[0] for reason in row['reasons']})
            for rule in row['ids']:
                rule_weight[rule] += row['count']
                rule_count[rule] += 1
    distinct = sum(tier_count.values()) or 1
    weight = sum(tier_weight.values()) or 1
    lines = ['# Классификация корпуса текущим guard', '',
             f'Правила: `kit/guard/default-rules.json`. Классифицированы все {distinct} уникальных команд ({weight} вызовов); '
             f'ошибок классификатора: {tier_count["error"]}.', '']
    lines += table('| tier | уникальных | % | вызовов | % |', [
        f'| {tier} | {tier_count[tier]} | {100 * tier_count[tier] / distinct:.2f} | {tier_weight[tier]} | {100 * tier_weight[tier] / weight:.2f} |'
        for tier in ('allow', 'escalate', 'deny')])
    lines += ['', '## Эскалации по правилу', '']
    lines += table('| правило | уник. | вызовов |', [f'| {rule} | {rule_count[rule]} | {count} |' for rule, count in rule_weight.most_common()])
    escalated = sorted((row for row in rows if row['tier'] == 'escalate'), key=lambda row: -row['count'])
    lines += ['', '## Топ-50 эскалированных команд', '']
    lines += table('| вызовов | правило | команда |', [f'| {row["count"]} | {",".join(row["ids"])} | `{one_line(row["command"], 170)}` |' for row in escalated[:50]])
    denied = sorted((row for row in rows if row['tier'] == 'deny'), key=lambda row: -row['count'])
    lines += ['', f'## Все deny ({len(denied)} уникальных, {tier_weight["deny"]} вызовов)', '']
    lines += table('| вызовов | причина | команда |', [f'| {row["count"]} | `{one_line(row["reasons"][0], 70)}` | `{one_line(row["command"], 110)}` |' for row in denied])
    with open(os.path.join(out_dir, 'classified.md'), 'w') as handle:
        handle.write('\n'.join(lines) + '\n')


def main(raw_dir: str, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    written = write_corpus(raw_dir, out_dir)
    write_summary(raw_dir, out_dir)
    write_classified(raw_dir, out_dir)
    print(f'corpus.jsonl: {written} rows', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: gen.py <raw_dir> <out_dir>')
    main(sys.argv[1], sys.argv[2])
