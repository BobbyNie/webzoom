"""Saved bandwidth policy uses durable storage without a writable root or root UID."""
from pathlib import Path
import unittest
import yaml
ROOT = Path(__file__).resolve().parents[2]

class BandwidthConfigurationTests(unittest.TestCase):
    def test_compose_mounts_persistent_policy_volume_and_defaults_to_200(self):
        for path in ('compose.yaml', 'deploy/local/compose.yaml'):
            stack = yaml.load((ROOT / path).read_text(), Loader=yaml.BaseLoader)
            app = stack['services']['app']
            self.assertEqual(app['environment'].get('TOTAL_BANDWIDTH_LIMIT_MBPS'), '${TOTAL_BANDWIDTH_LIMIT_MBPS:-200}')
            self.assertEqual(app['environment'].get('BANDWIDTH_CONFIG_FILE'), '/data/bandwidth.json')
            self.assertIn('app-data:/data', app['volumes'])
            self.assertIn('app-data', stack['volumes'])
            self.assertEqual(app['read_only'], 'true')
            self.assertNotIn('ports', app)

    def test_openshift_uses_pvc_not_emptydir_and_keeps_nonroot(self):
        config = next(yaml.load_all((ROOT / 'deploy/openshift/config.yaml').read_text(), Loader=yaml.BaseLoader))
        self.assertEqual(config['data'].get('TOTAL_BANDWIDTH_LIMIT_MBPS'), '200')
        self.assertEqual(config['data'].get('BANDWIDTH_CONFIG_FILE'), '/data/bandwidth.json')
        deployment = yaml.load((ROOT / 'deploy/openshift/deployment.yaml').read_text(), Loader=yaml.BaseLoader)
        pod = deployment['spec']['template']['spec']
        volume = next(v for v in pod['volumes'] if v['name'] == 'app-data')
        self.assertEqual(volume['persistentVolumeClaim']['claimName'], 'webzoom-data')
        app = pod['containers'][0]
        self.assertIn({'name':'app-data', 'mountPath':'/data'}, app['volumeMounts'])
        self.assertEqual(pod['securityContext']['runAsNonRoot'], 'true')
        self.assertEqual(app['securityContext']['readOnlyRootFilesystem'], 'true')
        self.assertNotIn('runAsUser', pod['securityContext'])
        self.assertNotIn('initContainers', pod)
        pvc = yaml.load((ROOT / 'deploy/openshift/pvc.yaml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(pvc['metadata']['name'], 'webzoom-data')
        self.assertEqual(pvc['spec']['accessModes'], ['ReadWriteOnce'])
        kustomization = yaml.load((ROOT / 'deploy/openshift/kustomization.yaml').read_text(), Loader=yaml.BaseLoader)
        self.assertIn('pvc.yaml', kustomization['resources'])

    def test_example_exposes_bootstrap_value(self):
        self.assertIn('TOTAL_BANDWIDTH_LIMIT_MBPS=200', (ROOT / '.env.example').read_text())
