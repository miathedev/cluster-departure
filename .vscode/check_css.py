"""Report CSS classes/ids/vars that are defined in style.css but never used
in index.html or app.js. Exits 1 if any are found."""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
css = (ROOT / "app/static/style.css").read_text()
html = (ROOT / "app/static/index.html").read_text()
js = (ROOT / "app/static/app.js").read_text()
used = html + js

HEX = set("0123456789abcdefABCDEF")


def is_hex_color(name: str) -> bool:
    return len(name) in (3, 4, 6, 8) and all(c in HEX for c in name)


classes = {c for c in re.findall(r"\.([a-zA-Z][\w-]*)", css)}
ids = {i for i in re.findall(r"#([a-zA-Z][\w-]*)", css) if not is_hex_color(i)}
defined_vars = set(re.findall(r"(--[\w-]+)\s*:", css))
used_vars = set(re.findall(r"var\((--[\w-]+)\)", css))

unused_classes = sorted(c for c in classes if c not in used)
unused_ids = sorted(
    i for i in ids
    if f'id="{i}"' not in html and f'getElementById("{i}")' not in js
)
unused_vars = sorted(v for v in defined_vars if v not in used_vars)

for label, items in (("class", unused_classes), ("id", unused_ids), ("var", unused_vars)):
    for item in items:
        print(f"unused {label}: {item}")

if unused_classes or unused_ids or unused_vars:
    sys.exit(1)
print("css clean: no unused selectors or vars")
