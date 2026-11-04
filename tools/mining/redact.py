"""Secret redaction for mined agent commands.

As a module: `redact(text) -> str`. As a script: redacts stdin to stdout.
"""
import re
import sys

REDACTED = '‹redacted›'

_RULES = [
    (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)'), lambda m: REDACTED),
    (re.compile(r'(?i)(authorization:\s*(?:bearer|basic|token)?\s*)[^\s"\']+'), lambda m: m.group(1) + REDACTED),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}'), lambda m: 'Bearer ' + REDACTED),
    (re.compile(r'(?i)(x-api-key["\']?\s*[:=]\s*["\']?)[^\s"\']+'), lambda m: m.group(1) + REDACTED),
    (re.compile(r'(?i)(sshpass\s+-p\s*)(\'[^\']*\'|"[^"]*"|\S+)'), lambda m: m.group(1) + REDACTED),
    (re.compile(r'(?i)((?:pass(?:word|wd)?|secret|api[_-]?key|token|auth)\s*=\s*)(\'[^\']*\'|"[^"]*"|[^\s&;"\']+)'),
     lambda m: m.group(1) + REDACTED),
    (re.compile(r'(?i)(--(?:token|password|passwd|secret|api-key|auth-token|access-token)[ =])(\'[^\']*\'|"[^"]*"|\S+)'),
     lambda m: m.group(1) + REDACTED),
    (re.compile(r'(?i)(\bcurl\b[^|;\n]*?\s-u\s*)(\S+)'), lambda m: m.group(1) + REDACTED),
    (re.compile(r'(://[^/\s:@]+:)[^@\s/]+@'), lambda m: m.group(1) + REDACTED + '@'),
    (re.compile(r'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\.?[A-Za-z0-9_-]*'), lambda m: REDACTED),
    (re.compile(r'\bAKIA[0-9A-Z]{12,}\b'), lambda m: REDACTED),
    (re.compile(r'\b(?:sk|wm|ghp|gho|ghs|ghu|xox[bap]|glpat|pk|rk)[-_][A-Za-z0-9_-]{8,}'), lambda m: REDACTED),
    (re.compile(r'\bgithub_pat_[A-Za-z0-9_]{10,}'), lambda m: REDACTED),
]

_LONG_TOKEN = re.compile(r'(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{24,}(?![A-Za-z0-9+_=-])')


def _long_token(match: re.Match) -> str:
    token = match.group(0)
    if re.fullmatch(r'(0x)?[0-9a-fA-F]{24,}', token):
        return REDACTED
    if re.search(r'\d', token) and re.search(r'[a-z]', token) and re.search(r'[A-Z]', token):
        return REDACTED
    return token


def redact(text: str) -> str:
    for pattern, replace in _RULES:
        text = pattern.sub(replace, text)
    return _LONG_TOKEN.sub(_long_token, text)


if __name__ == '__main__':
    sys.stdout.write(redact(sys.stdin.read()))
