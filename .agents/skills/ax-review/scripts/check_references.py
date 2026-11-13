#!/usr/bin/env python3
"""Check file paths and commands cited in Markdown.

Only inline code spans are checked; fenced blocks are examples. Findings are
candidates to judge in context, not automatic defects. Placeholders, variables,
globs, absolute paths, and ``../`` cross-repository paths are skipped. Documents
under ``assets/`` are templates for another tree and are skipped.

Default scope is Git-known Markdown (tracked or untracked, not ignored).
Repeat ``--include PATH`` to add ignored current work and ``--exclude PATH``
to remove a file or directory prefix. Paths are repository-relative.
Exit status: 0 = every citation resolves, 1 = findings found, 2 = invalid scope.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import collect_markdown, is_template, iter_visible_lines

SPAN_RE = re.compile(r'(`+)([^`]+)\1')
PATH_RE = re.compile(r'^[A-Za-z0-9._/@+-]+$')
RUN_RE = re.compile(r'\b(?:npm|pnpm|yarn|bun)\s+run\s+([A-Za-z0-9:_-]+)')
MAKE_RE = re.compile(r'^make\s+([A-Za-z0-9._-]+)$')
VERSIONED_PACKAGE_RE = re.compile(r'^(?:@[^/]+/)?[^/\s]+@[^/\s]+$')


def npm_script_names(root):
    """Return (has_package_json, script names across all packages)."""
    names = set()
    found = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in {'node_modules', '.git', 'dist', 'build'}]
        if 'package.json' not in filenames:
            continue
        found = True
        try:
            data = json.loads((Path(dirpath) / 'package.json').read_text(
                encoding='utf-8', errors='replace'))
        except (json.JSONDecodeError, OSError):
            continue
        names.update((data.get('scripts') or {}).keys())
    return found, names


def make_targets(root):
    makefile = root / 'Makefile'
    if not makefile.is_file():
        return None
    targets = set()
    for line in makefile.read_text(encoding='utf-8', errors='replace').splitlines():
        match = re.match(r'^([A-Za-z0-9._/-]+):', line)
        if match:
            targets.add(match.group(1))
    return targets


def path_exists(doc, root, candidate):
    if (root / candidate).exists():
        return True
    for ancestor in doc.parents:
        if ancestor == ancestor.parent or not ancestor.is_dir():
            continue
        if (ancestor / candidate).exists():
            return True
        if ancestor == root:
            break
    return False


def check_file(doc, root, has_scripts, scripts, targets, findings):
    text = doc.read_text(encoding='utf-8', errors='replace')
    for lineno, line in iter_visible_lines(text):
        for span in SPAN_RE.finditer(line):
            content = span.group(2).strip()
            if ('<' in content or '$' in content or '*' in content
                    or '{' in content or content.startswith('../')
                    or content.startswith('/')):
                continue
            run_match = RUN_RE.search(content)
            if has_scripts and run_match and run_match.group(1) not in scripts:
                findings.append(f'{doc}:{lineno}: npm script not defined: {run_match.group(1)}')
            make_match = MAKE_RE.match(content)
            if targets is not None and make_match and make_match.group(1) not in targets:
                findings.append(f'{doc}:{lineno}: make target not defined: {make_match.group(1)}')
            if VERSIONED_PACKAGE_RE.match(content):
                continue
            if '/' not in content or not PATH_RE.match(content):
                continue
            last = content.rstrip('/').rsplit('/', 1)[-1]
            if not re.search(r'\.', last[1:]):
                continue
            if not path_exists(doc, root, content.removeprefix('./')):
                findings.append(f'{doc}:{lineno}: cited path missing: {content}')


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', nargs='?', default='.')
    parser.add_argument('--include', action='append', default=[], metavar='PATH')
    parser.add_argument('--exclude', action='append', default=[], metavar='PATH')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    root = Path(args.repo).resolve()
    try:
        docs = [d for d in collect_markdown(root, args.include, args.exclude)
                if not is_template(d, root)]
    except ValueError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    has_scripts, scripts = npm_script_names(root)
    targets = make_targets(root)
    findings = []
    for doc in docs:
        check_file(doc, root, has_scripts, scripts, targets, findings)
    for finding in findings:
        print(finding)
    print(f'{len(docs)} files scanned, {len(findings)} reference finding(s)')
    print(f'Scope: include={args.include or ["(Git default)"]}; exclude={args.exclude or ["(none)"]}')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
