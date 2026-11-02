#!/usr/bin/env python3
"""Check that file paths and commands cited in Markdown still exist.

Catches documentation drift: prose referencing files that were renamed or
deleted, ``npm run <script>`` names no longer defined, and ``make`` targets
that disappeared. Only inline code spans are checked — fenced blocks are
examples, not assertions. Each finding is a candidate to judge in context:

- Placeholders (``<...>``, ``$VAR``, globs) and ``../`` cross-repository
  paths are skipped: not claims about this repository.
- Absolute paths (``/usr/...``, URL path segments) are skipped: they name
  other systems, not this tree.
- Candidates must look like a file (last segment has an extension); bare
  directory or API-segment mentions such as ``src/`` or ``space/wbi/arc``
  are convention prose, not existence claims.
- Paths resolve against the repository root and then the citing document's
  ancestor directories, the way a reader would interpret them.
- Documents under an ``assets/`` directory are skipped entirely: templates
  cite the repository they will be copied into.
- ``npm run`` names are validated only when the repository has a
  package.json, against the union of every package's scripts (workspaces
  define scripts in many places); ``make`` targets against a root Makefile.

Scans the Markdown files git knows about (tracked or untracked, not ignored).
Usage: check_references.py [repo_root]   (default: current directory)
Exit status: 0 = every citation resolves, 1 = findings found.
"""

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


def npm_script_names(root):
    """(has_package_json, script names across all packages)."""
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
            if '/' not in content or not PATH_RE.match(content):
                continue
            last = content.rstrip('/').rsplit('/', 1)[-1]
            if not re.search(r'\.', last[1:]):
                continue
            if not path_exists(doc, root, content.removeprefix('./')):
                findings.append(f'{doc}:{lineno}: cited path missing: {content}')


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    docs = [d for d in collect_markdown(root) if not is_template(d, root)]
    has_scripts, scripts = npm_script_names(root)
    targets = make_targets(root)
    findings = []
    for doc in docs:
        check_file(doc, root, has_scripts, scripts, targets, findings)
    for finding in findings:
        print(finding)
    print(f'{len(docs)} files scanned, {len(findings)} reference finding(s)')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
