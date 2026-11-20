#!/usr/bin/env python3
"""Generate the MV3 policy module from its JSON source, or verify it in CI."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "extension/src/shared"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    raw = (ROOT / "agent-rules.json").read_text().strip()
    expected_js = (
        "// Generated from agent-rules.json. Shared tests verify this module and the Python copy.\n"
        "export const AGENT_RULES = " + raw + ";\n"
    )
    expected_ts = (
        "// Generated from agent-rules.json. Shared tests verify this module and the Python copy.\n"
        "export const AGENT_RULES = " + raw + " as const;\n"
    )
    target_js = ROOT / "agent-rules.js"
    target_ts = ROOT / "agent-rules.ts"
    if args.check:
        if (target_ts.is_file() and target_ts.read_text() != expected_ts) or (
            target_js.is_file() and target_js.read_text() != expected_js
        ):
            raise SystemExit("Run python3 scripts/agent_rules.py to refresh the policy module.")
        if not target_ts.is_file() and not target_js.is_file():
            raise SystemExit("agent-rules module missing. Run python3 scripts/agent_rules.py.")
    else:
        target_ts.write_text(expected_ts)
        target_js.write_text(expected_js)


if __name__ == "__main__":
    main()
