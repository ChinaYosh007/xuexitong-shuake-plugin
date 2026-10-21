"""Package built extension and emit a public, relative-URL update feed. No credentials."""
import hashlib
import json
import os
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
dist = root / "apps/extension/dist"
manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
release = root / "release"
release.mkdir(exist_ok=True)
output = release / "study-assistant-extension.zip"
files = sorted(p for p in dist.rglob("*") if p.is_file())
if not files or not (dist / "runner.html").exists():
    raise SystemExit("Build the extension before packaging")
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for source in files:
        archive.write(source, "extension/" + source.relative_to(dist).as_posix())
    archive.write(root / "使用说明.md", "使用说明.md")
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert len(archive.namelist()) == len(files) + 1
    for source in files:
        assert archive.read("extension/" + source.relative_to(dist).as_posix()) == source.read_bytes()
digest = hashlib.sha256(output.read_bytes()).hexdigest()
feed = {"version": manifest["version"], "zipUrl": output.name, "sha256": digest,
        "notes": os.environ.get("RELEASE_NOTES", "更新内容与安装说明请查看 GitHub 对应版本的 Release 页面。")}
(release / "update.json").write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(release / (output.name + ".sha256")).write_text(digest + "  " + output.name + "\n", encoding="utf-8")
print(f"Verified v{manifest['version']}: {len(files)+1} ZIP entries, {output.stat().st_size/1024/1024:.2f} MB")
print(f"Extension directory: {dist}")
print(f"ZIP: {output}")
print(f"Update feed: {release / 'update.json'}")
