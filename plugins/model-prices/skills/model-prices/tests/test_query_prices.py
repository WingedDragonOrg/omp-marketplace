from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "scripts" / "query_prices.py"


def load_module():
    assert SCRIPT.exists(), "query_prices.py must provide the live catalog query interface"
    spec = importlib.util.spec_from_file_location("query_prices", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QueryPricesTests(unittest.TestCase):
    def run_main(self, module, argv, catalogs):
        def fake_fetch(url, timeout):
            if url.endswith("/endpoints") and url not in catalogs:
                return {"data": {"endpoints": []}}
            return catalogs[url]

        stdout = io.StringIO()
        with patch.object(module, "fetch_json", side_effect=fake_fetch), patch.object(sys, "argv", ["query_prices.py", *argv]), contextlib.redirect_stdout(stdout):
            status = module.main()
        return status, stdout.getvalue()

    def test_exact_id_does_not_match_prefix_variants(self):
        module = load_module()
        catalog = {
            "data": [
                {"id": "provider/model", "name": "Model", "pricing": {"prompt": "0.000002", "completion": "0.000003"}},
                {"id": "provider/model-v2", "name": "Model v2", "pricing": {"prompt": "0.000004", "completion": "0.000005"}},
            ]
        }
        status, output = self.run_main(
            module,
            ["--id", "provider/model", "--source", "openrouter", "--format", "json"],
            {module.OPENROUTER_URL: catalog},
        )
        self.assertEqual(status, 0)
        self.assertEqual([entry["model_id"] for entry in json.loads(output)["results"]], ["provider/model"])

    def test_all_source_search_returns_a_best_match_from_each_source(self):
        module = load_module()
        litellm = {
            "sample_spec": {},
            "provider.model": {
                "litellm_provider": "provider",
                "input_cost_per_token": 0.000002,
                "output_cost_per_token": 0.000003,
            },
        }
        openrouter = {
            "data": [
                {"id": "provider/model", "name": "Provider Model", "pricing": {"prompt": "0.000004", "completion": "0.000005"}},
            ]
        }
        status, output = self.run_main(
            module,
            ["--query", "model", "--source", "all", "--limit", "1", "--format", "json"],
            {module.LITELLM_URL: litellm, module.OPENROUTER_URL: openrouter},
        )
        self.assertEqual(status, 0)
        results = json.loads(output)["results"]
        self.assertEqual([entry["source"] for entry in results], ["openrouter", "litellm"])
        self.assertEqual(results[0]["pricing"]["input"]["usd_per_million_tokens"], "4")
        self.assertEqual(results[1]["pricing"]["output"]["usd_per_million_tokens"], "3")

    def test_markdown_labels_cache_ttl_pricing_as_tokens(self):
        module = load_module()
        entry = {
            "source": "openrouter",
            "model_id": "provider/model",
            "name": "Provider Model",
            "provider": "provider",
            "mode": "text->text",
            "context_length": None,
            "max_output_tokens": None,
            "deprecation_date": None,
            "pricing": {"input": None, "output": None, "cache_read": None, "cache_write": None},
            "other_pricing": [
                {
                    "field": "input_cache_write_1h",
                    "usd_per_unit": "0.000006",
                    "usd_per_million_tokens": "6",
                    "unit": "token",
                }
            ],
            "tiers": [],
            "source_url": module.OPENROUTER_URL,
        }
        output = module.markdown([entry], "2026-08-31T00:00:00+00:00", [])
        self.assertIn("input_cache_write_1h = $6/1M tokens", output)

    def test_auto_prefers_openrouter_without_loading_litellm(self):
        module = load_module()
        openrouter = {
            "data": [
                {
                    "id": "provider/model",
                    "name": "Provider Model",
                    "pricing": {"prompt": "0.000002", "completion": "0.000003"},
                }
            ]
        }
        status, output = self.run_main(
            module,
            ["--query", "model", "--source", "auto", "--format", "json"],
            {
                module.OPENROUTER_URL: openrouter,
                "https://openrouter.ai/api/v1/models/provider/model/endpoints": {
                    "data": {"id": "provider/model", "endpoints": []}
                },
            },
        )
        self.assertEqual(status, 0)
        self.assertEqual(
            [entry["source"] for entry in json.loads(output)["results"]],
            ["openrouter"],
        )

    def test_openrouter_discount_shows_current_and_derived_original_prices(self):
        module = load_module()
        model_id = "openai/gpt-5.6-sol"
        summary = {
            "data": [
                {
                    "id": model_id,
                    "name": "OpenAI: GPT-5.6 Sol",
                    "pricing": {"prompt": "0.000002", "completion": "0.00001"},
                }
            ]
        }
        endpoints = {
            "data": {
                "id": model_id,
                "endpoints": [
                    {
                        "provider_name": "OpenAI",
                        "tag": "openai",
                        "pricing": {
                            "prompt": "0.000002",
                            "completion": "0.00001",
                            "discount": 0.5,
                        },
                    }
                ],
            }
        }
        status, output = self.run_main(
            module,
            ["--id", model_id, "--source", "openrouter", "--format", "json"],
            {
                module.OPENROUTER_URL: summary,
                f"https://openrouter.ai/api/v1/models/{model_id}/endpoints": endpoints,
            },
        )
        self.assertEqual(status, 0)
        result = json.loads(output)["results"][0]
        route = result["discounted_routes"][0]
        self.assertEqual(result["endpoint_source_url"], f"https://openrouter.ai/api/v1/models/{model_id}/endpoints")
        self.assertEqual(route["tag"], "openai")
        self.assertEqual(route["discount_percent"], "50")
        self.assertEqual(route["pricing"]["input"]["usd_per_million_tokens"], "2")
        self.assertEqual(route["original_pricing"]["input"]["usd_per_million_tokens"], "4")
        self.assertEqual(route["original_pricing"]["output"]["usd_per_million_tokens"], "20")

    def test_auto_falls_back_to_litellm_when_openrouter_has_no_match(self):
        module = load_module()
        litellm = {
            "sample_spec": {},
            "vendor/model": {
                "litellm_provider": "vendor",
                "input_cost_per_token": 0.000002,
                "output_cost_per_token": 0.000003,
            },
        }
        status, output = self.run_main(
            module,
            ["--query", "model", "--source", "auto", "--format", "json"],
            {module.OPENROUTER_URL: {"data": []}, module.LITELLM_URL: litellm},
        )
        self.assertEqual(status, 0)
        self.assertEqual(
            [entry["source"] for entry in json.loads(output)["results"]],
            ["litellm"],
        )


if __name__ == "__main__":
    unittest.main()
