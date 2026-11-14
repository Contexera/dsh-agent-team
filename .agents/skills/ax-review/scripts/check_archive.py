#!/usr/bin/env python3
"""Audit .scratch/archive/ hygiene, index consistency, and scratch boundaries.

Unlike check_references.py, this script does NOT require historical specs or
tickets to match today's source paths. It checks only structural hygiene that
affects current agent experience:

1. Bidirectional consistency between .scratch/README.md (## Archived) and
   work-item directories under .scratch/archive/.
2. Required work-item entry README.md, unclosed ticket statuses (pending,
   ready, in-progress, review), and transient artifacts (.log, .tmp, .bak,
   local/).
3. Broken links inside an archived work item, broken exit links in its
   README.md, and links pointing into .scratch/active/ or .scratch/local/
   from either archives or maintained docs.

Exit status: 0 = clean, 1 = findings found, 2 = invalid scope.
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import _scope_path, _within, collect_markdown, is_template, iter_visible_lines
from check_links import LINK_RE, SCHEME_RE, heading_slugs

MONTH_DIR_RE = re.compile(r'^\d{4}-\d{2}$')
STATUS_LINE_RE = re.compile(r'^\*\*Status:\*\*\s*(.+?)\s*$', re.IGNORECASE)
STATUS_TOKEN_RE = re.compile(r'^[a-z]+(?:-[a-z]+)*')
UNCLOSED_STATUSES = {'pending', 'ready', 'in-progress', 'review'}
TRANSIENT_SUFFIXES = {'.log', '.tmp', '.bak', '.swp'}
TRANSIENT_DIRS = {'local'}
IGNORED_FILES = {'.DS_Store', '.gitkeep'}


def resolve_work_item_dir(path, archive_root):
    """Map a path inside an archived work item to its work-item directory."""
    if not _within(path, archive_root) or path == archive_root:
        return None
    rel = path.relative_to(archive_root)
    if MONTH_DIR_RE.match(rel.parts[0]):
        if len(rel.parts) < 2:
            return None
        candidate = archive_root / rel.parts[0] / rel.parts[1]
    else:
        candidate = archive_root / rel.parts[0]
    return candidate if candidate.is_dir() else None


def discover_archive(archive_root, findings):
    """Discover archived work-item dirs and flag loose/empty archive entries."""
    work_items = []
    if not archive_root.exists():
        return work_items
    for child in sorted(archive_root.iterdir()):
        if child.name in IGNORED_FILES or child.name.startswith('.'):
            continue
        if child.is_file():
            findings.append(f'{child}:1: loose file outside archived work-item directory')
            continue
        if not child.is_dir():
            continue
        if MONTH_DIR_RE.match(child.name):
            entries = [p for p in sorted(child.iterdir())
                       if p.name not in IGNORED_FILES and not p.name.startswith('.')]
            if not entries:
                findings.append(f'{child}:1: empty archive month directory')
                continue
            for entry in entries:
                if entry.is_file():
                    findings.append(f'{entry}:1: loose file outside archived work-item directory')
                elif entry.is_dir():
                    work_items.append(entry.resolve())
        else:
            work_items.append(child.resolve())
    return work_items


def select_targets(root, archive_root, targets, all_work_items):
    """Return selected work-item directories for --target, or all_work_items."""
    if not targets:
        return all_work_items
    selected = []
    seen = set()
    for raw in targets:
        resolved = _scope_path(root, raw)
        if not resolved.exists():
            raise ValueError(f'target path does not exist: {raw}')
        if not _within(resolved, archive_root):
            raise ValueError(f'target must be inside .scratch/archive: {raw}')
        if resolved == archive_root or (
            resolved.parent == archive_root and MONTH_DIR_RE.match(resolved.name)
        ):
            matches = [w for w in all_work_items if _within(w, resolved)]
            if not matches:
                raise ValueError(f'no archived work items found under target: {raw}')
            for match in matches:
                if match not in seen:
                    seen.add(match)
                    selected.append(match)
        else:
            work_dir = resolve_work_item_dir(resolved, archive_root)
            if work_dir is None:
                raise ValueError(f'target is not inside an archived work-item directory: {raw}')
            if work_dir not in seen:
                seen.add(work_dir)
                selected.append(work_dir)
    return selected


def iter_markdown_links(text):
    """Yield (lineno, target) for non-external Markdown links outside fences/code."""
    for lineno, line in iter_visible_lines(text):
        cleaned = re.sub(r'(`+)[^`]*\1', ' ', line)
        for match in LINK_RE.finditer(cleaned):
            target = match.group(2)
            if target.startswith('<') and target.endswith('>'):
                target = target[1:-1]
            if not target or target.startswith('/') or SCHEME_RE.match(target):
                continue
            yield lineno, target


def extract_archived_section(readme_text):
    """Yield (lineno, line) inside the ## Archived section outside fences."""
    in_section = False
    for lineno, line in iter_visible_lines(readme_text):
        stripped = line.lstrip()
        if re.match(r'^##\s+Archived\b', stripped):
            in_section = True
            continue
        if in_section and re.match(r'^##\s+', stripped):
            break
        if in_section:
            yield lineno, line


def check_index(root, scratch_dir, archive_root, selected_work_items, findings):
    """Check bidirectional consistency between .scratch/README.md and archive dirs."""
    readme = scratch_dir / 'README.md'
    if not readme.is_file():
        if selected_work_items:
            findings.append(f'{scratch_dir}:1: missing .scratch/README.md archive index')
        return

    text = readme.read_text(encoding='utf-8', errors='replace')
    section_lines = list(extract_archived_section(text))
    if not section_lines:
        if selected_work_items:
            findings.append(f'{readme}:1: missing "## Archived" section in .scratch/README.md')
        return

    active_dir = (scratch_dir / 'active').resolve()
    local_dir = (scratch_dir / 'local').resolve()
    indexed_items = set()

    for lineno, line in section_lines:
        cleaned = re.sub(r'(`+)[^`]*\1', ' ', line)
        for match in LINK_RE.finditer(cleaned):
            target = match.group(2)
            if target.startswith('<') and target.endswith('>'):
                target = target[1:-1]
            if not target or target.startswith('/') or SCHEME_RE.match(target):
                continue
            path_part, _, anchor = target.partition('#')
            if not path_part:
                continue
            resolved = (readme.parent / path_part).resolve()
            if _within(resolved, active_dir) or _within(resolved, local_dir):
                findings.append(f'{readme}:{lineno}: archive index points outside archive: {path_part}')
                continue
            if not resolved.exists():
                findings.append(f'{readme}:{lineno}: broken archive index link: {path_part}')
                continue
            if anchor and resolved.suffix == '.md':
                target_text = resolved.read_text(encoding='utf-8', errors='replace')
                if anchor not in heading_slugs(target_text):
                    findings.append(
                        f'{readme}:{lineno}: anchor not found: #{anchor} in {path_part}')
            work_dir = resolve_work_item_dir(resolved, archive_root)
            if work_dir is not None:
                indexed_items.add(work_dir)

    for work_dir in selected_work_items:
        if work_dir not in indexed_items:
            rel = work_dir.relative_to(root)
            findings.append(
                f'{readme}:1: archived work item missing from ## Archived index: {rel}')


def check_work_item(root, scratch_dir, work_dir, findings):
    """Check entry README, ticket statuses, transient files, and archive links."""
    readme = work_dir / 'README.md'
    if not readme.is_file():
        findings.append(f'{work_dir}:1: archived work item missing README.md')

    for entry in sorted(work_dir.rglob('*')):
        if entry.name in IGNORED_FILES:
            continue
        if entry.is_dir() and entry.name in TRANSIENT_DIRS:
            findings.append(
                f'{entry}:1: transient directory in archive: {entry.relative_to(root)}')
        elif entry.is_file() and entry.suffix.lower() in TRANSIENT_SUFFIXES:
            findings.append(
                f'{entry}:1: transient artifact in archive: {entry.relative_to(root)}')

    issues_dir = work_dir / 'issues'
    if issues_dir.is_dir():
        for ticket in sorted(issues_dir.glob('*.md')):
            text = ticket.read_text(encoding='utf-8', errors='replace')
            for lineno, line in iter_visible_lines(text):
                match = STATUS_LINE_RE.match(line.strip())
                if not match:
                    continue
                raw_status = match.group(1).strip().lower()
                token_match = STATUS_TOKEN_RE.match(raw_status)
                token = token_match.group(0) if token_match else raw_status
                if token in UNCLOSED_STATUSES:
                    findings.append(
                        f'{ticket}:{lineno}: unclosed ticket status in archive: {match.group(1).strip()}')

    active_dir = (scratch_dir / 'active').resolve()
    local_dir = (scratch_dir / 'local').resolve()

    for doc in sorted(work_dir.rglob('*.md')):
        text = doc.read_text(encoding='utf-8', errors='replace')
        doc_slugs = None
        is_entry_readme = doc.resolve() == readme.resolve()
        for lineno, target in iter_markdown_links(text):
            path_part, _, anchor = target.partition('#')
            if not path_part:
                if anchor:
                    if doc_slugs is None:
                        doc_slugs = heading_slugs(text)
                    if anchor not in doc_slugs:
                        findings.append(f'{doc}:{lineno}: anchor not found: #{anchor}')
                continue
            resolved = (doc.parent / path_part).resolve()
            if _within(resolved, active_dir) or _within(resolved, local_dir):
                findings.append(
                    f'{doc}:{lineno}: archived doc links to non-archived scratch path: {path_part}')
                continue
            if _within(resolved, work_dir) or _within(resolved, scratch_dir):
                if not resolved.exists():
                    findings.append(
                        f'{doc}:{lineno}: archived internal link target missing: {path_part}')
                    continue
                if anchor and resolved.suffix == '.md':
                    target_text = resolved.read_text(encoding='utf-8', errors='replace')
                    if anchor not in heading_slugs(target_text):
                        findings.append(
                            f'{doc}:{lineno}: anchor not found: #{anchor} in {path_part}')
                continue
            if is_entry_readme:
                if not resolved.exists():
                    findings.append(
                        f'{doc}:{lineno}: archived README exit link target missing: {path_part}')
                elif anchor and resolved.suffix == '.md':
                    target_text = resolved.read_text(encoding='utf-8', errors='replace')
                    if anchor not in heading_slugs(target_text):
                        findings.append(
                            f'{doc}:{lineno}: anchor not found: #{anchor} in {path_part}')


def check_maintained_active_links(root, scratch_dir, findings):
    """Flag maintained docs that still link into .scratch/active/ or .scratch/local/."""
    active_dir = (scratch_dir / 'active').resolve()
    local_dir = (scratch_dir / 'local').resolve()
    docs = [d for d in collect_markdown(root, exclude=['.scratch'])
            if not is_template(d, root)]
    for doc in docs:
        text = doc.read_text(encoding='utf-8', errors='replace')
        for lineno, target in iter_markdown_links(text):
            path_part, _, _ = target.partition('#')
            if not path_part:
                continue
            resolved = (doc.parent / path_part).resolve()
            if _within(resolved, active_dir) or _within(resolved, local_dir):
                findings.append(
                    f'{doc}:{lineno}: maintained doc links to non-tracked scratch path: {path_part}')


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', nargs='?', default='.')
    parser.add_argument('--target', action='append', default=[], metavar='PATH')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    root = Path(args.repo).resolve()
    scratch_dir = (root / '.scratch').resolve()
    archive_root = (scratch_dir / 'archive').resolve()

    findings = []
    all_work_items = discover_archive(archive_root, findings)
    try:
        selected = select_targets(root, archive_root, args.target, all_work_items)
    except ValueError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2

    if args.target:
        target_roots = [_scope_path(root, raw) for raw in args.target]
        findings = [f for f in findings
                    if any(_within(Path(f.split(':', 1)[0]).resolve(), tr) for tr in target_roots)]

    if scratch_dir.is_dir():
        check_index(root, scratch_dir, archive_root, selected, findings)
        for work_dir in selected:
            check_work_item(root, scratch_dir, work_dir, findings)
        check_maintained_active_links(root, scratch_dir, findings)

    for finding in findings:
        print(finding)
    print(f'{len(selected)} archived work item(s) scanned, {len(findings)} archive finding(s)')
    print(f'Scope: target={args.target or ["(all .scratch/archive)"]}')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
