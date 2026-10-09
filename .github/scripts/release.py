"""Plan version tags and publish releases without replacing existing Git tags."""
from dataclasses import dataclass
import re
import subprocess
import json
from pathlib import Path

IMAGE = "bobbynie/webzoom"
VERSION = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")


@dataclass(frozen=True)
class Plan:
    version: str
    sha: str
    latest: bool

    @property
    def image_tags(self):
        tags = [f"{IMAGE}:{self.version}", f"{IMAGE}:sha-{self.sha}"]
        return tags + ([f"{IMAGE}:main", f"{IMAGE}:latest"] if self.latest else [])


def select_version(tags, sha, ref):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("release requires a full commit SHA")
    if ref != "refs/heads/main":
        name = ref.removeprefix("refs/tags/")
        if not ref.startswith("refs/tags/") or not VERSION.fullmatch(name):
            raise ValueError("release requires main or a stable vMAJOR.MINOR.PATCH tag")
        if tags.get(name) != sha:
            raise ValueError("release tag does not point to the tested commit")
        return Plan(name, sha, False)
    versions = {name: tuple(map(int, match.groups())) for name in tags
                if (match := VERSION.fullmatch(name))}
    existing = [name for name in versions if tags[name] == sha]
    if existing:
        name = max(existing, key=versions.get)
        return Plan(name, sha, versions[name] == max(versions.values()))
    if not versions:
        return Plan("v0.1.0", sha, True)
    major, minor, patch = max(versions.values())
    return Plan(f"v{major}.{minor}.{patch + 1}", sha, True)


def api(endpoint, *, missing_ok=False, fields=None):
    command = ["gh", "api", "--method", "POST" if fields else "GET", endpoint]
    for key, value in (fields or {}).items():
        command += ["-f", f"{key}={value}"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        if missing_ok and "(HTTP 404)" in result.stderr:
            return None
        raise RuntimeError(f"GitHub API failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def verify_tag(repo, version, sha):
    if not VERSION.fullmatch(version) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("invalid release version or commit SHA")
    ref = api(f"repos/{repo}/git/ref/tags/{version}", missing_ok=True)
    if ref is None:
        return False
    target = ref["object"]
    for _ in range(8):
        if target["type"] == "commit":
            if target["sha"] != sha:
                raise ValueError("existing Git tag belongs to a different commit; refusing to replace it")
            return True
        if target["type"] != "tag":
            break
        target = api(f"repos/{repo}/git/tags/{target['sha']}")["object"]
    raise ValueError("Git tag does not resolve to a commit")


def ensure_tag(repo, version, sha):
    if not verify_tag(repo, version, sha):
        api(f"repos/{repo}/git/refs", fields={"ref": f"refs/tags/{version}", "sha": sha})


def existing_release(repo, version, sha):
    item = api(f"repos/{repo}/releases/tags/{version}", missing_ok=True)
    if item is not None:
        if not verify_tag(repo, version, sha):
            raise ValueError("published release has no matching Git tag")
        if item["draft"] or item["prerelease"]:
            raise ValueError("existing release is a draft or prerelease; refusing to replace it")
    return item


def publish_release(repo, version, sha, latest, directory):
    digest = (directory / "image-digest.txt").read_text().strip()
    if not re.fullmatch(re.escape(IMAGE) + r"@sha256:[0-9a-f]{64}", digest):
        raise ValueError("release requires the pushed Docker Hub image digest")
    if not verify_tag(repo, version, sha):
        raise ValueError("create the verified Git tag before publishing a release")
    item = existing_release(repo, version, sha)
    if item:
        return item["html_url"]
    notes = directory / "release-notes.md"
    notes.write_text(
        f"## Verified container\n\n"
        f"- Docker Hub image: `{IMAGE}:{version}`\n"
        f"- Exact image: `{digest}`\n"
        f"- Tested commit: `{sha}`\n"
        "- Platform: `linux/amd64`.\n"
        "- Default UID/GID: `65532:65532`.\n"
        "- Tested with an arbitrary non-root UID and a read-only root filesystem.\n"
        "- Quality checks and container tests passed before publication.\n"
        "- Production capacity and OpenShift cluster acceptance remain separate requirements.\n"
    )
    result = subprocess.run([
        "gh", "release", "create", version, str(directory / "image-digest.txt"),
        "--repo", repo, "--verify-tag", "--target", sha, "--title", f"WebZoom {version}",
        "--generate-notes", "--notes-file", str(notes), f"--latest={str(latest).lower()}",
    ], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def prepare_plan(tags, sha, ref, repo):
    plan = select_version(tags, sha, ref)
    item = existing_release(repo, plan.version, sha)
    if item:
        return plan, item
    if ref == "refs/heads/main" and api(f"repos/{repo}/commits/main")["sha"] != sha:
        raise ValueError("tested commit is no longer main HEAD; run the workflow on current main")
    return plan, None


def git_output(*arguments):
    return subprocess.run(["git", *arguments], check=True, capture_output=True, text=True).stdout.strip()


def local_tags(sha):
    if git_output("rev-parse", "HEAD") != sha:
        raise ValueError("checkout does not match the tested commit")
    return {tag: git_output("rev-parse", f"{tag}^{{commit}}")
            for tag in git_output("tag", "--list").splitlines() if VERSION.fullmatch(tag)}


def summary(env, text):
    if path := env.get("GITHUB_STEP_SUMMARY"):
        with Path(path).open("a") as output:
            output.write(text + "\n")


def main(arguments, env):
    if len(arguments) != 1 or arguments[0] not in {"plan", "tag", "publish"}:
        raise ValueError("usage: release.py plan|tag|publish")
    repo, sha = env["GITHUB_REPOSITORY"], env["GITHUB_SHA"]
    if arguments[0] == "plan":
        plan, item = prepare_plan(local_tags(sha), sha, env["GITHUB_REF"], repo)
        with Path(env["GITHUB_OUTPUT"]).open("a") as output:
            output.write(f"version={plan.version}\nlatest={str(plan.latest).lower()}\npublished={str(item is not None).lower()}\n")
            output.write("tags<<RELEASE_TAGS\n" + "\n".join(plan.image_tags) + "\nRELEASE_TAGS\n")
        if item:
            summary(env, f"Release `{plan.version}` already exists for this commit. Images and release were not changed.\n\n{item['html_url']}")
        return
    version = env["RELEASE_VERSION"]
    if arguments[0] == "tag":
        ensure_tag(repo, version, sha)
        return
    url = publish_release(repo, version, sha, env["RELEASE_LATEST"] == "true", Path("artifacts/image"))
    digest = Path("artifacts/image/image-digest.txt").read_text().strip()
    summary(env, f"## Published WebZoom {version}\n\nRelease: {url}\n\nImage: `{digest}`\n\nPlatform: linux/amd64. Default UID/GID: 65532:65532.\n\nTested with an arbitrary non-root UID and a read-only root filesystem.")


if __name__ == "__main__":
    import os
    import sys

    try:
        main(sys.argv[1:], os.environ)
    except (ValueError, RuntimeError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Release failed: {error}", file=sys.stderr)
        sys.exit(1)
