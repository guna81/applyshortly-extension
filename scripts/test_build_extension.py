import argparse
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import build_extension


class BuildTest(unittest.TestCase):
    def test_source_archive_can_build_and_test_without_platform_repository(self):
        import subprocess

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = build_extension.build(root / "out", "https://platform.example", source=True)
            version = json.loads((build_extension.ROOT / "extension/manifest.json").read_text())["version"]
            source = root / "out" / f"applyshortly-extension-source-{version}.zip"
            with zipfile.ZipFile(source) as archive:
                names = archive.namelist()
                self.assertIn("package-lock.json", names)
                self.assertIn("Makefile", names)
                self.assertIn(".github/workflows/ci.yml", names)
                self.assertFalse(any(name.startswith(("frontend/", "backend/", ".git/")) for name in names))
                self.assertFalse(any(Path(name).name == ".env" for name in names))
                archive.extractall(root / "source")
            subprocess.run(
                ["make", "extension-source", "platform_url=https://platform.example"],
                cwd=root / "source", check=True, capture_output=True,
            )
            rebuilt = root / "source/dist" / package.name
            self.assertEqual(package.read_bytes(), rebuilt.read_bytes())

    def test_repeatable_and_no_local_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = root / "repo"
            fixture.mkdir()
            shutil.copytree(build_extension.ROOT / "extension", fixture / "extension")
            (fixture / "extension/config.local.json").write_text('{"token":"fixture-secret"}')
            with patch.object(build_extension, "ROOT", fixture):
                package = build_extension.build(root / "out")
                before = package.read_bytes()
                self.assertEqual(before, build_extension.build(root / "out").read_bytes())
                with zipfile.ZipFile(package) as archive:
                    self.assertIn("manifest.json", archive.namelist())
                    manifest = json.loads(archive.read("manifest.json"))
                    references = [
                        manifest["background"]["service_worker"],
                        manifest["action"]["default_popup"],
                        manifest["options_ui"]["page"],
                        *manifest["icons"].values(),
                    ]
                    references.extend(
                        name for script in manifest["content_scripts"] for name in script["js"]
                    )
                    # Modules the service worker imports, and the agent's in-page script.
                    references.extend(["src/agent/loop.js", "src/agent/cdp.js", "src/agent/page.js"])
                    for name in references:
                        self.assertIn(name, archive.namelist())
                    self.assertNotIn("config.local.json", archive.namelist())
                    self.assertFalse(
                        any(
                            "fixture-secret" in archive.read(name).decode(errors="ignore")
                            for name in archive.namelist()
                        )
                    )

    def test_platform_origin(self):
        for value in [
            "http://example.com",
            "https://u:p@example.com",
            "https://example.com/path",
            "file:///tmp",
            "https://example.com?token=x",
            "https://example.com:bad",
            "https://example .com",
        ]:
            with self.assertRaises(argparse.ArgumentTypeError):
                build_extension.platform_url(value)


    def test_public_env_setting_precedence_and_secret_exclusion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = root / "repo"
            fixture.mkdir()
            shutil.copytree(build_extension.ROOT / "extension", fixture / "extension")
            (fixture / ".env").write_text(
                'FRONTEND_URL="https://deployment.example" # public address\n'
                'OPENAI_API_KEY=fixture-private-secret\n'
            )
            with patch.object(build_extension, "ROOT", fixture), patch.dict(os.environ, {}, clear=True):
                self.assertEqual(build_extension.configured_origin(), "https://deployment.example")
                package = build_extension.build(root / "out")
                with zipfile.ZipFile(package) as archive:
                    config = json.loads(archive.read("platform.json"))
                    self.assertEqual(config, {"baseUrl": "https://deployment.example"})
                    manifest = json.loads(archive.read("manifest.json"))
                    self.assertIn("https://deployment.example/*", manifest["host_permissions"])
                    self.assertFalse(any("fixture-private-secret" in archive.read(name).decode(errors="ignore") for name in archive.namelist()))
                with patch.dict(os.environ, {"FRONTEND_URL": "https://environment.example"}):
                    self.assertEqual(build_extension.configured_origin(), "https://environment.example")
                    self.assertEqual(build_extension.configured_origin("https://explicit.example"), "https://explicit.example")
                (fixture / ".env").write_text("FRONTEND_URL=https://bad.example/path\n")
                with self.assertRaises(argparse.ArgumentTypeError):
                    build_extension.configured_origin()
