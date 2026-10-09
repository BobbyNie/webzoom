"""Release builds must use the patched and consistently pinned Go compiler."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class GoToolchainTests(unittest.TestCase):
    def test_release_compiler_has_security_fixes_and_matches_container(self):
        module = (ROOT / "go.mod").read_text()
        match = re.search(r"^toolchain go(\d+)\.(\d+)\.(\d+)$", module, re.MULTILINE)
        self.assertIsNotNone(match, "pin the release toolchain")
        version = tuple(map(int, match.groups()))
        self.assertGreaterEqual(version, (1, 26, 9), "Go 1.26.8 has reachable standard-library vulnerabilities")
        image = re.search(r"^FROM golang:(\d+\.\d+\.\d+)-bookworm@sha256:([0-9a-f]{64}) AS backend$", (ROOT / "Dockerfile").read_text(), re.MULTILINE)
        self.assertIsNotNone(image, "pin the compiler image by version and digest")
        self.assertEqual(image.group(1), ".".join(map(str, version)))


if __name__ == "__main__":
    unittest.main()
