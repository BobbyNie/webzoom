"""Additional LAN gates must strengthen, not replace, the original release gates."""
from pathlib import Path
import unittest
import yaml
ROOT = Path(__file__).resolve().parents[2]
class LANClientWorkflowTests(unittest.TestCase):
    def test_windows_client_checks_gate_existing_quality_job(self):
        workflow = yaml.load((ROOT / '.github/workflows/container.yml').read_text(), Loader=yaml.BaseLoader)
        jobs = workflow['jobs']
        self.assertIn('windows_lan', jobs['quality']['needs'])
        self.assertEqual(set(jobs['publish']['needs']), {'quality', 'image'})
        text = '\n'.join(step.get('run', '') for step in jobs['windows_lan']['steps'])
        self.assertIn('Test-LanNativeBridge.ps1', text)
        self.assertIn('Test-LanClientInputs.ps1', text)
        self.assertIn('-TestOnly', text)
        self.assertNotIn('continue-on-error', str(jobs['windows_lan']))
        self.assertNotIn('secrets.', str(jobs['windows_lan']))
    def test_fixture_never_overwrites_production_registration(self):
        script = (ROOT / 'scripts/Test-LanNativeBridge.ps1').read_text(encoding='utf-8')
        self.assertIn('com.webzoom.lan_test_$id', script)
        self.assertIn("interfaceIP='0.0.0.0'", script)
        self.assertIn('finally', script)
        self.assertIn('Remove-Item -LiteralPath $key', script)
        self.assertNotIn('-Recurse', script)
