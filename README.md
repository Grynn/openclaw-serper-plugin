# OpenClaw Serper Plugin

An OpenClaw `web_search` provider backed by [Serper.dev](https://serper.dev/), with native mini-batches of up to 100 queries and optional per-query Brave or Firecrawl fallback.

## Features

- One Serper request for as many as 100 independent queries.
- Cached queries are omitted from the provider request.
- Results and failures are reported independently for each query.
- Successful results populate OpenClaw's normal web-search cache.
- Optional Brave and Firecrawl fallback, bounded to ten concurrent fallback calls.
- Organic search and news endpoints, country/language hints, and date-range filters.

## Install

Requires OpenClaw 2026.6.11 or newer.

```bash
git clone https://github.com/Grynn/openclaw-serper-plugin.git
openclaw plugins install --link ./openclaw-serper-plugin
```

Set `SERPER_API_KEY` in the Gateway environment, select `serper` as `tools.web.search.provider`, and restart the Gateway. Do not commit the API key.

Optional fallback providers are configured at:

```json
{
  "plugins": {
    "entries": {
      "serper": {
        "config": {
          "webSearch": {
            "fallbacks": ["brave", "firecrawl"]
          }
        }
      }
    }
  }
}
```

Use an empty `fallbacks` list for Serper-only operation. Fallbacks read `BRAVE_API_KEY` and `FIRECRAWL_API_KEY` from the Gateway environment when needed.

## Batch searches

The provider accepts either `query` or `queries`, but not both:

```json
{
  "queries": [
    "OpenClaw release notes",
    "Serper mini batch API",
    "TypeScript 6 release"
  ],
  "count": 5
}
```

`queries` accepts 1–100 unique strings. Serper receives the uncached queries in one native array request. If one query produces no results, only that query enters the configured fallback chain.

## Development

```bash
pnpm install
pnpm run check
```

Tests cover request construction, independent failures, input validation, caching, and the full 100-query boundary.

## Security

Search results are returned through OpenClaw's untrusted external-content wrappers. Credentials are resolved through OpenClaw configuration or environment variables and are never included in result payloads.

## License

MIT
