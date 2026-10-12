"""Admin access stays opt-in in all shipped deployments."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]

class AdminConfigurationTests(unittest.TestCase):
    def test_compose_passes_multiple_subjects_without_default_admin(self):
        for path in ('compose.yaml', 'deploy/local/compose.yaml'):
            config = yaml.load((ROOT / path).read_text(), Loader=yaml.BaseLoader)
            self.assertEqual(config['services']['app']['environment'].get('ADMIN_USER_IDS'), '${ADMIN_USER_IDS:-}')

    def test_openshift_disables_admin_until_configured(self):
        config = next(yaml.load_all((ROOT / 'deploy/openshift/config.yaml').read_text(), Loader=yaml.BaseLoader))
        self.assertIn('ADMIN_USER_IDS', config['data'])
        self.assertEqual(config['data']['ADMIN_USER_IDS'], '')

    def test_example_explains_oidc_subject(self):
        example = (ROOT / '.env.example').read_text()
        self.assertIn('ADMIN_USER_IDS=', example)
        self.assertIn('OIDC sub', example)
