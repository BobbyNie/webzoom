"""Keep deployment guidance aligned with administrator and storage behavior."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DocumentationTests(unittest.TestCase):
    def test_local_certificate_setup_and_replacement_are_documented(self):
        text = (ROOT / 'deploy/local/README.md').read_text()
        for requirement in (
            'basicConstraints=critical,CA:FALSE',
            'extendedKeyUsage=serverAuth',
            '钥匙串访问', 'SHA-256', '撤销',
            'curl --cacert 成功不表示浏览器已信任证书',
            'up -d --force-recreate app proxy',
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, text)
        commands = re.findall(r'```sh\n(.*?)```', text, re.S)
        strict_checks = [command for command in commands
                         if '/usr/bin/curl --fail' in command]
        self.assertTrue(strict_checks, 'Document a system-trust HTTPS check')
        for command in strict_checks:
            self.assertNotIn('--cacert', command)
            self.assertNotIn('--insecure', command)
            self.assertNotRegex(command, r'\s-k(?:\s|$)')

    def test_admin_permissions_distinguish_bandwidth_from_capacity(self):
        text = (ROOT / 'docs/DEPLOYMENT.md').read_text()
        self.assertNotIn('转交共享权或改变会议限制', text)
        self.assertIn('管理员可以修改全局媒体流量接入上限', text)
        self.assertIn('不能修改会议数量或人数限制', text)

    def test_baseline_includes_admin_and_persistent_policy(self):
        text = (ROOT / 'docs/PLAN.md').read_text()
        self.assertNotIn('Only the owner transfers publishing or ends a room.', text)
        self.assertIn('Administrators can end selected rooms', text)
        self.assertIn('200 Mbps', text)
        self.assertIn('bandwidth.json', text)
        self.assertIn('Saved values take precedence', text)
