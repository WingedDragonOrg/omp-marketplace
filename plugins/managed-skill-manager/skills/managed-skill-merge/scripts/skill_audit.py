#!/usr/bin/env python3
"""Inventory, overlap-rank and validate a managed skill library.

Stdlib only on purpose: the omp environment frequently has no PyYAML, so the
frontmatter parser here is deliberately minimal (two flat keys is the whole
contract for a managed skill).

    python3 skill_audit.py inventory <skills-dir>
    python3 skill_audit.py overlap   <skills-dir> [--top 25] [--min 0.12]
    python3 skill_audit.py validate  <skills-dir> [--extra-roots DIR ...]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from itertools import combinations

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
KEY_RE = re.compile(r"^([A-Za-z_][\w-]*):\s*(.*)$")
WORD_RE = re.compile(r"[a-z0-9_./-]{4,}")
CJK_RE = re.compile(r"[\u4e00-\u9fff]{2}")
LINK_RE = re.compile(r"skill://([a-z0-9][a-z0-9.-]*)")
FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")
BUNDLE_RE = re.compile(r"^(scripts|references|assets)/")


def parse_frontmatter(text: str) -> tuple[dict | None, str | None]:
    """Return (mapping, error). Only flat `key: value` lines are legal here."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None, "no frontmatter block"
    out: dict[str, str] = {}
    for line in m.group(1).split("\n"):
        if not line.strip():
            continue
        if line[:1].isspace():
            return None, "indented/multiline frontmatter value"
        km = KEY_RE.match(line)
        if not km:
            return None, f"unparsed frontmatter line: {line[:60]!r}"
        key, raw = km.group(1), km.group(2).strip()
        if len(raw) > 1 and raw[0] == raw[-1] == '"':
            try:
                raw = json.loads(raw)
            except ValueError as exc:
                return None, f"{key}: bad quoted value ({exc})"
        elif len(raw) > 1 and raw[0] == raw[-1] == "'":
            raw = raw[1:-1].replace("''", "'")
        out[key] = raw
    return out, None


def load(root: str) -> list[dict]:
    skills = []
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        path = os.path.join(d, "SKILL.md")
        entry = {"name": name, "dir": d, "path": path, "extra": [], "text": "", "fm": None, "err": None}
        if not os.path.exists(path):
            entry["err"] = "missing SKILL.md"
            skills.append(entry)
            continue
        entry["extra"] = sorted(
            os.path.relpath(os.path.join(dp, f), d)
            for dp, _, fs in os.walk(d)
            for f in fs
            if os.path.relpath(os.path.join(dp, f), d) != "SKILL.md"
        )
        entry["text"] = open(path, encoding="utf-8").read()
        entry["fm"], entry["err"] = parse_frontmatter(entry["text"])
        entry["mtime"] = os.path.getmtime(path)
        skills.append(entry)
    return skills


def body_tokens(text: str) -> set[str]:
    body = FRONTMATTER_RE.sub("", text).lower()
    return set(WORD_RE.findall(body)) | set(CJK_RE.findall(body))


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def cmd_inventory(args) -> int:
    skills = load(args.dir)
    print(f"{len(skills)} skills in {args.dir}\n")
    print(f"{'skill':<50}{'desc':>6}{'bytes':>8}{'chars':>8}  extra")
    for s in skills:
        if s["err"] and s["fm"] is None:
            print(f"{s['name']:<50}{'-':>6}{'-':>8}{'-':>8}  !! {s['err']}")
            continue
        desc = s["fm"].get("description", "")
        raw = open(s["path"], "rb").read()
        print(
            f"{s['name']:<50}{len(desc):>6}{len(raw):>8}{len(s['text']):>8}"
            f"  {','.join(s['extra']) if s['extra'] else '-'}"
        )
    print(
        "\nbytes vs chars differ on CJK text — compare mtime, never size, when checking"
        "\nwhether a file you did not intend to touch was rewritten."
    )
    return 0


def cmd_overlap(args) -> int:
    skills = [s for s in load(args.dir) if s["fm"]]
    toks = {s["name"]: body_tokens(s["text"]) for s in skills}
    descs = {s["name"]: body_tokens(s["fm"].get("description", "")) for s in skills}
    pairs = []
    for a, b in combinations(sorted(toks), 2):
        body = jaccard(toks[a], toks[b])
        desc = jaccard(descs[a], descs[b])
        score = 0.7 * body + 0.3 * desc
        if score >= args.min:
            pairs.append((score, body, desc, a, b))
    pairs.sort(reverse=True)
    print(f"{len(pairs)} candidate pairs at score >= {args.min} (ranked, top {args.top})\n")
    print(f"{'score':>6}{'body':>7}{'desc':>7}  pair")
    for score, body, desc, a, b in pairs[: args.top]:
        print(f"{score:>6.3f}{body:>7.3f}{desc:>7.3f}  {a}  +  {b}")
    print(
        "\nRanking is a lead, not a verdict: read both bodies and merge only when the"
        "\ndecision criterion and evidence sources are the same."
    )
    return 0


def cmd_validate(args) -> int:
    skills = load(args.dir)
    known = {s["name"] for s in skills}
    for root in args.extra_roots:
        if os.path.isdir(root):
            known |= {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))}
    problems = []
    for s in skills:
        name = s["name"]
        if s["fm"] is None:
            problems.append((name, s["err"]))
            continue
        keys = sorted(s["fm"])
        if keys != ["description", "name"]:
            problems.append((name, f"frontmatter keys {keys}, expected ['description', 'name']"))
        if s["fm"].get("name") != name:
            problems.append((name, f"frontmatter name {s['fm'].get('name')!r} != directory"))
        if not s["fm"].get("description", "").strip():
            problems.append((name, "empty description"))
        stray = [f for f in s["extra"] if not BUNDLE_RE.match(f) or "__pycache__" in f or f.endswith(".DS_Store")]
        if stray:
            problems.append((name, f"files outside scripts/ references/ assets/: {', '.join(stray)}"))
        fences = sum(1 for line in s["text"].split("\n") if FENCE_RE.match(line))
        if fences % 2:
            problems.append((name, f"odd number of code fences ({fences})"))
        for target in sorted(set(LINK_RE.findall(s["text"]))):
            if target not in known:
                problems.append((name, f"dangling skill://{target}"))
    print(f"checked {len(skills)} skills in {args.dir}")
    if not problems:
        print("OK: frontmatter, naming, layout, fences and skill:// links all consistent")
        return 0
    for name, msg in problems:
        print(f"FAIL {name}: {msg}")
    print(f"\n{len(problems)} problem(s)")
    return 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    inv = sub.add_parser("inventory", help="one row per skill: description length, size, extra files")
    inv.add_argument("dir")
    inv.set_defaults(func=cmd_inventory)

    ov = sub.add_parser("overlap", help="rank skill pairs by token overlap to surface merge candidates")
    ov.add_argument("dir")
    ov.add_argument("--top", type=int, default=25)
    ov.add_argument("--min", type=float, default=0.12)
    ov.set_defaults(func=cmd_overlap)

    val = sub.add_parser("validate", help="structural + link check; exits non-zero on any problem")
    val.add_argument("dir")
    val.add_argument("--extra-roots", nargs="*", default=[], help="other skill roots that skill:// links may target")
    val.set_defaults(func=cmd_validate)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
