import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_script("publish-update-feed")
versioning = load_script("version-extension")
REPOSITORY = "ChinaYosh007/xuexitong-shuake-plugin"


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.assets = Path(self.directory.name)
        self.version = "0.2.5"
        self.zip = self.assets / "study-assistant-extension.zip"
        with zipfile.ZipFile(self.zip, "w") as archive:
            archive.writestr("extension/manifest.json", json.dumps({"version": self.version}))
        self.digest = hashlib.sha256(self.zip.read_bytes()).hexdigest()
        self.feed = {"version": self.version, "zipUrl": self.zip.name, "sha256": self.digest, "notes": "测试发布"}
        (self.assets / "update.json").write_text(json.dumps(self.feed), encoding="utf-8")
        (self.assets / (self.zip.name + ".sha256")).write_text(self.digest + "  " + self.zip.name, encoding="utf-8")

    def test_public_feed_uses_verified_versioned_asset(self):
        result = release.validated_feed(self.assets, REPOSITORY, self.version)
        self.assertEqual(result["zipUrl"], f"https://github.com/{REPOSITORY}/releases/download/v0.2.5/{self.zip.name}")
        self.assertEqual(result["sha256"], self.digest)

    def test_corrupted_zip_never_gets_advertised(self):
        self.zip.write_bytes(self.zip.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "digest"):
            release.validated_feed(self.assets, REPOSITORY, self.version)

    def test_mismatched_checksum_or_manifest_is_rejected(self):
        (self.assets / (self.zip.name + ".sha256")).write_text("0" * 64 + "  " + self.zip.name)
        with self.assertRaisesRegex(ValueError, "Checksum"):
            release.validated_feed(self.assets, REPOSITORY, self.version)
        with self.assertRaisesRegex(ValueError, "checkout"):
            release.validated_feed(self.assets, REPOSITORY, "0.2.6")

    def api(self, previous):
        return Mock(return_value={"sha": "current-git-file-sha", "content": base64.b64encode(json.dumps(previous).encode()).decode()})

    def test_feed_update_is_atomic_and_preserves_unicode(self):
        api = self.api({**self.feed, "version": "0.2.4"})
        self.assertTrue(release.publish(self.feed, REPOSITORY, api))
        body = api.call_args.kwargs["body"]
        self.assertEqual(body["sha"], "current-git-file-sha")
        self.assertEqual(body["branch"], "main")
        self.assertEqual(json.loads(base64.b64decode(body["content"])), self.feed)

    def test_older_run_cannot_downgrade_feed(self):
        api = self.api({**self.feed, "version": "0.3.0"})
        self.assertFalse(release.publish(self.feed, REPOSITORY, api))
        self.assertEqual(api.call_count, 1)

    def test_repeat_run_is_idempotent_and_republished_bytes_are_rejected(self):
        api = self.api(self.feed)
        self.assertFalse(release.publish(self.feed, REPOSITORY, api))
        with self.assertRaisesRegex(ValueError, "different bytes"):
            release.publish({**self.feed, "sha256": "0" * 64}, REPOSITORY, api)

    def test_version_command_synchronizes_all_six_fields(self):
        documents = {
            "package.json": {"version": "0.2.4"},
            "apps/extension/package.json": {"version": "0.2.4"},
            "apps/extension/manifest.base.json": {"version": "0.2.4"},
            "package-lock.json": {"version": "0.2.4", "packages": {"": {"version": "0.2.4"}, "apps/extension": {"version": "0.2.4"}}}}
        for path, data in documents.items():
            target = self.assets / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(versioning.set_version(self.assets, "0.2.5"), "0.2.5")
        self.assertEqual(versioning.set_version(self.assets), "0.2.5")
        for value in ("0.2.5", "0.2.4", "01.2.6", "0.2.6-beta", "65536.0.1"):
            with self.assertRaises(ValueError):
                versioning.set_version(self.assets, value)

    def test_version_mismatch_fails_before_any_write(self):
        self.test_version_command_synchronizes_all_six_fields()
        manifest = self.assets / "apps/extension/manifest.base.json"
        manifest.write_text('{"version":"0.2.3"}')
        original = (self.assets / "package.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "mismatch"):
            versioning.set_version(self.assets, "0.2.6")
        self.assertEqual((self.assets / "package.json").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
