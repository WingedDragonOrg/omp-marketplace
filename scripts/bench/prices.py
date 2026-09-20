#!/usr/bin/env python3
"""Fixed offline workload for the model-prices skill's query_prices.py utility.

Loads the production module by relative path and drives it with hand-built
OpenRouter and LiteLLM catalogs (~500 rows each): entry parsing, search ranking,
endpoint discount derivation, USD-per-1M-token pricing and markdown/JSON
rendering. Nothing here can reach the network: the CLI's fetch_json boundary is
stubbed with the fixture catalogs and any unexpected URL aborts the run.

Consumer behavior is asserted at exact values -- core rates per 1M tokens,
auto-source fallback to LiteLLM, exact-ID selection (a prefix must match nothing),
discount current/derived-original prices, tier overrides, and the rendered
markdown price rows and unit labels. A failed expectation writes the reason to
stderr and exits non-zero, so the benchmark fails closed instead of timing broken
behavior. stdout is one deterministic integer checksum over every consumed output:
the fetch_json boundary and the CLI clock are pinned to fixtures, so nothing
depends on the network or on the time of day.

Workload shape (fixed, no calibration): ROUNDS rounds of full-catalog parsing,
checksumming, discount derivation, markdown rendering and a fixed search sweep,
then the CLI runs carrying the consumer assertions.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import zlib
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, NoReturn

REPO_ROOT = Path(__file__).resolve().parents[2]
QUERY_PRICES_PATH = (
    REPO_ROOT / "plugins" / "model-prices" / "skills" / "model-prices" / "scripts" / "query_prices.py"
)

# Fixed workload shape. Every price is an integer micro-USD per token so the expected
# USD-per-1M-token strings are exact, hand-checkable values rather than re-derivations.
ROUNDS = 10
OPENROUTER_ROWS = 520  # well-formed OpenRouter rows; two malformed rows are appended
FEATURE_ROWS = 6  # acme/feature-* rows driving tiers, discounts, free and unpriced rates
LITELLM_ROWS = 500  # well-formed LiteLLM entries; sample_spec and a non-dict are added
VENDORS = ("acme", "boron", "cobalt", "dune", "ember")
UNPRICED_FEATURE = 3  # non-numeric prompt rate renders as "—"
FREE_FEATURE = 4  # published free rate renders as "$0"
FIXED_RETRIEVED_AT = "2026-01-01T00:00:00+00:00"
PRICED_ROW_ARGS = ["--query", "model-010", "--source", "openrouter", "--limit", "5", "--format", "json"]
AUTO_FALLBACK_ARGS = ["--query", "lite-008", "--source", "auto", "--format", "json"]
EXACT_ID_ARGS = ["--id", "acme/feature-0", "--source", "openrouter", "--format", "json"]
PREFIX_ID_ARGS = ["--id", "acme/feature", "--source", "openrouter", "--format", "json"]
MARKDOWN_ARGS = ["--query", "feature", "--source", "openrouter", "--limit", "10", "--format", "markdown"]
SEARCH_SWEEP = (("openrouter", "acme/mo", 104), ("litellm", "dune", 100))


class FixtureDatetime(datetime):
    """Fixed clock: the CLI stamps retrieved_at and must not depend on time of day."""

    @classmethod
    def now(cls, tz: Any = None) -> "FixtureDatetime":
        return cls(2026, 1, 1, tzinfo=UTC)


def fail(message: str) -> NoReturn:
    sys.stderr.write(f"prices bench: {message}\n")
    raise SystemExit(1)


def check(condition: object, message: str) -> None:
    if not condition:
        fail(message)


def consume(checksum: int, *parts: object) -> int:
    return zlib.crc32("\x1f".join(str(part) for part in parts).encode("utf-8"), checksum)


def parse_catalog(text: str) -> Any:
    """Parse fixture JSON exactly like the catalog fetcher does (floats become Decimal)."""
    return json.loads(text, parse_float=Decimal)


def load_query_prices() -> Any:
    check(QUERY_PRICES_PATH.is_file(), f"missing production module: {QUERY_PRICES_PATH}")
    spec = importlib.util.spec_from_file_location("bench_query_prices", QUERY_PRICES_PATH)
    check(spec is not None and spec.loader is not None, f"cannot create import spec for {QUERY_PRICES_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def openrouter_row(index: int) -> dict[str, Any]:
    vendor = VENDORS[index % len(VENDORS)]
    prompt_micro = (index % 40) + 1
    pricing: dict[str, Any] = {
        "prompt": f"{prompt_micro}e-6",
        "completion": f"{(index * 3 % 97) + 2}e-6",
        "input_cache_read": f"{prompt_micro // 2}e-6",
        "input_cache_write": f"{prompt_micro * 2}e-6",
        "input_cache_write_1h": f"{prompt_micro}e-6",
    }
    if index % 5 == 0:
        pricing["image"] = "0.0004"
        pricing["image_output"] = "0.001"
    return {
        "id": f"{vendor}/model-{index:03d}",
        "name": f"{vendor.title()} Model {index:03d}",
        "context_length": 32_768 + index,
        "architecture": {"modality": "text->text"},
        "top_provider": {"max_completion_tokens": 4_096 + index},
        "pricing": pricing,
    }


def openrouter_feature_row(k: int) -> dict[str, Any]:
    micro = k + 1
    pricing: dict[str, Any] = {
        "prompt": f"{micro}e-6",
        "completion": f"{micro * 5}e-6",
        "input_cache_read": f"{micro}e-6",
        "input_cache_write": f"{micro * 2}e-6",
        "input_cache_write_1h": f"{micro * 3}e-6",
        "web_search": "0.01",
        "request": "0.0005",
        "audio": "0.000012",
        "image_output": "0.001",
        "tool_use": "0.0004",
        "overrides": [
            {"min_prompt_tokens": 200_000, "prompt": "0.000003", "completion": "0.00001"},
            {"min_prompt_tokens": 500_000, "prompt": "0.000004"},
            {"min_prompt_tokens": 1_000_000, "web_search": "0.02"},
            "not-a-dict",
        ],
    }
    if k == UNPRICED_FEATURE:
        pricing["prompt"] = "on request"
    if k == FREE_FEATURE:
        for column in ("prompt", "completion", "input_cache_read", "input_cache_write"):
            pricing[column] = 0
    return {
        "id": f"acme/feature-{k}",
        "name": f"Acme Feature {k}",
        "context_length": 200_000 + k,
        "architecture": {"modality": "text->text"},
        "pricing": pricing,
    }


def openrouter_catalog_text() -> str:
    rows: list[Any] = [openrouter_row(index) for index in range(OPENROUTER_ROWS)]
    rows.extend(openrouter_feature_row(k) for k in range(FEATURE_ROWS))
    rows.append({"name": "Row without an id"})
    rows.append("not-a-dict")
    return json.dumps({"data": rows})


def litellm_row(index: int) -> dict[str, Any]:
    in_micro = (index % 30) + 1
    row: dict[str, Any] = {
        "litellm_provider": VENDORS[index % len(VENDORS)],
        "mode": "chat",
        "max_input_tokens": 131_072 + index,
        "max_tokens": 16_384,
        "max_output_tokens": 8_192 + index,
        "input_cost_per_token": float(f"{in_micro}e-6"),
        "output_cost_per_token": float(f"{(index * 7 % 89) + 2}e-6"),
        "cache_read_input_token_cost": float(f"{in_micro // 2}e-6"),
        "cache_creation_input_token_cost": float(f"{in_micro * 2}e-6"),
        "input_cost_per_token_above_200k_tokens": float(f"{in_micro * 3}e-6"),
        "input_cost_per_1k_tokens": 0.002,
        "output_cost_per_image": 0.04,
        "search_context_cost_per_query": {"search_context_size_low": 0.003},
        "deprecation_date": "2027-01-01" if index % 4 == 0 else None,
    }
    if index == 0:
        row["input_cost_per_token"] = 0
    if index == 5:
        row["input_cost_per_token"] = "n/a"
    return row


def litellm_catalog_text() -> str:
    catalog: dict[str, Any] = {"sample_spec": {"max_tokens": 1_024}}
    for index in range(LITELLM_ROWS):
        catalog[f"{VENDORS[index % len(VENDORS)]}/lite-{index:03d}"] = litellm_row(index)
    catalog["acme/broken"] = "not-a-dict"
    return json.dumps(catalog)


def endpoint_catalog_text(model_id: str) -> str:
    endpoints: list[Any] = [
        {
            "provider_name": "Acme Direct",
            "tag": "acme-direct",
            "pricing": {
                "prompt": "0.000001",
                "completion": "0.00001",
                "discount": 0.5,
                "overrides": [{"min_prompt_tokens": 200_000, "prompt": "0.000003"}],
            },
        },
        {"provider_name": "Acme Budget", "tag": "acme-budget", "pricing": {"prompt": 4e-06, "discount": 0.2}},
        {"provider_name": "Acme Partial", "tag": "acme-partial", "pricing": {"web_search": "0.02", "discount": 0.5}},
        {"provider_name": "Acme Free", "pricing": {"prompt": "0.000002", "discount": 0}},
        {"provider_name": "Acme Full", "pricing": {"prompt": "0.000002", "discount": 1}},
        {"provider_name": "Acme Future", "pricing": {"prompt": "0.000002", "discount": "1.5"}},
        {"provider_name": "Acme Unpriced", "tag": "acme-unpriced"},
        "not-a-dict",
    ]
    return json.dumps({"data": {"id": model_id, "endpoints": endpoints}})


def make_fetch(module: Any, catalogs: dict[str, Any], endpoint_catalogs: dict[str, Any]) -> Callable[[str, int], Any]:
    """Answer the CLI's data URLs from fixtures; abort on anything unexpected."""

    def fetch(url: str, timeout: int) -> Any:
        if url == module.OPENROUTER_URL:
            return catalogs["openrouter"]
        if url == module.LITELLM_URL:
            return catalogs["litellm"]
        for model_id, endpoint_catalog in endpoint_catalogs.items():
            if url == module.openrouter_endpoint_url(model_id):
                return endpoint_catalog
        if url.endswith("/endpoints"):
            return {"data": {"endpoints": []}}
        fail(f"bench reached an unexpected URL: {url}")

    return fetch


def run_cli(module: Any, argv: list[str], fetch: Callable[[str, int], Any]) -> tuple[int, str]:
    """Invoke the real CLI with fetch_json stubbed and the clock pinned at the I/O boundary."""
    stdout = io.StringIO()
    previous = module.fetch_json, module.datetime, sys.argv
    module.fetch_json, module.datetime, sys.argv = fetch, FixtureDatetime, ["query_prices.py", *argv]
    try:
        with contextlib.redirect_stdout(stdout):
            status = module.main()
    finally:
        module.fetch_json, module.datetime, sys.argv = previous
    return status, stdout.getvalue()


def assert_priced_row(module: Any, fetch: Callable[[str, int], Any]) -> tuple[str, ...]:
    status, output = run_cli(module, PRICED_ROW_ARGS, fetch)
    check(status == 0, f"openrouter json query exited {status}")
    payload = json.loads(output)
    ids = [entry["model_id"] for entry in payload["results"]]
    check(ids == ["acme/model-010"], f"model-010 matched {ids}")
    record = payload["results"][0]
    check(
        {column: record["pricing"][column]["usd_per_million_tokens"] for column in module.CORE_COLUMNS}
        == {"input": "11", "output": "32", "cache_read": "5", "cache_write": "22"},
        f"priced row changed: {record['pricing']}",
    )
    extras = {price["field"]: price for price in record["other_pricing"]}
    check(module.display_price(extras["input_cache_write_1h"]) == "$11/1M tokens", "cache TTL rate label changed")
    return (output,)


def assert_auto_fallback(module: Any, fetch: Callable[[str, int], Any]) -> tuple[str, ...]:
    status, output = run_cli(module, AUTO_FALLBACK_ARGS, fetch)
    check(status == 0, f"auto-source query exited {status}")
    payload = json.loads(output)
    ids = [entry["model_id"] for entry in payload["results"]]
    check(ids == ["dune/lite-008"], f"lite-008 matched {ids}")
    record = payload["results"][0]
    check(record["source"] == "litellm", "auto source must fall back to litellm when openrouter has no match")
    check(
        {column: record["pricing"][column]["usd_per_million_tokens"] for column in module.CORE_COLUMNS}
        == {"input": "9", "output": "58", "cache_read": "4", "cache_write": "18"},
        f"litellm priced row changed: {record['pricing']}",
    )
    extras = {price["field"]: price for price in record["other_pricing"]}
    check(
        extras["input_cost_per_1k_tokens"]["unit"] == "1K tokens"
        and extras["input_cost_per_1k_tokens"]["usd_per_million_tokens"] == "2",
        "1K-token rate normalization changed",
    )
    return (output,)


def assert_id_selection(module: Any, fetch: Callable[[str, int], Any]) -> tuple[str, ...]:
    status, output = run_cli(module, EXACT_ID_ARGS, fetch)
    check(status == 0, f"exact id query exited {status}")
    payload = json.loads(output)
    check(
        payload["match_type"] == "exact_id"
        and [entry["model_id"] for entry in payload["results"]] == ["acme/feature-0"],
        f"exact id selection changed: {payload['results']}",
    )
    status, prefix_output = run_cli(module, PREFIX_ID_ARGS, fetch)
    check(status == 2, f"prefix-only id must match nothing and exit 2, got {status}")
    check(json.loads(prefix_output)["results"] == [], "prefix-only id must not select rows")
    return output, prefix_output


def assert_markdown_rendering(module: Any, fetch: Callable[[str, int], Any]) -> tuple[str, ...]:
    status, output = run_cli(module, MARKDOWN_ARGS, fetch)
    check(status == 0, f"openrouter markdown query exited {status}")
    for row in (
        "| openrouter | `acme/feature-0` | $1 | $5 | $1 | $2 |",
        "| openrouter | `acme/feature-3` | — | $20 | $4 | $8 |",
        "| openrouter | `acme/feature-4` | $0 | $0 | $0 | $0 |",
    ):
        check(output.count(row) == 1, f"markdown table row changed: {row}")
    check("input_cache_write_1h = $3/1M tokens" in output, "markdown cache TTL rate changed")
    return (output,)


def digest_records(checksum: int, records: list[dict[str, Any]], columns: tuple[str, ...]) -> int:
    for record in records:
        pricing = record["pricing"]
        rates = [pricing[column]["usd_per_unit"] if pricing[column] else "—" for column in columns]
        extras = [f"{price['field']}={price['usd_per_unit']}{price['unit']}" for price in record["other_pricing"]]
        tiers = [f"tier@{tier['min_prompt_tokens']}:{len(tier['pricing'])}" for tier in record["tiers"]]
        checksum = consume(checksum, record["source"], record["model_id"], *rates, *extras, *tiers)
    return checksum


def run_round(module: Any, catalogs: dict[str, Any], endpoint_catalog: Any, checksum: int) -> int:
    openrouter_records = list(module.openrouter_entries(catalogs["openrouter"]))
    litellm_records = list(module.litellm_entries(catalogs["litellm"]))
    check(
        len(openrouter_records) == OPENROUTER_ROWS + FEATURE_ROWS and len(litellm_records) == LITELLM_ROWS,
        f"entry counts changed: {len(openrouter_records)} openrouter, {len(litellm_records)} litellm",
    )
    checksum = digest_records(checksum, openrouter_records, module.CORE_COLUMNS)
    checksum = digest_records(checksum, litellm_records, module.CORE_COLUMNS)
    routes = module.discounted_routes(endpoint_catalog)
    check(len(routes) == 3, f"usable discounted routes changed: {len(routes)}")
    direct = routes[0]
    check(
        [
            direct["discount_percent"],
            direct["pricing"]["input"]["usd_per_million_tokens"],
            direct["original_pricing"]["input"]["usd_per_million_tokens"],
            direct["original_pricing"]["output"]["usd_per_million_tokens"],
        ]
        == ["50", "1", "2", "20"],
        f"discount derivation changed: {direct}",
    )
    checksum = consume(checksum, *(f"{route['tag']}:{route['discount_percent']}" for route in routes))
    tiers = openrouter_records[OPENROUTER_ROWS]["tiers"]
    check(
        [[tier["min_prompt_tokens"], tier["pricing"]["input"]["usd_per_million_tokens"]] for tier in tiers]
        == [[200_000, "3"], [500_000, "4"]],
        f"tier overrides changed: {tiers}",
    )
    probes = openrouter_records[OPENROUTER_ROWS:] + openrouter_records[:4] + litellm_records[:2]
    probes[0]["endpoint_source_url"] = module.openrouter_endpoint_url("acme/feature-0")
    probes[0]["discounted_routes"] = routes
    checksum = consume(checksum, "markdown", module.markdown(probes, FIXED_RETRIEVED_AT, []))
    for source, query, expected in SEARCH_SWEEP:
        pool = openrouter_records if source == "openrouter" else litellm_records
        hits = [
            record["model_id"]
            for record in pool
            if module.search_rank(query, record["model_id"], record["name"]) is not None
        ]
        check(len(hits) == expected, f"search {query!r} expected {expected} matches, got {len(hits)}")
        checksum = consume(checksum, query, str(len(hits)), *hits[:2])
    return checksum


def main() -> int:
    module = load_query_prices()
    catalogs = {
        "openrouter": parse_catalog(openrouter_catalog_text()),
        "litellm": parse_catalog(litellm_catalog_text()),
    }
    endpoint_catalog = parse_catalog(endpoint_catalog_text("acme/feature-0"))
    fetch = make_fetch(module, catalogs, {"acme/feature-0": endpoint_catalog})
    checksum = zlib.crc32(b"model-prices-bench", 0)
    for parts in (
        assert_priced_row(module, fetch),
        assert_auto_fallback(module, fetch),
        assert_id_selection(module, fetch),
        assert_markdown_rendering(module, fetch),
    ):
        checksum = consume(checksum, *parts)
    for round_index in range(ROUNDS):
        checksum = consume(checksum, f"round-{round_index}")
        checksum = run_round(module, catalogs, endpoint_catalog, checksum)
    print(checksum)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
