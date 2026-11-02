"""Shared helpers for the ax-review check scripts."""

import re
import subprocess
from pathlib import Path

FENCE_OPEN_RE = re.compile(r'^(`{3,}|~{3,})')


def collect_markdown(root: Path):
    """Markdown files worth scanning: git-tracked or untracked-but-not-ignored.

    Falls back to a recursive walk skipping common junk when the directory is
    not a git repository. Ignored directories (node_modules, build output,
    retired archives) are excluded automatically in git repositories.
    """
    try:
        out = subprocess.run(
            ['git', '-C', str(root), 'ls-files', '--cached', '--others',
             '--exclude-standard', '--', '*.md'],
            capture_output=True, text=True, check=True).stdout
        files = [root / line for line in out.splitlines() if line]
        if files:
            return sorted(files)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    skip = {'.git', 'node_modules', 'dist', 'build', 'vendor'}
    files = [p for p in root.rglob('*.md')
             if not any(part in skip for part in p.relative_to(root).parts)]
    return sorted(files)


def is_template(doc, root):
    """True for documents shipped as templates (under an assets/ directory).

    Template files legitimately cite paths and links of the repository they
    will be copied into, which never resolve in the source tree.
    """
    return 'assets' in doc.relative_to(root).parts


def iter_visible_lines(text):
    """Yield (lineno, line) for lines outside fenced code blocks.

    Fence tracking is marker-based (``` or ~~~); inline code spans are left
    intact so each caller can treat them as it needs.
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
            continue
        yield lineno, line
