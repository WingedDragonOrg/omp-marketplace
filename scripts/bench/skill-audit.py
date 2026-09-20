#!/usr/bin/env python3
"""Fixed-workload benchmark for the managed-skill-manager `skill_audit.py` CLI.

The real production module is loaded by path (never copied or re-implemented), a
deterministic 64-directory skill library plus an 8-directory extra root are written
into a temporary directory, and the module's frontmatter parsing, inventory,
overlap and validate code paths are driven for a fixed number of rounds. Each round
asserts the consumer-visible result contract -- parse outcomes for positive and
negative frontmatter, the known overlap ranking, the known validate problem set --
and folds the observed output into one integer checksum. That checksum is the only
thing written to stdout; failures explain themselves on stderr and exit non-zero.

    python3 scripts/bench/skill-audit.py

Fixed workload: 10 passes over a 64-skill library, invoking inventory, overlap
and validation, plus an 8-skill extra root for cross-library link checks.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import re
import sys
import tempfile
import traceback
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AUDIT_PATH = (
    REPO_ROOT / "plugins" / "managed-skill-manager" / "skills" / "managed-skill-merge" / "scripts" / "skill_audit.py"
)

ROUNDS = 10
MIN_SCORE = 0.12
TOP = 25
# 53 well-formed cluster members + 10 defect kinds + one extra-root link probe.
CLUSTERS = (("alpha", 15), ("beta", 12), ("gamma", 10), ("delta", 8), ("zeta", 8))
TWIN = ("zeta", 0, 1)  # zeta-01 mirrors zeta-00 byte for byte: the 1.000 overlap pair
DEFECT_KINDS = (
    "missing-skill-md",
    "no-frontmatter",
    "indented-value",
    "bad-quote",
    "extra-key",
    "wrong-name",
    "empty-description",
    "stray-file",
    "dangling-link",
    "odd-fence",
)
SKILLS_PER_ROOT = sum(size for _, size in CLUSTERS) + len(DEFECT_KINDS) + 1
CLUSTER_PAIRS = sum(size * (size - 1) // 2 for _, size in CLUSTERS)
EXTRA_ROOT_SIZE = 8
VOCAB_WORDS = 100
UNIQUE_WORDS = 10
DESC_SHARED = 12
GHOST_LINK = "zz-ghost-target"
PAIR_RE = re.compile(r"^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+\+\s+(\S+)$")


def frontmatter(name: str, description: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n"


def document(name: str, description: str, body: str) -> str:
    return frontmatter(name, description) + "\n" + body


def cluster_body(cluster: str, index: int) -> str:
    """Cluster vocabulary shared by every member plus per-member-unique tokens.

    Every token carries the cluster prefix, so two members of different clusters
    can never share one and their pair score is exactly zero.
    """
    slot = TWIN[1] if (cluster == TWIN[0] and index == TWIN[2]) else index
    vocab = " ".join(f"{cluster}word{i:02d}" for i in range(VOCAB_WORDS))
    unique = " ".join(f"{cluster}x{slot:02d}{i:02d}" for i in range(UNIQUE_WORDS))
    return f"# {cluster}note\n\n{vocab}\n\n{unique}\n"


def cluster_desc(cluster: str, index: int) -> str:
    slot = TWIN[1] if (cluster == TWIN[0] and index == TWIN[2]) else index
    shared = " ".join(f"{cluster}desc{i:02d}" for i in range(DESC_SHARED))
    return f"{shared} {cluster}tag{slot:02d}"


def unique_body(tag: str) -> str:
    return f"# {tag}note\n\n" + " ".join(f"{tag}x{i:02d}" for i in range(UNIQUE_WORDS)) + "\n"


def defect_files(kind: str, *, clean: bool) -> dict[str, str]:
    """Files for one defective skill; `clean=True` yields the repaired variant."""
    tag = "zz" + kind.replace("-", "")
    name = f"zz-{kind}"
    body = unique_body(tag)
    desc = f"{tag}desc00 {tag}desc01"
    if kind == "missing-skill-md":
        return {} if not clean else {"SKILL.md": document(name, desc, body)}
    if kind == "no-frontmatter":
        return {"SKILL.md": body if not clean else document(name, desc, body)}
    if kind == "indented-value":
        head = frontmatter(name, desc)
        if not clean:
            head = f"---\nname: {name}\ndescription: {tag}desc00\n  {tag}desc01\n---\n"
        return {"SKILL.md": head + "\n" + body}
    if kind == "bad-quote":
        head = frontmatter(name, desc)
        if not clean:
            head = f'---\nname: {name}\ndescription: "\\q"\n---\n'
        return {"SKILL.md": head + "\n" + body}
    if kind == "extra-key":
        extra = "" if clean else "version: 2\n"
        head = f"---\nname: {name}\ndescription: {desc}\n{extra}---\n"
        return {"SKILL.md": head + "\n" + body}
    if kind == "wrong-name":
        head = frontmatter(name if clean else "zz-other-name", desc)
        return {"SKILL.md": head + "\n" + body}
    if kind == "empty-description":
        head = frontmatter(name, desc) if clean else f'---\nname: {name}\ndescription: ""\n---\n'
        return {"SKILL.md": head + "\n" + body}
    if kind == "stray-file":
        files = {"SKILL.md": document(name, desc, body)}
        if clean:
            files["scripts/helper.py"] = f"# {tag} helper\n"
            files["references/guide.md"] = f"# {tag} guide\n"
            files["assets/pixel.svg"] = "<svg/>\n"
        else:
            files["notes.md"] = f"{tag} notes\n"
            files["tmp/readme.txt"] = f"{tag} temp\n"
            files["scripts/__pycache__/helper.pyc"] = "bytecode\n"
        return files
    if kind == "dangling-link":
        link = "see skill://alpha-00\n" if clean else f"see skill://{GHOST_LINK}\n"
        return {"SKILL.md": document(name, desc, body + "\n" + link)}
    if kind == "odd-fence":
        extra = f"```\n{tag}x90\n```\n" if clean else f"```\n{tag}x90\n```\nmore {tag}x91\n```\n"
        return {"SKILL.md": document(name, desc, body + "\n" + extra)}
    raise AssertionError(f"unknown defect kind: {kind}")


def library_tree(*, clean: bool) -> dict[str, dict[str, str]]:
    tree: dict[str, dict[str, str]] = {}
    for cluster, size in CLUSTERS:
        for index in range(size):
            name = f"{cluster}-{index:02d}"
            files = {"SKILL.md": document(name, cluster_desc(cluster, index), cluster_body(cluster, index))}
            if index % 4 == 0:
                files["references/guide.md"] = f"# {cluster} guide {index:02d}\n"
            if index % 5 == 0:
                files["scripts/run.py"] = f"# {cluster} runner {index:02d}\n"
            tree[name] = files
    for kind in DEFECT_KINDS:
        tree[f"zz-{kind}"] = defect_files(kind, clean=clean)
    body = unique_body("zzextralink") + "\nsee skill://extra-00 and skill://alpha-00\n"
    tree["zz-extra-link"] = {"SKILL.md": document("zz-extra-link", "zzextralinkdesc00", body)}
    assert len(tree) == SKILLS_PER_ROOT, f"fixture has {len(tree)} skills, expected {SKILLS_PER_ROOT}"
    return tree


def extra_tree() -> dict[str, dict[str, str]]:
    return {
        f"extra-{i:02d}": {
            "SKILL.md": document(f"extra-{i:02d}", f"xtraroot{i:02d}desc00", f"# xtraroot{i:02d}note\n\nxtraroot{i:02d}y00\n")
        }
        for i in range(EXTRA_ROOT_SIZE)
    }


def write_tree(root: Path, tree: dict[str, dict[str, str]]) -> None:
    for skill, files in tree.items():
        base = root / skill
        base.mkdir(parents=True, exist_ok=True)  # a defect skill may ship no files at all
        for rel, text in files.items():
            dest = base / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8")


def load_module():
    if not AUDIT_PATH.is_file():
        raise FileNotFoundError(f"production module not found: {AUDIT_PATH}")
    sys.dont_write_bytecode = True  # never drop a __pycache__ into the plugin tree
    spec = importlib.util.spec_from_file_location("bench_skill_audit_under_test", AUDIT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invoke(func, root: Path, extra_roots: tuple[Path, ...] = ()) -> tuple[int, str]:
    """Run one audit command against a fixture root, capturing its consumer output."""
    args = argparse.Namespace(dir=str(root), top=TOP, min=MIN_SCORE, extra_roots=[str(p) for p in extra_roots])
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        status = func(args)
    return status, buf.getvalue()


def invoke_cli(module, argv: list[str]) -> tuple[int, str]:
    """Run the same command through the real argparse entry point."""
    buf = io.StringIO()
    saved = sys.argv
    sys.argv = ["skill_audit.py", *argv]
    try:
        with contextlib.redirect_stdout(buf):
            status = module.main()
    finally:
        sys.argv = saved
    return status, buf.getvalue()


def parse_overlap(out: str) -> tuple[int, list[tuple[float, str, str]]]:
    lines = out.splitlines()
    head = re.match(r"^(\d+) candidate pairs at score >= ([\d.]+) \(ranked, top (\d+)\)$", lines[0])
    assert head, f"unexpected overlap header: {lines[0]!r}"
    assert float(head.group(2)) == MIN_SCORE and int(head.group(3)) == TOP, lines[0]
    start = next(i for i, line in enumerate(lines) if line.startswith(" score"))
    ranked = []
    for line in lines[start + 1 :]:
        match = PAIR_RE.match(line)
        if not match:
            break
        ranked.append((float(match.group(1)), match.group(4), match.group(5)))
    return int(head.group(1)), ranked


def normalize(text: str, roots: tuple[Path, ...]) -> str:
    """Strip run-specific and interpreter-version-specific text from an artifact."""
    for root in roots:
        text = text.replace(str(root), "<ROOT>")
    return re.sub(r"bad quoted value \(.*\)", "bad quoted value (ERR)", text)


def unit_probes(module) -> str:
    """Direct contract checks on the parsing/tokenizer entry points."""
    fm, err = module.parse_frontmatter("---\nname: demo\ndescription: 'it''s ok'\n---\nbody\n")
    assert err is None and fm == {"name": "demo", "description": "it's ok"}, (fm, err)
    fm, err = module.parse_frontmatter('---\nname: "a: b"\ndescription: plain\n---\n')
    assert err is None and fm == {"name": "a: b", "description": "plain"}, (fm, err)
    negatives = (
        ("hello\n", "no frontmatter block"),
        ("---\nname: x\n  description: y\n---\n", "indented/multiline frontmatter value"),
        ('---\nname: x\ndescription: "\\q"\n---\n', "description: bad quoted value"),
        ("---\n1bad: x\n---\n", "unparsed frontmatter line"),
    )
    for text, prefix in negatives:
        fm, err = module.parse_frontmatter(text)
        assert fm is None and err.startswith(prefix), (text, fm, err)
    tokens = module.body_tokens(
        "---\nname: x\ndescription: y\n---\nVisible skill://alpha-03 demo 中文技能 together see"
    )
    assert tokens == {"visible", "skill", "//alpha-03", "demo", "together", "中文", "技能"}, sorted(tokens)
    assert module.jaccard({1, 2, 3}, {1, 2, 3}) == 1.0
    assert module.jaccard({1, 2, 3}, {3, 4}) == 0.25
    assert module.jaccard(set(), {1}) == 0.0
    return f"tokens={sorted(tokens)}"


def run_round(module, bad: Path, clean: Path, extra: Path, roots: tuple[Path, ...]) -> int:
    acc = zlib.crc32(b"skill-audit-bench/v1")

    # --- library load and frontmatter contract -------------------------------
    skills = module.load(str(bad))
    assert len(skills) == SKILLS_PER_ROOT, len(skills)
    broken = [s["name"] for s in skills if s["fm"] is None]
    assert broken == ["zz-bad-quote", "zz-indented-value", "zz-missing-skill-md", "zz-no-frontmatter"], broken
    errs = {s["name"]: s["err"] for s in skills if s["fm"] is None}
    assert errs["zz-bad-quote"].startswith("description: bad quoted value"), errs
    assert errs["zz-indented-value"] == "indented/multiline frontmatter value", errs
    assert errs["zz-missing-skill-md"] == "missing SKILL.md", errs
    assert errs["zz-no-frontmatter"] == "no frontmatter block", errs
    parsed = {s["name"]: s for s in skills if s["fm"] is not None}
    assert len(parsed) == SKILLS_PER_ROOT - len(broken), len(parsed)
    assert {n for n, s in parsed.items() if sorted(s["fm"]) != ["description", "name"]} == {"zz-extra-key"}
    assert parsed["zz-empty-description"]["fm"]["description"] == ""

    # --- overlap analysis ----------------------------------------------------
    status, overlap = invoke(module.cmd_overlap, bad)
    assert status == 0, status
    count, ranked = parse_overlap(overlap)
    assert count == CLUSTER_PAIRS, f"{count} candidate pairs, expected {CLUSTER_PAIRS}"
    assert len(ranked) == TOP, len(ranked)
    assert ranked[0] == (1.0, "zeta-00", "zeta-01"), ranked[0]
    assert all(later[0] <= earlier[0] for earlier, later in zip(ranked, ranked[1:])), "pair scores not ranked"
    assert all(score >= MIN_SCORE for score, _, _ in ranked), "candidate below --min"
    assert all(a.split("-")[0] == b.split("-")[0] for _, a, b in ranked), "cross-cluster pair ranked"

    status, cli_overlap = invoke_cli(module, ["overlap", str(bad)])
    assert status == 0 and cli_overlap == overlap, "CLI and direct overlap output diverge"

    # --- inventory -----------------------------------------------------------
    status, inventory = invoke(module.cmd_inventory, bad)
    assert status == 0, status
    assert inventory.startswith(f"{SKILLS_PER_ROOT} skills in {bad}\n"), inventory[:80]
    assert inventory.count("!! ") == len(broken), inventory.count("!! ")
    for fragment in (
        "!! missing SKILL.md",
        "!! no frontmatter block",
        "!! indented/multiline frontmatter value",
        "!! description: bad quoted value",
    ):
        assert fragment in inventory, fragment

    # --- validate ------------------------------------------------------------
    status, bad_validate = invoke(module.cmd_validate, bad, (extra,))
    fails = [line for line in bad_validate.splitlines() if line.startswith("FAIL ")]
    assert status == 1, status
    assert bad_validate.startswith(f"checked {SKILLS_PER_ROOT} skills in {bad}\n"), bad_validate[:80]
    assert bad_validate.rstrip("\n").endswith(f"{len(DEFECT_KINDS)} problem(s)"), bad_validate[-80:]
    assert len(fails) == len(DEFECT_KINDS), fails
    expected = (
        "FAIL zz-bad-quote: description: bad quoted value",
        "FAIL zz-dangling-link: dangling skill://zz-ghost-target",
        "FAIL zz-empty-description: empty description",
        "FAIL zz-extra-key: frontmatter keys ['description', 'name', 'version'], expected ['description', 'name']",
        "FAIL zz-indented-value: indented/multiline frontmatter value",
        "FAIL zz-missing-skill-md: missing SKILL.md",
        "FAIL zz-no-frontmatter: no frontmatter block",
        "FAIL zz-odd-fence: odd number of code fences (3)",
        "FAIL zz-stray-file: files outside scripts/ references/ assets/:"
        " notes.md, scripts/__pycache__/helper.pyc, tmp/readme.txt",
        "FAIL zz-wrong-name: frontmatter name 'zz-other-name' != directory",
    )
    for prefix in expected:
        assert any(line.startswith(prefix) for line in fails), f"missing problem: {prefix}"
    assert not any(line.startswith("FAIL zz-extra-link") for line in fails), "extra-root link reported dangling"

    status, clean_validate = invoke(module.cmd_validate, clean, (extra,))
    assert status == 0, clean_validate[-200:]
    status, plain_validate = invoke(module.cmd_validate, clean)
    assert status == 1, status
    assert plain_validate.splitlines()[1] == "FAIL zz-extra-link: dangling skill://extra-00", plain_validate[-200:]
    assert plain_validate.rstrip("\n").endswith("1 problem(s)"), plain_validate[-80:]
    status, extra_validate = invoke(module.cmd_validate, extra)
    assert status == 0, extra_validate[-200:]

    # --- CLI entry point keeps the same exit contract ------------------------
    status, cli_clean_validate = invoke_cli(module, ["validate", str(clean), "--extra-roots", str(extra)])
    assert status == 0 and cli_clean_validate == clean_validate, status
    status, cli_bad_validate = invoke_cli(module, ["validate", str(bad), "--extra-roots", str(extra)])
    assert status == 1 and cli_bad_validate == bad_validate, status

    # --- fold the observed contract into the checksum ------------------------
    acc = zlib.crc32(f"dirs={SKILLS_PER_ROOT} rounds={ROUNDS}".encode(), acc)
    for artifact in (
        inventory,
        overlap,
        cli_overlap,
        bad_validate,
        clean_validate,
        plain_validate,
        extra_validate,
        cli_clean_validate,
        cli_bad_validate,
    ):
        acc = zlib.crc32(normalize(artifact, roots).encode("utf-8"), acc)
    acc = zlib.crc32(unit_probes(module).encode("utf-8"), acc)
    return acc & 0x7FFFFFFF


def main() -> int:
    module = load_module()
    with tempfile.TemporaryDirectory(prefix="skill-audit-bench-") as tmp:
        bad = Path(tmp) / "lib-bad"
        clean = Path(tmp) / "lib-clean"
        extra = Path(tmp) / "extra-root"
        write_tree(bad, library_tree(clean=False))
        write_tree(clean, library_tree(clean=True))
        write_tree(extra, extra_tree())
        roots = (bad, clean, extra)
        checksums = [run_round(module, bad, clean, extra, roots) for _ in range(ROUNDS)]
    assert len(checksums) == ROUNDS and len(set(checksums)) == 1, checksums
    print(checksums[0])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        raise SystemExit(1)
