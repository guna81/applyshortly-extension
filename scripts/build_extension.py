#!/usr/bin/env python3
"""Deterministic, allowlisted extension packaging. Only the public FRONTEND_URL setting is read from local configuration."""

import argparse
import json
import os
import shutil
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def platform_url(value):
    try:
        url = urlsplit(value)
        url.port  # Validate a supplied port before writing the public config.
    except ValueError as error:
        raise argparse.ArgumentTypeError("Invalid platform origin") from error
    if (
        (
            url.scheme != "https"
            and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))
        )
        or not url.hostname
        or any(char.isspace() for char in value)
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
    ):
        raise argparse.ArgumentTypeError(
            "Use an HTTPS origin or loopback HTTP origin, without credentials or paths"
        )
    return value.rstrip("/")


def configured_origin(explicit=None):
    """Read only FRONTEND_URL; never interpolate or export the rest of .env."""
    if explicit is not None:
        return platform_url(explicit)
    if os.environ.get("FRONTEND_URL"):
        return platform_url(os.environ["FRONTEND_URL"])
    env = ROOT / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            name, separator, value = line.strip().removeprefix("export ").partition("=")
            if separator and name.strip() == "FRONTEND_URL":
                value = value.strip()
                if value.startswith(("'", '"')):
                    quote = value[0]
                    close = value.find(quote, 1)
                    if close < 0 or (value[close + 1:].strip() and not value[close + 1:].strip().startswith("#")):
                        raise argparse.ArgumentTypeError("Invalid FRONTEND_URL setting")
                    value = value[1:close]
                else:
                    value = value.split(" #", 1)[0].strip()
                if value:
                    return platform_url(value)
    return "http://localhost:3000"


def archive(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as output:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            output.writestr(info, content)


def build(destination, base_url=None, source=False):
    base_url = configured_origin(base_url)
    ext = ROOT / "extension"
    files = {"manifest.json": (ext / "manifest.json").read_bytes()}
    for folder, suffixes in [("src", {".js", ".html", ".css"}), ("icons", {".svg", ".png"})]:
        for item in (ext / folder).iterdir():
            if item.is_file() and not item.is_symlink() and item.suffix in suffixes:
                files[item.relative_to(ext).as_posix()] = item.read_bytes()
    files["platform.json"] = (json.dumps({"baseUrl": base_url}, sort_keys=True) + "\n").encode()
    manifest = json.loads(files["manifest.json"])
    origin_permission = base_url + "/*"
    if origin_permission not in manifest["host_permissions"]:
        manifest["host_permissions"].append(origin_permission)
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    version = manifest["version"]
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / "extension"
    if target.is_symlink():
        raise ValueError("Refusing symlink output directory")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir()
    for name, content in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    package = destination / f"applyshortly-extension-{version}.zip"
    archive(package, files)
    if source:
        source_files = {f"extension/{name}": content for name, content in files.items()}
        for name in ["README.md", "LICENSE", "BRANDING.md"]:
            source_files[f"extension/{name}"] = (ext / name).read_bytes()
        for item in (ext / "test").glob("*.mjs"):
            source_files[f"extension/test/{item.name}"] = item.read_bytes()
        for item in (ROOT / "extension-bridge").rglob("*"):
            if item.is_file() and not item.is_symlink() and item.suffix in {".ts", ".json", ".md"}:
                source_files[item.relative_to(ROOT).as_posix()] = item.read_bytes()
        source_files["scripts/build_extension.py"] = Path(__file__).read_bytes()
        source_files["scripts/test_build_extension.py"] = (
            ROOT / "scripts/test_build_extension.py"
        ).read_bytes()
        for name in ["package.json", "package-lock.json", "README.md", "LICENSE", "BRANDING.md", ".gitignore", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", ".github/workflows/ci.yml", "scripts/extension_openapi.py"]:
            source_files[name] = (ROOT / name).read_bytes()
        for item in (ROOT / "docs").rglob("*.md"):
            if item.is_file() and not item.is_symlink():
                source_files[item.relative_to(ROOT).as_posix()] = item.read_bytes()
        source_files["scripts/extension_store_fixture.py"] = (ROOT / "scripts/extension_store_fixture.py").read_bytes()
        archive(destination / f"applyshortly-extension-source-{version}.zip", source_files)
    return package


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform-url", type=platform_url)
    parser.add_argument("--source", action="store_true")
    args = parser.parse_args()
    print(build(ROOT / "dist", args.platform_url, args.source))
