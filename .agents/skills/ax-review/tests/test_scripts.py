import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import _common
import check_archive
import check_links
import check_references


class MarkdownScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / '.scratch/active/work').mkdir(parents=True)
        (self.root / '.scratch/archive/old').mkdir(parents=True)
        (self.root / 'assets').mkdir()
        (self.root / '.gitignore').write_text('.scratch/active/\n', encoding='utf-8')
        (self.root / 'current.md').write_text('# Current\n', encoding='utf-8')
        (self.root / 'new.md').write_text('# New\n', encoding='utf-8')
        (self.root / '.scratch/active/work/item.md').write_text('# Active\n', encoding='utf-8')
        (self.root / '.scratch/archive/old/item.md').write_text('# Archive\n', encoding='utf-8')
        (self.root / 'assets/template.md').write_text('[example](missing.md)\n', encoding='utf-8')
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        subprocess.run(['git', 'add', '.gitignore', 'current.md',
                        '.scratch/archive/old/item.md', 'assets/template.md'],
                       cwd=self.root, check=True)

    def tearDown(self):
        self.temp.cleanup()

    def names(self, docs):
        return {str(path.relative_to(self.root)) for path in docs}

    def test_default_scope_remains_git_known(self):
        docs = self.names(_common.collect_markdown(self.root))
        self.assertIn('current.md', docs)
        self.assertIn('new.md', docs)
        self.assertIn('.scratch/archive/old/item.md', docs)
        self.assertNotIn('.scratch/active/work/item.md', docs)

    def test_current_work_scope_includes_active_and_excludes_archive(self):
        docs = self.names(_common.collect_markdown(
            self.root, include=['.scratch/active'], exclude=['.scratch/archive']))
        self.assertEqual(docs, {
            'current.md',
            'new.md',
            'assets/template.md',
            '.scratch/active/work/item.md',
        })

    def test_archive_can_be_included_explicitly(self):
        docs = self.names(_common.collect_markdown(
            self.root, include=['.scratch/active', '.scratch/archive']))
        self.assertIn('.scratch/archive/old/item.md', docs)
        self.assertIn('.scratch/active/work/item.md', docs)

    def test_missing_include_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'include path does not exist'):
            _common.collect_markdown(self.root, include=['.scratch/missing'])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(check_links.main([
                str(self.root), '--include', '.scratch/missing']), 2)

    def test_documented_scope_executes_on_active_and_skips_archive_and_templates(self):
        active = self.root / '.scratch/active/work/item.md'
        archive = self.root / '.scratch/archive/old/item.md'
        active.write_text('[current](../../../current.md)\n', encoding='utf-8')
        archive.write_text('[missing](missing.md)\n', encoding='utf-8')
        args = [str(self.root), '--include', '.scratch/active',
                '--exclude', '.scratch/archive']
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check_links.main(args), 0)
            active.write_text('[missing](missing.md)\n', encoding='utf-8')
            self.assertEqual(check_links.main(args), 1)

    def test_template_detection(self):
        self.assertTrue(_common.is_template(self.root / 'assets/template.md', self.root))


class ParsingRegressionTests(unittest.TestCase):
    def test_heading_anchor_preserves_underscores(self):
        self.assertIn('team_thread', check_links.heading_slugs('# team_thread\n'))

    def test_versioned_npm_package_is_not_a_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            doc = root / 'README.md'
            doc.write_text('Use `@scope/pkg@1.2.3`.\n', encoding='utf-8')
            findings = []
            check_references.check_file(doc, root, False, set(), None, findings)
            self.assertEqual(findings, [])

    def test_real_missing_path_is_still_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            doc = root / 'README.md'
            doc.write_text('Read `docs/missing.md`.\n', encoding='utf-8')
            findings = []
            check_references.check_file(doc, root, False, set(), None, findings)
            self.assertEqual(len(findings), 1)


class ArchiveAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / 'docs').mkdir()
        (self.root / 'docs/guide.md').write_text('# Guide\n', encoding='utf-8')
        work = self.root / '.scratch/archive/2026-11/sample-work'
        (work / 'issues').mkdir(parents=True)
        (work / 'README.md').write_text(
            '# Sample Work\n\n'
            '- **Status:** Closed and archived.\n'
            '- **Maintained exit:** [Guide](../../../../docs/guide.md)\n'
            '- **Spec:** [Spec](spec.md)\n',
            encoding='utf-8',
        )
        (work / 'spec.md').write_text(
            '# Spec\n\nHistorical source ref: [Old](../../../../src/removed.py)\n',
            encoding='utf-8',
        )
        (work / 'issues/01-done.md').write_text(
            '# 01 — Done\n\n**Status:** complete\n',
            encoding='utf-8',
        )
        (work / 'issues/02-dropped.md').write_text(
            '# 02 — Dropped\n\n**Status:** cancelled\n',
            encoding='utf-8',
        )
        (self.root / '.scratch/README.md').write_text(
            '# .scratch Work-Item Index\n\n'
            '## Archived\n\n'
            '| Month | Work item | Delivered conclusion | Link |\n'
            '| --- | --- | --- | --- |\n'
            '| 2026-11 | sample-work | Done | [README](archive/2026-11/sample-work/README.md) |\n',
            encoding='utf-8',
        )
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        subprocess.run(['git', 'add', '.'], cwd=self.root, check=True)

    def tearDown(self):
        self.temp.cleanup()

    def run_check(self, *extra_args):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = check_archive.main([str(self.root), *extra_args])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_clean_archive_ignores_historical_source_links(self):
        code, out, _ = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn('1 archived work item(s) scanned, 0 archive finding(s)', out)

    def test_missing_index_entry_and_broken_index_link(self):
        extra = self.root / '.scratch/archive/2026-11/unindexed-work'
        extra.mkdir(parents=True)
        (extra / 'README.md').write_text('# Unindexed\n', encoding='utf-8')
        code, out, _ = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn('missing from ## Archived index', out)

        readme = self.root / '.scratch/README.md'
        readme.write_text(
            readme.read_text(encoding='utf-8')
            + '| 2026-11 | ghost | Missing | [README](archive/2026-11/ghost/README.md) |\n',
            encoding='utf-8',
        )
        code, out, _ = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn('broken archive index link', out)

    def test_unclosed_ticket_status_and_transient_artifacts_flagged(self):
        work = self.root / '.scratch/archive/2026-11/sample-work'
        (work / 'issues/03-open.md').write_text(
            '# 03 — Open\n\n**Status:** ready\n',
            encoding='utf-8',
        )
        (work / 'debug.log').write_text('trace\n', encoding='utf-8')
        code, out, _ = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn('unclosed ticket status in archive: ready', out)
        self.assertIn('transient artifact in archive', out)

    def test_internal_exit_and_active_links_checked(self):
        work = self.root / '.scratch/archive/2026-11/sample-work'
        (work / 'README.md').write_text(
            '# Sample Work\n\n'
            '- [Missing exit](../../../../docs/missing.md)\n'
            '- [Missing internal](materials/missing.md)\n',
            encoding='utf-8',
        )
        (self.root / 'docs/guide.md').write_text(
            '# Guide\n\nSee [active](../.scratch/active/foo/README.md)\n',
            encoding='utf-8',
        )
        subprocess.run(['git', 'add', 'docs/guide.md'], cwd=self.root, check=True)
        code, out, _ = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn('archived README exit link target missing', out)
        self.assertIn('archived internal link target missing', out)
        self.assertIn('maintained doc links to non-tracked scratch path', out)

    def test_target_scoping_and_invalid_target_fail_closed(self):
        other = self.root / '.scratch/archive/2026-11/other-work'
        other.mkdir(parents=True)
        # Missing README.md in other-work should be ignored when targeting sample-work.
        (self.root / '.scratch/README.md').write_text(
            '# .scratch Work-Item Index\n\n'
            '## Archived\n\n'
            '| Month | Work item | Delivered conclusion | Link |\n'
            '| --- | --- | --- | --- |\n'
            '| 2026-11 | sample-work | Done | [README](archive/2026-11/sample-work/README.md) |\n'
            '| 2026-11 | other-work | Done | [Dir](archive/2026-11/other-work) |\n',
            encoding='utf-8',
        )
        code, out, _ = self.run_check('--target', '.scratch/archive/2026-11/sample-work')
        self.assertEqual(code, 0, out)
        self.assertIn('1 archived work item(s) scanned', out)

        code, _, err = self.run_check('--target', '.scratch/archive/missing')
        self.assertEqual(code, 2)
        self.assertIn('target path does not exist', err)

        code, _, err = self.run_check('--target', 'docs/guide.md')
        self.assertEqual(code, 2)
        self.assertIn('target must be inside .scratch/archive', err)


if __name__ == '__main__':
    unittest.main()
