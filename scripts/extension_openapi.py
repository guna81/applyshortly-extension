"""Cut the extension-bridge subset (/api/extension/* + referenced schemas) out of the full spec.

Usage: python3 scripts/extension_openapi.py < full-openapi.json > extension-bridge/openapi.json
"""

from __future__ import annotations

import json
import sys
from typing import Any

PREFIX = "/api/extension/"


def refs(node: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            found.add(ref.rsplit("/", 1)[-1])
        for value in node.values():
            found |= refs(value)
    elif isinstance(node, list):
        for value in node:
            found |= refs(value)
    return found


def main() -> None:
    spec = json.load(sys.stdin)
    paths = {p: v for p, v in spec["paths"].items() if p.startswith(PREFIX)}
    schemas = spec.get("components", {}).get("schemas", {})
    wanted, todo = set(), refs(paths)
    while todo:
        name = todo.pop()
        if name not in wanted:
            wanted.add(name)
            todo |= refs(schemas.get(name, {}))
    subset = {
        "openapi": spec["openapi"],
        "info": {**spec["info"], "title": f"{spec['info']['title']} - extension bridge"},
        "paths": paths,
        "components": {
            "schemas": {n: schemas[n] for n in sorted(wanted) if n in schemas},
            "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}},
        },
        "security": [{"bearer": []}],
    }
    json.dump(subset, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
