import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('maintain.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.STDOUT, text=True).strip()


class MergeWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.upstream = root / 'upstream'
        self.upstream.mkdir()
        git(self.upstream, 'init', '-b', 'main')
        self.identity(self.upstream)
        (self.upstream / 'SKILL.md').write_text('base\n', encoding='utf-8')
        self.commit(self.upstream, 'base')
        self.repo = root / 'repo'
        subprocess.check_call(['git', 'clone', '--origin', 'upstream', str(self.upstream), str(self.repo)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.identity(self.repo)
        git(self.repo, 'switch', '-c', 'my-skills')
        self.skill = {'name': 'demo', 'repo': str(self.repo), 'branch': 'my-skills', 'upstream_remote': 'upstream', 'upstream_branch': 'main', 'skill_path': '.'}

    def identity(self, repo):
        git(repo, 'config', 'user.name', 'Test')
        git(repo, 'config', 'user.email', 'test@localhost')
        git(repo, 'config', 'core.autocrlf', 'false')

    def commit(self, repo, message):
        git(repo, 'add', '.')
        git(repo, 'commit', '-m', message)

    def test_merge_preserves_customization(self):
        (self.repo / 'custom.txt').write_text('custom', encoding='utf-8')
        self.commit(self.repo, 'custom')
        (self.upstream / 'new.txt').write_text('upstream', encoding='utf-8')
        self.commit(self.upstream, 'upstream')
        result = maintenance.merge_upstream(self.skill)
        self.assertFalse(result['published'])
        self.assertEqual((self.repo / 'custom.txt').read_text(), 'custom')
        self.assertEqual((self.repo / 'new.txt').read_text(), 'upstream')

    def test_conflict_stops_and_can_abort(self):
        (self.repo / 'SKILL.md').write_text('local\n', encoding='utf-8')
        self.commit(self.repo, 'local')
        (self.upstream / 'SKILL.md').write_text('remote\n', encoding='utf-8')
        self.commit(self.upstream, 'remote')
        with self.assertRaisesRegex(RuntimeError, 'Merge stopped'):
            maintenance.merge_upstream(self.skill)
        self.assertEqual(git(self.repo, 'diff', '--name-only', '--diff-filter=U'), 'SKILL.md')
        git(self.repo, 'merge', '--abort')
        self.assertEqual(git(self.repo, 'status', '--porcelain'), '')

    def test_uncommitted_files_block_check(self):
        (self.repo / 'new.txt').write_text('unsaved', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'Commit or resolve'):
            maintenance.check_upstream(self.skill)

    def test_unknown_upstream_does_not_guess(self):
        self.skill['upstream_remote'] = None
        self.assertEqual(maintenance.check_upstream(self.skill)['status'], 'local_only')

    def test_outdated_review_cannot_publish(self):
        with self.assertRaisesRegex(RuntimeError, 'reviewed-commit'):
            maintenance.publish({}, self.skill, 'old', False)


if __name__ == '__main__':
    unittest.main()
