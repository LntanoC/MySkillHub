import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class AppIdentityTest(unittest.TestCase):
    def test_app_does_not_use_upstream_identity_or_update_feed(self):
        config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
        self.assertEqual(config['identifier'], 'com.lntanoc.myskillhub')
        self.assertEqual(config['productName'], 'MySkillHub')
        self.assertFalse(config['bundle']['createUpdaterArtifacts'])
        self.assertNotIn('xingkongliang/skills-manager', json.dumps(config.get('plugins', {})))

    def test_default_paths_are_separate_and_legacy_move_removed(self):
        source = (ROOT / 'src-tauri/src/core/central_repo.rs').read_text(encoding='utf-8')
        self.assertIn('path.join(".myskillhub")', source)
        self.assertIn('.join("myskillhub")', source)
        self.assertNotIn('home.join(".agent-skills")', source)


if __name__ == '__main__':
    unittest.main()
