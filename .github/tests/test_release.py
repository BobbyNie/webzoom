"""Version and retry contracts for Docker Hub and GitHub releases."""
import importlib.util
import os
from pathlib import Path
import sys
import subprocess
import json
import tempfile
from unittest.mock import patch
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("webzoom_release", ROOT / ".github/scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release
SPEC.loader.exec_module(release)


class ReleaseVersionTests(unittest.TestCase):
    def test_first_main_release_has_matching_version_and_image_tags(self):
        plan = release.select_version({}, "a" * 40, "refs/heads/main")
        self.assertEqual(plan.version, "v0.1.0")
        self.assertEqual(plan.image_tags, ["bobbynie/webzoom:v0.1.0", "bobbynie/webzoom:sha-" + "a" * 40,
                                          "bobbynie/webzoom:main", "bobbynie/webzoom:latest"])
        self.assertTrue(plan.latest)

    def test_next_version_uses_semantic_order_and_ignores_non_release_tags(self):
        plan = release.select_version({"v0.1.9": "b" * 40, "v0.1.10": "c" * 40,
                                       "v01.99.99": "d" * 40, "v9.0.0-beta": "e" * 40},
                                      "a" * 40, "refs/heads/main")
        self.assertEqual(plan.version, "v0.1.11")

    def test_main_retry_reuses_its_version_without_rolling_back_latest(self):
        tags = {"v0.1.0": "a" * 40, "v0.1.1": "b" * 40}
        plan = release.select_version(tags, "a" * 40, "refs/heads/main")
        self.assertEqual(plan.version, "v0.1.0")
        self.assertFalse(plan.latest)
        self.assertEqual(len(plan.image_tags), 2)
        self.assertTrue(release.select_version(tags, "b" * 40, "refs/heads/main").latest)

    def test_explicit_stable_tag_never_moves_latest(self):
        plan = release.select_version({"v1.0.0": "a" * 40}, "a" * 40, "refs/tags/v1.0.0")
        self.assertEqual(plan.version, "v1.0.0")
        self.assertFalse(plan.latest)

    def test_unapproved_refs_and_tag_commit_mismatches_are_rejected(self):
        for ref in ("refs/heads/feature", "refs/tags/v1.0.0-rc1", "refs/tags/v01.0.0", "refs/tags/vmissing"):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                release.select_version({}, "a" * 40, ref)
        with self.assertRaises(ValueError):
            release.select_version({"v1.0.0": "b" * 40}, "a" * 40, "refs/tags/v1.0.0")
        with self.assertRaises(ValueError):
            release.select_version({}, "malformed", "refs/heads/main")


class ReleasePublishingTests(unittest.TestCase):
    def test_missing_tag_is_created_at_tested_sha(self):
        replies = [subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)"),
                   subprocess.CompletedProcess([], 0, '{}', "")]
        with patch("subprocess.run", side_effect=replies) as run:
            release.ensure_tag("BobbyNie/webzoom", "v0.1.0", "a" * 40)
        command = run.call_args_list[-1].args[0]
        self.assertIn("POST", command)
        self.assertIn("ref=refs/tags/v0.1.0", command)
        self.assertIn("sha=" + "a" * 40, command)

    def test_existing_annotated_tag_is_verified_without_writing(self):
        replies = [subprocess.CompletedProcess([], 0, json.dumps({"object": {"type": "tag", "sha": "b" * 40}}), ""),
                   subprocess.CompletedProcess([], 0, json.dumps({"object": {"type": "commit", "sha": "a" * 40}}), "")]
        with patch("subprocess.run", side_effect=replies) as run:
            release.ensure_tag("BobbyNie/webzoom", "v0.1.0", "a" * 40)
        self.assertEqual(run.call_count, 2)
        self.assertTrue(all("POST" not in call.args[0] for call in run.call_args_list))

    def test_tag_conflicts_and_api_errors_never_create_or_overwrite_tags(self):
        replies = [subprocess.CompletedProcess([], 0, json.dumps({"object": {"type": "commit", "sha": "b" * 40}}), ""),
                   subprocess.CompletedProcess([], 1, "", "gh: Forbidden (HTTP 403)")]
        for result in replies:
            with self.subTest(result=result), patch("subprocess.run", return_value=result) as run:
                with self.assertRaises((ValueError, RuntimeError)):
                    release.ensure_tag("BobbyNie/webzoom", "v0.1.0", "a" * 40)
                self.assertEqual(run.call_count, 1)

    def test_release_requires_digest_and_creates_notes_with_exact_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = "bobbynie/webzoom@sha256:" + "b" * 64
            (root / "image-digest.txt").write_text(image + "\n")
            replies = [subprocess.CompletedProcess([], 0, json.dumps({"object": {"type": "commit", "sha": "a" * 40}}), ""),
                       subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)"),
                       subprocess.CompletedProcess([], 0, "https://github.com/BobbyNie/webzoom/releases/tag/v0.1.0\n", "")]
            with patch("subprocess.run", side_effect=replies) as run:
                release.publish_release("BobbyNie/webzoom", "v0.1.0", "a" * 40, True, root)
            command = run.call_args_list[-1].args[0]
            self.assertIn("--verify-tag", command)
            self.assertIn("--generate-notes", command)
            self.assertIn("--latest=true", command)
            self.assertIn(str(root / "image-digest.txt"), command)
            self.assertIn(image, (root / "release-notes.md").read_text())

    def test_invalid_digest_and_missing_tag_never_create_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "image-digest.txt").write_text("other/image@sha256:" + "b" * 64)
            with patch("subprocess.run") as run, self.assertRaises(ValueError):
                release.publish_release("BobbyNie/webzoom", "v0.1.0", "a" * 40, False, root)
            run.assert_not_called()
            (root / "image-digest.txt").write_text("bobbynie/webzoom@sha256:" + "b" * 64)
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)")) as run:
                with self.assertRaises(ValueError):
                    release.publish_release("BobbyNie/webzoom", "v0.1.0", "a" * 40, False, root)
                self.assertEqual(run.call_count, 1)

    def test_published_release_retry_is_a_read_only_no_op(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "image-digest.txt").write_text("bobbynie/webzoom@sha256:" + "b" * 64)
            ref = {"object": {"type": "commit", "sha": "a" * 40}}
            item = {"draft": False, "prerelease": False, "html_url": "https://github.com/BobbyNie/webzoom/releases/tag/v0.1.0"}
            replies = [subprocess.CompletedProcess([], 0, json.dumps(value), "") for value in (ref, item, ref)]
            with patch("subprocess.run", side_effect=replies) as run:
                self.assertEqual(release.publish_release("BobbyNie/webzoom", "v0.1.0", "a" * 40, False, root), item["html_url"])
            self.assertTrue(all(call.args[0][1:2] == ["api"] for call in run.call_args_list))
            self.assertFalse((root / "release-notes.md").exists())

    def test_stale_main_commit_cannot_publish_new_version(self):
        replies = [subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)"),
                   subprocess.CompletedProcess([], 0, json.dumps({"sha": "b" * 40}), "")]
        with patch("subprocess.run", side_effect=replies), self.assertRaises(ValueError):
            release.prepare_plan({}, "a" * 40, "refs/heads/main", "BobbyNie/webzoom")

    def test_cli_plan_writes_version_tags_and_published_status(self):
        sha = "a" * 40
        replies = [subprocess.CompletedProcess([], 0, sha + "\n", ""),
                   subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)"),
                   subprocess.CompletedProcess([], 0, json.dumps({"sha": sha}), "")]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            env = {"GITHUB_REPOSITORY": "BobbyNie/webzoom", "GITHUB_SHA": sha,
                   "GITHUB_REF": "refs/heads/main", "GITHUB_OUTPUT": str(output)}
            with patch("subprocess.run", side_effect=replies):
                release.main(["plan"], env)
            text = output.read_text()
            self.assertIn("version=v0.1.0", text)
            self.assertIn("published=false", text)
            self.assertIn("latest=true", text)
            self.assertIn("bobbynie/webzoom:v0.1.0", text)
            self.assertIn("bobbynie/webzoom:latest", text)

    def test_local_tag_scan_resolves_lightweight_and_annotated_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.run(["git", "-C", directory, "-c", "user.name=Release Test",
                                       "-c", "user.email=release-test@example.invalid", *args],
                                      check=True, capture_output=True, text=True).stdout.strip()
            git("init")
            git("commit", "--allow-empty", "-m", "test release")
            sha = git("rev-parse", "HEAD")
            git("tag", "v0.1.3")
            git("tag", "-a", "v0.1.4", "-m", "annotated release")
            git("tag", "not-a-release")
            with patch.dict(os.environ, {"GIT_DIR": str(Path(directory) / ".git")}):
                self.assertEqual(release.local_tags(sha), {"v0.1.3": sha, "v0.1.4": sha})
                with self.assertRaises(ValueError):
                    release.local_tags("b" * 40)

    def test_cli_published_plan_skips_image_and_release_changes(self):
        sha = "a" * 40
        ref = {"object": {"type": "commit", "sha": sha}}
        item = {"draft": False, "prerelease": False, "html_url": "https://github.com/BobbyNie/webzoom/releases/tag/v0.1.0"}
        replies = [subprocess.CompletedProcess([], 0, sha + "\n", ""),
                   subprocess.CompletedProcess([], 0, "v0.1.0\n", ""),
                   subprocess.CompletedProcess([], 0, sha + "\n", ""),
                   subprocess.CompletedProcess([], 0, json.dumps(item), ""),
                   subprocess.CompletedProcess([], 0, json.dumps(ref), "")]
        with tempfile.TemporaryDirectory() as directory:
            output, summary = Path(directory) / "output", Path(directory) / "summary"
            env = {"GITHUB_REPOSITORY": "BobbyNie/webzoom", "GITHUB_SHA": sha,
                   "GITHUB_REF": "refs/heads/main", "GITHUB_OUTPUT": str(output),
                   "GITHUB_STEP_SUMMARY": str(summary)}
            with patch("subprocess.run", side_effect=replies):
                release.main(["plan"], env)
            self.assertIn("published=true", output.read_text())
            self.assertIn("Images and release were not changed", summary.read_text())


if __name__ == "__main__":
    unittest.main()
