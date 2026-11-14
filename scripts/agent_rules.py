#!/usr/bin/env python3
"""Generate the MV3 policy module from its JSON source, or verify it in CI."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "extension/src"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    raw = (ROOT / "agent-rules.json").read_text().strip()
    expected = (
        "// Generated from agent-rules.json. Shared tests verify this module and the Python copy.\n"
        "export const AGENT_RULES = " + raw + ";\n"
    )
    target = ROOT / "agent-rules.js"
    if args.check:
        if target.read_text() != expected:
            raise SystemExit("Run python3 scripts/agent_rules.py to refresh the policy module.")
    else:
        target.write_text(expected)


if __name__ == "__main__":
    main()
