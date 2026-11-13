#!/usr/bin/env python3
"""Check that relative Markdown links and heading anchors resolve.

HTTP(S), mailto, and root-absolute URLs are out of scope; links inside fenced
code blocks are ignored. Both ``[text](target)`` and angle-bracket targets are
recognized, including images.

Default scope is Git-known Markdown (tracked or untracked, not ignored).
Repeat ``--include PATH`` to add ignored current work and ``--exclude PATH``
to remove a file or directory prefix. Paths are repository-relative.
Exit status: 0 = all links resolve, 1 = broken links found, 2 = invalid scope.
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import collect_markdown, is_template, iter_visible_lines

LINK_RE = re.compile(r'\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+[^)]*)?\)')
SCHEME_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')


def heading_slugs(text):
    """GitHub-style slugs of every heading, outside code fences."""
    slugs = set()
    counts = {}
    for _, line in iter_visible_lines(text):
        match = re.match(r'^(#{1,6})\s+(.*?)\s*#*\s*$', line.lstrip())
        if not match:
            continue
        title = re.sub(r'[`*]', '', match.group(2))
        slug = ''.join(c for c in title.lower() if c.isalnum() or c in ' -_')
        slug = slug.replace(' ', '-')
        if not slug:
            continue
        if slug in counts:
            counts[slug] += 1
            slug = f'{slug}-{counts[slug] - 1}'
        else:
            counts[slug] = 0
        slugs.add(slug)
    return slugs


def check_file(doc, findings):
    text = doc.read_text(encoding='utf-8', errors='replace')
    stripped_lines = []
    for lineno, line in iter_visible_lines(text):
        # Inline code may contain link-shaped examples rather than links.
        stripped_lines.append((lineno, re.sub(r'(`+)[^`]*\1', ' ', line)))
    for lineno, line in stripped_lines:
        for match in LINK_RE.finditer(line):
            target = match.group(2)
            if target.startswith('<') and target.endswith('>'):
                target = target[1:-1]
            if not target or target.startswith('/') or SCHEME_RE.match(target):
                continue
            path_part, _, anchor = target.partition('#')
            if not path_part:
                if anchor and anchor not in heading_slugs(text):
                    findings.append(f'{doc}:{lineno}: anchor not found: #{anchor}')
                continue
            resolved = (doc.parent / path_part).resolve()
            if not resolved.exists():
                findings.append(f'{doc}:{lineno}: link target missing: {path_part}')
                continue
            if anchor and resolved.suffix == '.md':
                target_text = resolved.read_text(encoding='utf-8', errors='replace')
                if anchor not in heading_slugs(target_text):
                    findings.append(
                        f'{doc}:{lineno}: anchor not found: #{anchor} in {path_part}')


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
    findings = []
    for doc in docs:
        check_file(doc, findings)
    for finding in findings:
        print(finding)
    print(f'{len(docs)} files scanned, {len(findings)} broken link(s)')
    print(f'Scope: include={args.include or ["(Git default)"]}; exclude={args.exclude or ["(none)"]}')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
