"""Keep npm, lockfile and Chrome versions aligned. No git or network actions."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def version_parts(value):
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", value):
        raise ValueError("Use a three-part numeric version, for example 0.2.6")
    parts = tuple(map(int, value.split(".")))
    if max(parts) > 65535 or not any(parts):
        raise ValueError("Version is outside Chrome's supported range")
    return parts


def set_version(root, target=None):
    paths = ["package.json", "apps/extension/package.json", "apps/extension/manifest.base.json", "package-lock.json"]
    documents = {path: json.loads((root / path).read_text(encoding="utf-8")) for path in paths}
    current = documents[paths[0]]["version"]
    versions = [document["version"] for document in documents.values()]
    versions += [documents["package-lock.json"]["packages"][key]["version"] for key in ("", "apps/extension")]
    if any(value != current for value in versions):
        raise ValueError("Version mismatch in package, manifest or lockfile")
    version_parts(current)
    if target is not None:
        if version_parts(target) <= version_parts(current):
            raise ValueError("New version must be higher than the current version")
        for document in documents.values():
            document["version"] = target
        for key in ("", "apps/extension"):
            documents["package-lock.json"]["packages"][key]["version"] = target
        for path, document in documents.items():
            (root / path).write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target or current


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: python scripts/version-extension.py --check | 0.2.6")
        print(set_version(ROOT, None if sys.argv[1] == "--check" else sys.argv[1]))
    except (ValueError, KeyError) as error:
        sys.exit(str(error))
