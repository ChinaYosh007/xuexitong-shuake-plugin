"""Validate the downloaded Release assets, then atomically update the public feed."""
import argparse
import base64
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path


def gh_json(*args, body=None):
    command = ["gh", "api", *args]
    if body is not None:
        command += ["--method", "PUT", "--input", "-"]
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                            capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(result.stdout)


def parts(version):
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}", version):
        raise ValueError("Invalid release version")
    values = list(map(int, version.split(".")))
    if max(values) > 65535 or not any(values):
        raise ValueError("Invalid release version")
    return tuple((values + [0, 0, 0])[:4])


def validated_feed(assets, repository, expected_version):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid GitHub repository")
    feed = json.loads((assets / "update.json").read_text(encoding="utf-8"))
    if feed["version"] != expected_version:
        raise ValueError("Release version does not match the checkout")
    parts(expected_version)
    archive_path = assets / "study-assistant-extension.zip"
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if feed["sha256"] != digest:
        raise ValueError("ZIP digest does not match the release feed")
    checksum = (assets / "study-assistant-extension.zip.sha256").read_text(encoding="utf-8").split()
    if checksum != [digest, archive_path.name]:
        raise ValueError("Checksum file does not match the ZIP")
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC check failed")
        if json.loads(archive.read("extension/manifest.json"))["version"] != expected_version:
            raise ValueError("Packaged manifest version does not match the release")
    return {"version": expected_version,
            "zipUrl": f"https://github.com/{repository}/releases/download/v{expected_version}/{archive_path.name}",
            "sha256": digest, "notes": str(feed.get("notes", ""))[:2000]}


def publish(feed, repository, api=gh_json):
    endpoint = f"repos/{repository}/contents/updates/update.json"
    existing = api(endpoint + "?ref=main")
    previous = json.loads(base64.b64decode(existing["content"]))
    if parts(previous["version"]) > parts(feed["version"]):
        print("A newer release is already published; keeping the current feed")
        return False
    if parts(previous["version"]) == parts(feed["version"]):
        if previous["sha256"] != feed["sha256"]:
            raise ValueError("An existing version cannot be replaced with different bytes")
        if previous == feed:
            print("Public feed already matches the release")
            return False
    # GitHub rejects this write if another writer changed the file's SHA meanwhile.
    content = json.dumps(feed, ensure_ascii=False, indent=2) + "\n"
    api(endpoint, body={"message": f"Publish update feed v{feed['version']} [skip ci]", "branch": "main",
                        "sha": existing["sha"], "content": base64.b64encode(content.encode()).decode()})
    print(f"Published update feed v{feed['version']}")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    publish(validated_feed(args.assets, args.repository, args.version), args.repository)
