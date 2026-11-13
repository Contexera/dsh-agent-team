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


if __name__ == '__main__':
    unittest.main()
