"""The local demo must not expose test identities outside the host."""
import json
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class LocalStackTests(unittest.TestCase):
    def test_isolated_https_stack_and_real_oidc(self):
        path = ROOT / 'deploy/local/compose.yaml'
        self.assertTrue(path.exists(), 'local Docker stack is missing')
        stack = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        services = stack['services']
        self.assertEqual(services['proxy']['ports'], ['127.0.0.1:8443:8443'])
        self.assertEqual(services['proxy']['tmpfs'], ['/tmp:uid=101,gid=101,mode=1770'])
        for name in ('app', 'keycloak'):
            self.assertNotIn('ports', services[name])
        app = services['app']
        self.assertEqual(app['user'], '65532:65532')
        self.assertEqual(app['read_only'], 'true')
        self.assertEqual(app['cap_drop'], ['ALL'])
        self.assertIn('no-new-privileges:true', app['security_opt'])
        self.assertEqual(app['environment']['PUBLIC_URL'], 'https://webzoom.localhost:8443')
        self.assertEqual(app['environment']['OIDC_ISSUER'], 'https://webzoom.localhost:8443/idp/realms/webzoom-local')
        self.assertIn('@sha256:', services['keycloak']['image'])
        self.assertEqual(services['keycloak']['environment']['KC_HOSTNAME'], 'https://webzoom.localhost:8443/idp')
        realm = json.loads((ROOT / 'deploy/local/realm.json').read_text())
        self.assertFalse(realm['registrationAllowed'])
        client = realm['clients'][0]
        self.assertFalse(client['publicClient'])
        self.assertFalse(client['directAccessGrantsEnabled'])
        self.assertEqual(client['redirectUris'], ['https://webzoom.localhost:8443/auth/callback'])
        self.assertEqual(client['attributes']['pkce.code.challenge.method'], 'S256')
        self.assertEqual({u['username'] for u in realm['users']}, {'alice', 'bob'})
        for u in realm['users']:
            self.assertEqual(u.get('realmRoles', []), [])


if __name__ == '__main__':
    unittest.main()
