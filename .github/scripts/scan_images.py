"""Scan the exact images used by CI. Any finding or tool failure blocks release."""
from pathlib import Path
import os
import subprocess
import sys

IMAGES = {
    'application': 'webzoom:local',
    'frontend-builder': 'webzoom:frontend',
    'backend-builder': 'webzoom:backend',
    'proxy': 'webzoom-proxy:local',
}


def scan(trivy: str, output: Path) -> int:
    output.mkdir(parents=True, exist_ok=True)
    failed = False
    for name, image in IMAGES.items():
        result = subprocess.run([
            trivy, 'image', '--scanners', 'vuln',
            '--config', '', '--ignorefile', os.devnull,
            '--severity', 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL', '--exit-code', '1',
            '--no-progress', '--timeout', '10m', '--format', 'json',
            '--output', str(output / f'{name}.json'), image,
        ], check=False)
        if result.returncode != 0:
            print(f'Security scan failed: {name}. See scanner output and report.', file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: scan_images.py TRIVY_BINARY REPORT_DIRECTORY')
    raise SystemExit(scan(sys.argv[1], Path(sys.argv[2])))
