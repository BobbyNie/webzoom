"""The helper is a separate UAT artifact, never a privileged publishing path."""
from pathlib import Path
import unittest
import yaml
ROOT = Path(__file__).resolve().parents[2]
class OverlayWorkflowTests(unittest.TestCase):
    def test_native_artifact_is_separate_and_checked(self):
        workflow = yaml.load((ROOT / '.github/workflows/container.yml').read_text(encoding='utf-8'), Loader=yaml.BaseLoader)
        job = workflow['jobs']['overlay-windows']
        self.assertEqual(job['runs-on'], 'windows-2025')
        self.assertNotIn('environment', job)
        self.assertNotIn('secrets.', str(job))
        steps = job['steps']
        test = next(i for i,s in enumerate(steps) if 'go test ./cmd/webzoom-overlay' in s.get('run',''))
        build = next(i for i,s in enumerate(steps) if 'package-overlay.ps1' in s.get('run',''))
        upload = next(i for i,s in enumerate(steps) if s.get('uses','').startswith('actions/upload-artifact@'))
        self.assertLess(test, build)
        self.assertLess(build, upload)
        self.assertEqual(steps[upload]['with']['name'], 'presenter-overlay-windows-x64')
        self.assertNotIn('docker push', str(job))
        self.assertNotIn('gh release', str(job))
