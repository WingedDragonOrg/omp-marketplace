---
name: model-prices
description: This skill should be used whenever the user asks for the current/latest price, token rate, cost comparison, price change, discount, original price, or cost estimate for one or more AI/LLM models; mentions LiteLLM pricing, `model_prices_and_context_window.json`, OpenRouter prices, `/api/v1/models`, input/output/cache-token rates, or asks which model is cheaper. Fetch live data rather than relying on remembered prices, including when the user names a model casually or asks in Chinese. Prefer OpenRouter automatically and fall back to LiteLLM only when OpenRouter has no match or is unavailable; show discounted and original OpenRouter token rates when the route publishes a discount.
compatibility: Requires Python 3 with outbound HTTPS access. Uses only public LiteLLM and OpenRouter price catalogs; no API key.
---

# Live model pricing

Fetch live records before answering. Model pricing changes often and model names are ambiguous across versions, batch tiers, and router aliases. The bundled utility uses OpenRouter as the default source, falls back to LiteLLM only when necessary, and never fabricates a common rate.

## Select sources

Use the default `auto` strategy unless the request explicitly names a source:

| User intent | Source strategy | Behavior |
|---|---|---|
| Generic “latest price,” “which is cheaper,” or no route stated | `auto` (default) | Query OpenRouter first. Query LiteLLM only when OpenRouter has no matching model or cannot be retrieved. |
| What a request costs through OpenRouter | `openrouter` | Query OpenRouter only, including route-level discount records. |
| Explicit LiteLLM configuration or a LiteLLM-only identifier | `litellm` | Query LiteLLM only. |
| Explicit request to compare the two catalogs | `both` | Return separate source-labelled records; never merge them. |

Do not ask the user to select a provider for a normal lookup. OpenRouter's model-level price is the default answer. When OpenRouter exposes several discounted route tags, report each tag with its current and original rates; ask for a route only when a workload estimate requires choosing one. LiteLLM and OpenRouter remain different billing systems, so an explicit cross-catalog comparison must retain both source labels.

## Query the live catalogs

Run the bundled script; it downloads the catalogs on every invocation and records the retrieval timestamp. Do not copy a price from memory, a prior response, a search snippet, or a static table.

```sh
python3 <skill-directory>/scripts/query_prices.py \
  --query "claude sonnet" --limit 20
```

Use `--id` only for an exact source-specific identifier already supplied by the user or selected after a search:

```sh
python3 <skill-directory>/scripts/query_prices.py \
  --id "openai/gpt-5.6-sol"
```

Use `--source both` only for a requested source comparison. `--source all` remains a compatibility alias for `both`.

Use `--format json` when calculating costs, sorting candidates, or producing machine-readable output. The script requires either `--query` or `--id`; it deliberately cannot dump both complete catalogs into the conversation.

### Resolve ambiguous matches

1. Search by the user's name rather than guessing an identifier.
2. Let `auto` choose OpenRouter first; do not turn a generic lookup into provider selection.
3. Preserve material variants: version suffixes, `:batch`, `:free`, and OpenRouter route tags may change price.
4. If one match clearly corresponds to an exact identifier from the user's configuration, query it again with `--id`.
5. If several model versions remain plausible, show candidates and request the missing version only when it changes the recommendation or estimate. For broad requests such as “all models,” narrow by family or budget before querying.

## Interpret prices correctly

The primary table reports USD per **1M tokens**. It is converted only from the source's per-token rate:

\[
\text{USD per 1M tokens} = \text{USD per token} \times 1{,}000{,}000
\]

Apply these rules when reporting:

- Render `—` as “not published by this source”; render `$0` as a source-published free rate. Do not treat a missing field as free.
- Keep input, output, cache-read, and cache-write rates separate. Cache-write and cache-read are not ordinary input tokens.
- Include request, image, search, reasoning, audio, or other published charge types from “Other published prices”; do not discard them just because they are not token prices.
- Preserve tier overrides, especially higher long-context rates. State the threshold and avoid a single blended price unless the user supplies token volumes for a calculation.
- Carry the source's deprecation or expiration date into the answer when present. A catalog entry may be still queryable but unsuitable for a new integration.
- Treat a script retrieval failure as unavailable data, not a zero price or a license to use stale values. State which source failed and omit claims about that source.

### Show OpenRouter discounts without hiding the base rate

For every selected OpenRouter model, the utility retrieves its endpoint catalog. When an endpoint publishes `pricing.discount` between 0 and 1, report:

- the endpoint tag and discount percentage;
- the current rate OpenRouter charges for input, output, cache read, and cache write;
- the derived original rate for each token price, using

  \[
  \text{original rate} = \frac{\text{current discounted rate}}{1 - \text{discount}}
  \]

- both current and derived-original values for long-context tier overrides.

Call the original value **derived**, not directly published: OpenRouter exposes the current endpoint rate and fractional discount, not a separate original-rate field. Keep request, image, search, and other non-token charges as published unless the source provides a distinct undiscounted value.

## Estimate a workload only when inputs are known

For a token-only workload, calculate from explicit quantities and the selected source record:

\[
\text{cost} = I \cdot r_I + O \cdot r_O + C_R \cdot r_{CR} + C_W \cdot r_{CW} + R \cdot r_R + M \cdot r_M
\]

Where $I$, $O$, $C_R$, and $C_W$ are input, output, cache-read, and cache-write tokens; $R$ is billable requests; $M$ is billable images or other units; and each $r$ is the matching source rate. Omit terms that the source does not publish or the workload does not use. Do not estimate cache hits, cache writes, images, searches, or long-context tier selection without user-supplied quantities; show them as excluded assumptions instead.

## Response format

Answer in the user's language. For a lookup or comparison, use this compact structure:

```markdown
## Current prices — retrieved <UTC timestamp>

| Route/source | Exact model ID | Input $/1M | Output $/1M | Cache read $/1M | Cache write $/1M |
|---|---|---:|---:|---:|---:|
| ... | `...` | ... | ... | ... | ... |

- Discounted OpenRouter route `<tag>` — <N>% off; current / derived original:
  input <current> / <original>; output <current> / <original>; ...
- Tier rule: ...
- Other charges: ...
- Scope: <OpenRouter was selected first / LiteLLM was used only because ...>
- Source: <live catalog URL>
```

For an estimate, append an **Assumptions and calculation** section that lists every supplied token count, the chosen tier, included non-token fees, omitted charges, and the resulting USD amount. Quote the exact model ID rather than only its display name.

## Source contracts

- LiteLLM: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- OpenRouter model summary: `https://openrouter.ai/api/v1/models`
- OpenRouter route details: `https://openrouter.ai/api/v1/models/<model-id>/endpoints`

The script embeds the normalized field mapping. Read `scripts/query_prices.py` before extending its source behavior or changing its output contract.
