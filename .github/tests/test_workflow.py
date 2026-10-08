"""Security and release contracts for the container workflow."""
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


class ContainerWorkflowTests(unittest.TestCase):
    def test_only_verified_images_can_be_published(self):
        path = ROOT / ".github/workflows/container.yml"
        self.assertTrue(path.is_file(), "container workflow is missing")
        workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        triggers = workflow["on"]
        self.assertIn("pull_request", triggers)
        self.assertIn("workflow_dispatch", triggers)
        self.assertEqual(triggers["push"]["branches"], ["main"])
        self.assertNotIn("pull_request_target", triggers)
        jobs = workflow["jobs"]
        publish = jobs["publish"]
        self.assertEqual(set(publish["needs"]), {"quality", "image"})
        self.assertIn("github.event_name != 'pull_request'", publish["if"])
        self.assertIn("refs/heads/main", publish["if"])
        self.assertEqual(publish["permissions"], {"contents": "read", "packages": "write"})
        for name, job in jobs.items():
            if name != "publish":
                self.assertNotEqual(job.get("permissions", {}).get("packages"), "write")
            for step in job["steps"]:
                if "uses" in step:
                    self.assertRegex(step["uses"], r"^[\w/-]+@[0-9a-f]{40}$")
        image_steps = jobs["image"]["steps"]
        smoke = next(i for i, step in enumerate(image_steps) if "deploymenttests" in step.get("run", ""))
        upload = next(i for i, step in enumerate(image_steps) if step.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertLess(smoke, upload)
        self.assertTrue(any("docker save" in step.get("run", "") for step in image_steps))
        publish_text = "\n".join(step.get("run", "") for step in publish["steps"])
        self.assertIn("docker load", publish_text)
        self.assertIn("docker push", publish_text)
        self.assertNotIn("docker build", publish_text)
        self.assertFalse(any(step.get("uses", "").startswith("docker/build-push-action@") for step in publish["steps"]))


if __name__ == "__main__":
    unittest.main()
