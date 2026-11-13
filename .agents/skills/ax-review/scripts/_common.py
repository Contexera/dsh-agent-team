"""Shared helpers for the ax-review check scripts."""

import re
import subprocess
from pathlib import Path

FENCE_OPEN_RE = re.compile(r'^(`{3,}|~{3,})')


def _scope_path(root, value):
    path = Path(value)
    resolved = (root / path).resolve() if not path.is_absolute() else path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f'scope outside repository: {value}') from exc
    return resolved


def _within(path, scope):
    return path == scope or scope in path.parents


def collect_markdown(root, include=(), exclude=()):
    """Return Markdown in Git scope plus explicit includes, minus excludes.

    The default remains Git-known files (tracked or untracked, not ignored).
    Includes also walk ignored files, which lets a review cover an ignored
    active-work directory. Include paths must exist so a typo cannot silently
    narrow the review. Excludes are repository-relative file/directory prefixes.
    """
    root = root.resolve()
    includes = [_scope_path(root, value) for value in include]
    excludes = [_scope_path(root, value) for value in exclude]
    for path in includes:
        if not path.exists():
            raise ValueError(f'include path does not exist: {path.relative_to(root)}')

    try:
        out = subprocess.run(
            ['git', '-C', str(root), 'ls-files', '--cached', '--others',
             '--exclude-standard', '--', '*.md'],
            capture_output=True, text=True, check=True).stdout
        files = [root / line for line in out.splitlines() if line]
        if files:
            files = sorted(files)
        else:
            files = []
    except (subprocess.CalledProcessError, FileNotFoundError):
        skip = {'.git', 'node_modules', 'dist', 'build', 'vendor'}
        files = [p for p in root.rglob('*.md')
                 if not any(part in skip for part in p.relative_to(root).parts)]

    for path in includes:
        if path.is_dir():
            files.extend(path.rglob('*.md'))
        elif path.suffix == '.md':
            files.append(path)

    unique = {path.resolve() for path in files}
    return sorted(path for path in unique
                  if not any(_within(path, scope) for scope in excludes))


def is_template(doc, root):
    """True for documents shipped as templates (under an assets/ directory).

    Template files legitimately cite paths and links of the repository they
    will be copied into, which never resolve in the source tree.
    """
    return 'assets' in doc.relative_to(root).parts


def iter_visible_lines(text):
    """Yield (lineno, line) for lines outside fenced code blocks.

    Fence tracking is marker-based (``` and ~~~). Inline code spans are left
    intact; each caller decides whether it needs to blank them.
    """
    fence = None
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if fence is not None:
            if stripped.startswith(fence):
                fence = None
            continue
        match = FENCE_OPEN_RE.match(stripped)
        if match:
            fence = match.group(1)[:3]
        else:
            yield lineno, line
