"""Security scans must block vulnerable images without hiding any severity."""
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[2]


class SecurityTests(unittest.TestCase):
    def scanner(self):
        path = ROOT / '.github/scripts/scan_images.py'
        self.assertTrue(path.is_file(), 'add an image vulnerability release gate')
        spec = importlib.util.spec_from_file_location('scan_images', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_all_maintained_images_are_scanned_without_exclusions(self):
        module = self.scanner()
        with tempfile.TemporaryDirectory() as output, patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(module.scan('trivy', Path(output)), 0)
        self.assertEqual(len(run.call_args_list), 4)
        self.assertEqual({call.args[0][-1] for call in run.call_args_list}, {'webzoom:local', 'webzoom:frontend', 'webzoom:backend', 'webzoom-proxy:local'})
        for call in run.call_args_list:
            args = call.args[0]
            self.assertEqual(args[1:4], ['image', '--scanners', 'vuln'])
            self.assertEqual(args[args.index('--exit-code') + 1], '1')
            self.assertEqual(args[args.index('--severity') + 1], 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL')
            self.assertNotIn('--ignore-unfixed', args)
            self.assertNotIn('--skip-db-update', args)

    def test_workspace_ignore_files_cannot_hide_findings(self):
        module = self.scanner()
        with tempfile.TemporaryDirectory() as output, patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(module.scan('trivy', Path(output)), 0)
        for call in run.call_args_list:
            args = call.args[0]
            self.assertIn('--config', args, 'disable implicit workspace scanner configuration')
            self.assertEqual(args[args.index('--config') + 1], '')
            self.assertIn('--ignorefile', args, 'do not load implicit vulnerability exclusions')
            self.assertEqual(args[args.index('--ignorefile') + 1], os.devnull)

    @unittest.skipUnless(os.environ.get('TRIVY_BINARY'), 'set TRIVY_BINARY for the real CLI compatibility check')
    def test_scan_arguments_are_supported_by_the_pinned_real_cli(self):
        binary = os.environ['TRIVY_BINARY']
        help_text = subprocess.run([binary, 'image', '--help'], capture_output=True, text=True, check=True).stdout
        supported = set(re.findall(r'--[a-z][a-z-]*', help_text))
        module = self.scanner()
        with tempfile.TemporaryDirectory() as output, patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(module.scan(binary, Path(output)), 0)
        for call in run.call_args_list:
            flags = {arg for arg in call.args[0] if arg.startswith('--')}
            self.assertEqual(flags - supported, set(), 'image scans must use flags supported by the pinned Trivy CLI')

    def test_finding_or_scanner_failure_blocks_release_and_other_images_still_run(self):
        module = self.scanner()
        for code in (1, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as output, patch.object(module.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], code)] + [subprocess.CompletedProcess([], 0)] * 3) as run:
                self.assertEqual(module.scan('trivy', Path(output)), 1)
                self.assertEqual(run.call_count, 4)

    def test_ci_scans_before_export_and_keeps_failure_reports(self):
        workflow = yaml.load((ROOT / '.github/workflows/container.yml').read_text(), Loader=yaml.BaseLoader)
        steps = workflow['jobs']['image']['steps']
        scan = next((i for i, s in enumerate(steps) if 'scan_images.py' in s.get('run', '')), None)
        self.assertIsNotNone(scan, 'scan actual candidate and build-stage images before publication')
        export = next(i for i, s in enumerate(steps) if 'docker save' in s.get('run', ''))
        self.assertLess(scan, export)
        uploads = [s for s in steps if s.get('uses', '').startswith('actions/upload-artifact@') and s.get('with', {}).get('name') == 'security-reports']
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0]['if'], 'always()')
        self.assertNotIn('continue-on-error', steps[scan])
        quality = str(workflow['jobs']['quality'])
        self.assertIn('npm audit --audit-level=low', quality)
        self.assertIn('npm audit --prefix ../.github/security/npm --audit-level=low', quality)
        self.assertIn('TRIVY_BINARY=', steps[scan]['run'])
        self.assertIn('test_security.py', steps[scan]['run'])

    def test_build_and_proxy_packages_use_fixed_versions(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertRegex(dockerfile, r'FROM node:22-alpine@sha256:[0-9a-f]{64} AS frontend')
        self.assertRegex(dockerfile, r'FROM golang:1\.26\.10-alpine@sha256:[0-9a-f]{64} AS backend')
        self.assertEqual(dockerfile.count("'zlib>=1.3.2-r1'"), 2)
        self.assertEqual(dockerfile.count("'musl>=1.2.6-r3'"), 2)
        self.assertEqual(dockerfile.count("'musl-utils>=1.2.6-r3'"), 2)
        self.assertIn('npm@12.2.0', dockerfile)
        self.assertIn('USER 65532:65532', dockerfile)
        proxy = ROOT / 'Dockerfile.proxy'
        self.assertTrue(proxy.exists(), 'build a patched proxy instead of using the vulnerable upstream image')
        text = proxy.read_text()
        self.assertIn('apk upgrade --no-cache && apk add --no-cache', text)
        self.assertIn("'zlib>=1.3.2-r1'", text)
        for package in ('musl>=1.2.6-r3', 'musl-utils>=1.2.6-r3', 'libexpat>=2.9.0-r0', 'libx11>=1.8.14-r0', 'libxpm>=3.5.20-r0', 'nginx>=1.30.6-r0'):
            self.assertIn("'" + package + "'", text)
        self.assertTrue(text.rstrip().endswith('USER 101:101'))
        for filename in ('compose.yaml', 'deploy/local/compose.yaml'):
            service = yaml.safe_load((ROOT / filename).read_text())['services']['proxy']
            self.assertEqual(service['image'], 'webzoom-proxy:local')
            self.assertEqual(service['build']['dockerfile'], 'Dockerfile.proxy')
        self.assertIn('const nginxImage = "webzoom-proxy:local"', (ROOT / 'internal/deploy/deploy_test.go').read_text())

    def test_proxy_drops_only_unused_version_coupled_modules(self):
        proxy = (ROOT / 'Dockerfile.proxy').read_text()
        self.assertIn('apk del --no-cache nginx-module-geoip nginx-module-image-filter nginx-module-njs nginx-module-xslt', proxy)
        for filename in ('deploy/nginx.conf', 'deploy/local/nginx.conf'):
            text = (ROOT / filename).read_text()
            self.assertNotRegex(text, r'(?m)^\s*(?:load_module|geoip\w*|image_filter|js_\w*|xslt\w*)\s')

    def test_npm_build_tool_patches_are_locked_without_changing_app_dependencies(self):
        path = ROOT / '.github/security/npm/package-lock.json'
        self.assertTrue(path.is_file(), 'lock the patched npm build tool separately from application dependencies')
        lock = json.loads(path.read_text())
        self.assertEqual(lock['packages']['']['name'], 'npm')
        self.assertEqual(lock['packages']['']['version'], '12.2.0')
        versions = {'brace-expansion': '5.0.12', 'http-cache-semantics': '4.3.0', 'ip-address': '10.7.4', 'postcss-selector-parser': '7.1.6', 'undici': '6.28.1'}
        for name, version in versions.items():
            packages = [p for path, p in lock['packages'].items() if path.endswith('/' + name)]
            self.assertTrue(packages, name + ' must be present in the build tool lock')
            for package in packages:
                self.assertEqual(package['version'], version, name + ' must use the patched version')
                self.assertTrue(package.get('integrity'), name + ' must have an integrity hash')
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('COPY .github/security/npm/', dockerfile)
        self.assertIn('npm ci --prefix /usr/local/lib/node_modules/npm --ignore-scripts', dockerfile)

    def test_demo_uses_official_keycloak_rebuild_with_available_fixes(self):
        stack = yaml.safe_load((ROOT / 'deploy/local/compose.yaml').read_text())
        self.assertEqual(stack['services']['keycloak']['image'], 'quay.io/keycloak/keycloak:26.8.0@sha256:27b3230fbabb8c9ff3c66c864cf09dcd8a41aca82e5100679d109ef0eeb05741')
        self.assertEqual(stack['services']['proxy']['ports'], ['127.0.0.1:8443:8443'])

    def test_scanner_download_is_version_and_checksum_pinned(self):
        path = ROOT / '.github/scripts/install-trivy.sh'
        self.assertTrue(path.exists(), 'verify the scanner download before execution')
        text = path.read_text()
        self.assertIn('0.75.0', text)
        self.assertIn('sha256sum --check', text)
        self.assertNotRegex(text, r'\|\s*(?:ba)?sh(?:\s|$)')
        self.assertRegex(text, r'[0-9a-f]{64}')


if __name__ == '__main__':
    unittest.main()
