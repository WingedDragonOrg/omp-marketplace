#!/usr/bin/env python3
"""Query current public model prices from LiteLLM and OpenRouter."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

LITELLM_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
OPENROUTER_URL = "https://openrouter.ai/api/v1/models"
USER_AGENT = "model-prices-skill/1.0 (+https://github.com/WingedDragonOrg/omp-marketplace)"
CORE_COLUMNS = ("input", "output", "cache_read", "cache_write")
LITELLM_CORE_FIELDS = {
    "input_cost_per_token": "input",
    "output_cost_per_token": "output",
    "cache_read_input_token_cost": "cache_read",
    "cache_creation_input_token_cost": "cache_write",
}
OPENROUTER_CORE_FIELDS = {
    "prompt": "input",
    "completion": "output",
    "input_cache_read": "cache_read",
    "input_cache_write": "cache_write",
}
OPENROUTER_TOKEN_EXTRAS = {
    "audio": "audio token",
    "audio_output": "audio token",
    "input_audio_cache": "audio token",
    "input_cache_write_1h": "token",
    "internal_reasoning": "token",
}


def fetch_json(url: str, timeout: int) -> Any:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"), parse_float=Decimal)
    except HTTPError as error:
        raise RuntimeError(f"{url} returned HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"could not reach {url}: {error.reason}") from error
    except TimeoutError as error:
        raise RuntimeError(f"timed out after {timeout}s reading {url}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{url} did not return valid JSON: {error}") from error


def as_decimal(value: Any) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)) and not isinstance(value, bool):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return None
    return None


def decimal_text(value: Decimal) -> str:
    text = format(value, "f").rstrip("0").rstrip(".")
    return text or "0"


def price_item(field: str, value: Decimal, unit: str) -> dict[str, str]:
    item = {"field": field, "usd_per_unit": decimal_text(value), "unit": unit}
    if unit.endswith("token"):
        item["usd_per_million_tokens"] = decimal_text(value * Decimal(1_000_000))
    elif unit == "1K tokens":
        item["usd_per_million_tokens"] = decimal_text(value * Decimal(1_000))
    return item


def litellm_unit(field: str) -> str:
    if "_per_1k_tokens" in field:
        return "1K tokens"
    if "_per_audio_token" in field:
        return "audio token"
    if "_per_image_token" in field:
        return "image token"
    if "_per_token" in field:
        return "token"
    if field.endswith("_per_image"):
        return "image"
    if field.endswith("_per_pixel"):
        return "pixel"
    if field.endswith("_per_second"):
        return "second"
    if field.endswith("_per_minute"):
        return "minute"
    if field.endswith("_per_hour"):
        return "hour"
    if field.endswith("_per_character"):
        return "character"
    if field.endswith("_per_query") or field.endswith("_per_request"):
        return "request"
    return "unit"


def query_terms(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", value.casefold())


def search_rank(query: str, *candidates: str | None) -> int | None:
    folded_query = query.casefold()
    values = [candidate.casefold() for candidate in candidates if candidate]
    if folded_query in values:
        return 0
    if any(value.startswith(folded_query) for value in values):
        return 1
    terms = query_terms(query)
    if terms and any(all(term in set(query_terms(value)) for term in terms) for value in values):
        return 2
    if any(folded_query in value for value in values):
        return 3
    return None


def empty_core_pricing() -> dict[str, dict[str, str] | None]:
    return {column: None for column in CORE_COLUMNS}


def litellm_entries(catalog: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for model_id, details in catalog.items():
        if model_id == "sample_spec" or not isinstance(details, dict):
            continue
        pricing = empty_core_pricing()
        extras: list[dict[str, str]] = []
        for field, raw_value in details.items():
            value = as_decimal(raw_value)
            if value is None:
                continue
            if field in LITELLM_CORE_FIELDS:
                pricing[LITELLM_CORE_FIELDS[field]] = price_item(field, value, "token")
            elif "cost_per" in field:
                extras.append(price_item(field, value, litellm_unit(field)))
        search_prices = details.get("search_context_cost_per_query")
        if isinstance(search_prices, dict):
            for field, raw_value in search_prices.items():
                value = as_decimal(raw_value)
                if value is not None:
                    extras.append(price_item(field, value, "request"))
        yield {
            "source": "litellm",
            "model_id": model_id,
            "name": model_id,
            "provider": details.get("litellm_provider"),
            "mode": details.get("mode"),
            "context_length": details.get("max_input_tokens") or details.get("max_tokens"),
            "max_output_tokens": details.get("max_output_tokens"),
            "deprecation_date": details.get("deprecation_date"),
            "pricing": pricing,
            "other_pricing": extras,
            "tiers": [],
            "source_url": LITELLM_URL,
        }


def openrouter_endpoint_url(model_id: str) -> str:
    return f"{OPENROUTER_URL}/{quote(model_id, safe='/')}/endpoints"


def split_openrouter_pricing(raw_pricing: dict[str, Any]) -> tuple[
    dict[str, dict[str, str] | None],
    list[dict[str, str]],
    list[dict[str, Any]],
]:
    pricing = empty_core_pricing()
    extras: list[dict[str, str]] = []
    tiers: list[dict[str, Any]] = []
    for field, raw_value in raw_pricing.items():
        if field == "discount":
            continue
        if field == "overrides" and isinstance(raw_value, list):
            for override in raw_value:
                if not isinstance(override, dict):
                    continue
                tier_pricing = {
                    target: price_item(source_field, amount, "token")
                    for source_field, target in OPENROUTER_CORE_FIELDS.items()
                    if (amount := as_decimal(override.get(source_field))) is not None
                }
                if tier_pricing:
                    tiers.append(
                        {
                            "min_prompt_tokens": override.get("min_prompt_tokens"),
                            "pricing": tier_pricing,
                        }
                    )
            continue
        value = as_decimal(raw_value)
        if value is None:
            continue
        if field in OPENROUTER_CORE_FIELDS:
            pricing[OPENROUTER_CORE_FIELDS[field]] = price_item(field, value, "token")
        else:
            if field in OPENROUTER_TOKEN_EXTRAS:
                unit = OPENROUTER_TOKEN_EXTRAS[field]
            elif field in {"request", "web_search"}:
                unit = "request"
            elif field in {"image", "image_output"}:
                unit = "image"
            else:
                unit = "unit"
            extras.append(price_item(field, value, unit))
    return pricing, extras, tiers


def undiscounted_price(item: dict[str, str] | None, discount: Decimal) -> dict[str, str] | None:
    if item is None:
        return None
    return price_item(
        item["field"],
        Decimal(item["usd_per_unit"]) / (Decimal(1) - discount),
        item["unit"],
    )


def discounted_routes(endpoint_catalog: dict[str, Any]) -> list[dict[str, Any]]:
    data = endpoint_catalog.get("data")
    endpoints = data.get("endpoints") if isinstance(data, dict) else None
    if not isinstance(endpoints, list):
        return []
    routes: list[dict[str, Any]] = []
    for endpoint in endpoints:
        if not isinstance(endpoint, dict):
            continue
        raw_pricing = endpoint.get("pricing")
        if not isinstance(raw_pricing, dict):
            continue
        discount = as_decimal(raw_pricing.get("discount"))
        if discount is None or not Decimal(0) < discount < Decimal(1):
            continue
        pricing, _, tiers = split_openrouter_pricing(raw_pricing)
        original_pricing = {
            field: undiscounted_price(price, discount)
            for field, price in pricing.items()
        }
        original_tiers = [
            {
                "min_prompt_tokens": tier["min_prompt_tokens"],
                "pricing": {
                    field: undiscounted_price(price, discount)
                    for field, price in tier["pricing"].items()
                },
            }
            for tier in tiers
        ]
        routes.append(
            {
                "provider_name": endpoint.get("provider_name"),
                "tag": endpoint.get("tag"),
                "discount_percent": decimal_text(discount * Decimal(100)),
                "pricing": pricing,
                "original_pricing": original_pricing,
                "tiers": tiers,
                "original_tiers": original_tiers,
            }
        )
    return routes


def openrouter_entries(catalog: dict[str, Any]) -> Iterable[dict[str, Any]]:
    models = catalog.get("data")
    if not isinstance(models, list):
        raise RuntimeError("OpenRouter response did not contain a data array")
    for details in models:
        if not isinstance(details, dict) or not isinstance(details.get("id"), str):
            continue
        raw_pricing = details.get("pricing") if isinstance(details.get("pricing"), dict) else {}
        pricing, extras, tiers = split_openrouter_pricing(raw_pricing)
        architecture = details.get("architecture") if isinstance(details.get("architecture"), dict) else {}
        top_provider = details.get("top_provider") if isinstance(details.get("top_provider"), dict) else {}
        model_id = details["id"]
        yield {
            "source": "openrouter",
            "model_id": model_id,
            "name": details.get("name") or model_id,
            "provider": model_id.split("/", 1)[0] if "/" in model_id else None,
            "mode": architecture.get("modality"),
            "context_length": details.get("context_length"),
            "max_output_tokens": top_provider.get("max_completion_tokens"),
            "deprecation_date": details.get("deprecation_date") or details.get("expiration_date"),
            "pricing": pricing,
            "other_pricing": extras,
            "tiers": tiers,
            "discounted_routes": [],
            "source_url": OPENROUTER_URL,
        }


def money_per_million(item: dict[str, str] | None) -> str:
    if item is None:
        return "—"
    return f"${item['usd_per_million_tokens']}"


def display_price(item: dict[str, str]) -> str:
    if "usd_per_million_tokens" in item:
        suffix = "tokens" if item["unit"] == "token" else f"{item['unit']}s"
        return f"${item['usd_per_million_tokens']}/1M {suffix}"
    return f"${item['usd_per_unit']}/{item['unit']}"

def discounted_pair(
    current: dict[str, str] | None,
    original: dict[str, str] | None,
) -> str:
    return f"{money_per_million(current)} / {money_per_million(original)}"




def markdown(entries: list[dict[str, Any]], retrieved_at: str, failures: list[dict[str, str]]) -> str:
    lines = [
        f"Retrieved at: {retrieved_at}",
        "",
        "Token prices are USD per 1M tokens. `—` means the source did not publish that rate; `$0` means the source published a free rate.",
        "",
        "| Source | Model ID | Input | Output | Cache read | Cache write |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for entry in entries:
        rates = entry["pricing"]
        lines.append(
            "| {source} | `{model_id}` | {input} | {output} | {cache_read} | {cache_write} |".format(
                source=entry["source"],
                model_id=entry["model_id"].replace("|", "\\|"),
                **{column: money_per_million(rates[column]) for column in CORE_COLUMNS},
            )
        )
    for entry in entries:
        notes: list[str] = []
        if entry.get("provider"):
            notes.append(f"provider: `{entry['provider']}`")
        if entry.get("mode"):
            notes.append(f"mode: `{entry['mode']}`")
        if entry.get("context_length"):
            notes.append(f"context: {entry['context_length']}")
        if entry.get("max_output_tokens"):
            notes.append(f"max output: {entry['max_output_tokens']}")
        if entry.get("deprecation_date"):
            notes.append(f"deprecation/expiration: {entry['deprecation_date']}")
        if notes:
            lines.extend(["", f"**{entry['source']} — `{entry['model_id']}`**: " + "; ".join(notes)])
        if entry["other_pricing"]:
            lines.append(
                "Other published prices: "
                + "; ".join(
                    f"{price['field']} = {display_price(price)}" for price in entry["other_pricing"]
                )
                + "."
            )
        for tier in entry["tiers"]:
            tier_rates = ", ".join(
                f"{kind} ${price['usd_per_million_tokens']}"
                for kind, price in tier["pricing"].items()
            )
            lines.append(
                f"Tier override above {tier['min_prompt_tokens']} prompt tokens: {tier_rates}."
            )
        for route in entry.get("discounted_routes", []):
            route_name = route.get("tag") or route.get("provider_name") or "unnamed route"
            route_rates = "; ".join(
                f"{field} {discounted_pair(route['pricing'][field], route['original_pricing'][field])}"
                for field in CORE_COLUMNS
            )
            lines.append(
                f"Discounted OpenRouter route `{route_name}` ({route['discount_percent']}% off; "
                f"current / derived original per 1M tokens): {route_rates}."
            )
            for tier, original_tier in zip(route["tiers"], route["original_tiers"], strict=True):
                tier_rates = ", ".join(
                    f"{field} {discounted_pair(current, original_tier['pricing'][field])}"
                    for field, current in tier["pricing"].items()
                )
                lines.append(
                    f"Discounted route tier above {tier['min_prompt_tokens']} prompt tokens "
                    f"(current / derived original): {tier_rates}."
                )
        lines.append(f"Source: {entry['source_url']}")
        if entry.get("endpoint_source_url"):
            lines.append(f"Endpoint discount source: {entry['endpoint_source_url']}")
    if failures:
        lines.extend(["", "## Retrieval failures"])
        lines.extend(f"- {failure['source']}: {failure['error']}" for failure in failures)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Query current public model prices from LiteLLM and OpenRouter.")
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--query", help="Case-insensitive name search; every query word must match.")
    selector.add_argument("--id", help="Case-insensitive exact source-specific model ID.")
    parser.add_argument(
        "--source",
        choices=("auto", "openrouter", "litellm", "both", "all"),
        default="auto",
        help="auto prefers OpenRouter and falls back to LiteLLM; both/all queries both sources.",
    )
    parser.add_argument("--limit", type=int, default=20, help="Maximum matches to emit from each selected source.")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.timeout < 1:
        parser.error("--timeout must be at least 1")

    source_matches: dict[str, list[tuple[int, dict[str, Any]]]] = {
        "openrouter": [],
        "litellm": [],
    }
    failures: list[dict[str, str]] = []
    retrieved_at = datetime.now(UTC).isoformat(timespec="seconds")

    def collect(source: str) -> None:
        try:
            catalog = fetch_json(LITELLM_URL if source == "litellm" else OPENROUTER_URL, args.timeout)
            records = litellm_entries(catalog) if source == "litellm" else openrouter_entries(catalog)
            for record in records:
                if args.id:
                    rank = 0 if record["model_id"].casefold() == args.id.casefold() else None
                else:
                    rank = search_rank(args.query, record["model_id"], record["name"])
                if rank is not None:
                    source_matches[source].append((rank, record))
        except RuntimeError as error:
            failures.append({"source": source, "error": str(error)})

    if args.source == "auto":
        collect("openrouter")
        if not source_matches["openrouter"]:
            collect("litellm")
        source_order = ("openrouter", "litellm")
    elif args.source in {"both", "all"}:
        collect("openrouter")
        collect("litellm")
        source_order = ("openrouter", "litellm")
    else:
        collect(args.source)
        source_order = (args.source,)

    results = [
        record
        for source in source_order
        for _, record in sorted(source_matches[source], key=lambda pair: (pair[0], pair[1]["model_id"]))[: args.limit]
    ]
    for record in results:
        if record["source"] != "openrouter":
            continue
        endpoint_url = openrouter_endpoint_url(record["model_id"])
        try:
            endpoint_catalog = fetch_json(endpoint_url, args.timeout)
            record["endpoint_source_url"] = endpoint_url
            record["discounted_routes"] = discounted_routes(endpoint_catalog)
        except RuntimeError as error:
            failures.append(
                {
                    "source": f"openrouter endpoint pricing for {record['model_id']}",
                    "error": str(error),
                }
            )

    payload = {
        "query": args.id or args.query,
        "match_type": "exact_id" if args.id else "search",
        "source_strategy": args.source,
        "retrieved_at": retrieved_at,
        "results": results,
        "errors": failures,
    }
    if args.format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif results:
        print(markdown(results, retrieved_at, failures))
    else:
        print(f"No matching models found for {payload['query']!r} using {args.source}.")
        if failures:
            print("\n" + markdown([], retrieved_at, failures))
    if not results and not failures:
        return 2
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
