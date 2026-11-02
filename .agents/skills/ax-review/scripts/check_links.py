#!/usr/bin/env python3
"""Check that every relative Markdown link resolves to a file and heading anchor.

Catches rot in documentation routing: links to renamed or deleted files, and
anchors pointing at headings that no longer exist. HTTP(S), mailto, and
root-absolute URLs are out of scope; links inside fenced code blocks are
ignored (they are examples, not assertions). Both ``[text](target)`` and the
angle form ``[text](<target with spaces>)`` are recognized, including images.

Anchor matching follows GitHub slugging: lowercase, punctuation removed,
spaces to hyphens, duplicates suffixed -1, -2, ... Explicit HTML anchors
(<a name=...>) are not modeled and may report false findings.

Scans the Markdown files git knows about (tracked or untracked, not ignored).
Usage: check_links.py [repo_root]   (default: current directory)
Exit status: 0 = all links resolve, 1 = broken links found.
"""

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
        title = re.sub(r'[`*_]', '', match.group(2))
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
        # Links live in prose; blank out inline code spans so paths and
        # examples in backticks are not parsed as link targets.
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


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    findings = []
    docs = [d for d in collect_markdown(root) if not is_template(d, root)]
    for doc in docs:
        check_file(doc, findings)
    for finding in findings:
        print(finding)
    print(f'{len(docs)} files scanned, {len(findings)} broken link(s)')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
