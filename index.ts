/**
 * Serper.dev web-search provider plugin for OpenClaw, with a built-in
 * provider fallback chain (Serper -> Brave -> Firecrawl by default).
 *
 * Why in-provider fallback: OpenClaw's `web_search` tool binds a single
 * provider and has no config-level provider ladder (only `web_fetch` does).
 * So resilience is implemented here: if Serper errors (network/quota/5xx),
 * the provider transparently retries the next configured backend.
 *
 * Primary (Serper) credential resolution order:
 *   1. tools.web.search.apiKey (top-level, when provider === "serper")
 *   2. plugins.entries.serper.config.webSearch.apiKey
 *   3. SERPER_API_KEY env var
 *
 * Fallback backends read their own standard env keys (BRAVE_API_KEY,
 * FIRECRAWL_API_KEY) — the same ones the stock providers use — so no extra
 * configuration is needed when those keys already exist in the Gateway env.
 *
 * Configure the chain via plugins.entries.serper.config.webSearch.fallbacks,
 * e.g. ["brave","firecrawl"], [] to disable, or ["firecrawl","brave"].
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SearchConfigRecord,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringArrayParam,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const SERPER_CREDENTIAL_PATH = "plugins.entries.serper.config.webSearch.apiKey";
const DEFAULT_SERPER_BASE_URL = "https://google.serper.dev";
const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com";
const BRAVE_SEARCH_ENDPOINT_PATH = "/res/v1/web/search";
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FALLBACK_CHAIN = ["brave", "firecrawl"] as const;
const MAX_BATCH_QUERIES = 100;
const FALLBACK_CONCURRENCY = 10;

const SerperSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "One search query. Use either query or queries, not both.",
    },
    queries: {
      type: "array",
      description:
        "Batch of 1-100 search queries. Serper sends these as one native mini-batch request; only fallback work is concurrency-limited.",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      maxItems: MAX_BATCH_QUERIES,
      uniqueItems: true,
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-20).",
      minimum: 1,
      maximum: 20,
    },
    type: {
      type: "string",
      description:
        "Serper endpoint: 'search' (default) or 'news'. Ignored by fallback backends (web only).",
      enum: ["search", "news"],
    },
    country: {
      type: "string",
      description: "2-letter country code (e.g. 'us', 'in', 'de').",
    },
    language: {
      type: "string",
      description: "Language code (e.g. 'en', 'de'). Serper 'hl'.",
    },
    date_range: {
      type: "string",
      description: "Recency filter: 'day', 'week', 'month', or 'year'.",
    },
  },
} satisfies Record<string, unknown>;

const SERPER_TBS: Record<string, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

/** Normalized single result before final content-wrapping. */
type RawResult = {
  title: string;
  url: string;
  description: string;
  published?: string;
  siteName?: string;
};

type BackendOutcome = {
  results: RawResult[];
  answer?: string;
  mode?: string;
};

type SearchOptions = {
  query: string;
  count: number;
  type: "search" | "news";
  country?: string;
  language?: string;
  tbs?: string;
};

type SerperResponse = {
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
  news?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    date?: string;
    source?: string;
  }>;
  answerBox?: { answer?: string; snippet?: string };
  knowledgeGraph?: { description?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

// ---------------------------------------------------------------------------
// Config / credential resolution
// ---------------------------------------------------------------------------

function resolveSerperApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["SERPER_API_KEY"])
  );
}

function resolveScopedString(
  searchConfig: SearchConfigRecord | undefined,
  scope: string,
  field: string,
  path: string,
): string | undefined {
  const scoped = isRecord(searchConfig?.[scope])
    ? (searchConfig[scope] as Record<string, unknown>)
    : undefined;
  return readConfiguredSecretString(scoped?.[field], path);
}

function resolveSerperBaseUrl(searchConfig?: SearchConfigRecord): string {
  const configured = resolveScopedString(
    searchConfig,
    "serper",
    "baseUrl",
    "plugins.entries.serper.config.webSearch.baseUrl",
  );
  return stripTrailingSlash(configured || "") || DEFAULT_SERPER_BASE_URL;
}

function resolveFallbackChain(searchConfig?: SearchConfigRecord): string[] {
  const scoped = isRecord(searchConfig?.serper)
    ? (searchConfig.serper as Record<string, unknown>)
    : undefined;
  const configured = scoped?.fallbacks;
  const list = Array.isArray(configured) ? configured : Array.from(DEFAULT_FALLBACK_CHAIN);
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    const id = entry.trim().toLowerCase();
    if (!id || id === "serper" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    chain.push(id);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Backend fetchers — each returns normalized RawResult[] or throws
// ---------------------------------------------------------------------------

function buildSerperRequest(params: {
  query: string;
  count: number;
  country?: string;
  language?: string;
  tbs?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { q: params.query, num: params.count };
  if (params.country) {
    body.gl = params.country.toLowerCase();
  }
  if (params.language) {
    body.hl = params.language.toLowerCase();
  }
  if (params.tbs) {
    body.tbs = params.tbs;
  }
  return body;
}

function normalizeSerperResponse(
  data: SerperResponse,
  type: "search" | "news",
  count: number,
): BackendOutcome {
  const raw = type === "news" ? (data.news ?? []) : (data.organic ?? []);
  const results: RawResult[] = raw.slice(0, count).map((entry) => ({
    title: entry.title ?? "",
    url: entry.link ?? "",
    description: entry.snippet ?? "",
    published: entry.date || undefined,
    siteName:
      (type === "news" && (entry as { source?: string }).source) ||
      resolveSiteName(entry.link ?? "") ||
      undefined,
  }));
  const answer =
    data.answerBox?.answer || data.answerBox?.snippet || data.knowledgeGraph?.description;
  return { results, answer: answer || undefined, mode: type };
}

async function requestSerper(params: {
  body: Record<string, unknown> | Array<Record<string, unknown>>;
  type: "search" | "news";
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
}): Promise<SerperResponse | SerperResponse[]> {
  const endpointUrl = `${params.baseUrl}/${params.type}`;
  return withTrustedWebSearchEndpoint(
    {
      url: endpointUrl,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "X-API-KEY": params.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(params.body),
      },
    },
    async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Serper API error ${response.status}: ${text.slice(0, 200) || response.statusText}`,
        );
      }
      return (await response.json()) as SerperResponse | SerperResponse[];
    },
  );
}

async function fetchSerper(params: {
  query: string;
  count: number;
  type: "search" | "news";
  country?: string;
  language?: string;
  tbs?: string;
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
}): Promise<BackendOutcome> {
  const data = await requestSerper({
    body: buildSerperRequest(params),
    type: params.type,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    timeoutSeconds: params.timeoutSeconds,
  });
  if (Array.isArray(data)) {
    throw new Error("Serper API returned a batch response for a single query");
  }
  return normalizeSerperResponse(data, params.type, params.count);
}

async function fetchSerperBatch(params: {
  queries: string[];
  count: number;
  type: "search" | "news";
  country?: string;
  language?: string;
  tbs?: string;
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
}): Promise<BackendOutcome[]> {
  const data = await requestSerper({
    body: params.queries.map((query) => buildSerperRequest({ ...params, query })),
    type: params.type,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    timeoutSeconds: params.timeoutSeconds,
  });
  if (!Array.isArray(data) || data.length !== params.queries.length) {
    throw new Error(
      `Serper API returned ${Array.isArray(data) ? data.length : "a non-batch response"} for ${params.queries.length} batched queries`,
    );
  }
  return data.map((entry) => normalizeSerperResponse(entry, params.type, params.count));
}

async function fetchBrave(params: {
  query: string;
  count: number;
  country?: string;
  apiKey: string;
  timeoutSeconds: number;
}): Promise<BackendOutcome> {
  const url = new URL(`${DEFAULT_BRAVE_BASE_URL}${BRAVE_SEARCH_ENDPOINT_PATH}`);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }

  const data = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Brave API error ${response.status}: ${text.slice(0, 200) || response.statusText}`,
        );
      }
      return (await response.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
            age?: string;
            profile?: { name?: string };
          }>;
        };
      };
    },
  );

  const raw = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const results: RawResult[] = raw.slice(0, params.count).map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    description: entry.description ?? "",
    published: entry.age || undefined,
    siteName: entry.profile?.name || resolveSiteName(entry.url ?? "") || undefined,
  }));
  return { results, mode: "search" };
}

async function fetchFirecrawl(params: {
  query: string;
  count: number;
  apiKey?: string;
  timeoutSeconds: number;
}): Promise<BackendOutcome> {
  const url = `${DEFAULT_FIRECRAWL_BASE_URL}/v2/search`;
  const body: Record<string, unknown> = { query: params.query, limit: params.count };

  const data = await withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      },
    },
    async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Firecrawl API error ${response.status}: ${text.slice(0, 200) || response.statusText}`,
        );
      }
      return (await response.json()) as Record<string, unknown>;
    },
  );

  // Firecrawl responses vary: data[], data.web[], data.results[], results[], web.results[]
  const candidates: unknown[] = [
    (data as { data?: unknown }).data,
    (data as { results?: unknown }).results,
    (data as { data?: { results?: unknown } }).data?.results,
    (data as { data?: { web?: unknown } }).data?.web,
    (data as { web?: { results?: unknown } }).web?.results,
    (data as { web?: unknown }).web,
  ];
  let raw: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      raw = candidate as Array<Record<string, unknown>>;
      break;
    }
  }

  const results: RawResult[] = raw.slice(0, params.count).map((entry) => {
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    const title =
      (typeof entry.title === "string" && entry.title) ||
      (typeof metadata?.title === "string" && (metadata.title as string)) ||
      "";
    const description =
      (typeof entry.description === "string" && entry.description) ||
      (typeof metadata?.description === "string" && (metadata.description as string)) ||
      (typeof entry.snippet === "string" && (entry.snippet as string)) ||
      "";
    const link =
      (typeof entry.url === "string" && entry.url) ||
      (typeof entry.link === "string" && (entry.link as string)) ||
      "";
    return {
      title,
      url: link,
      description,
      siteName: resolveSiteName(link) || undefined,
    };
  });
  return { results, mode: "search" };
}

// ---------------------------------------------------------------------------
// Backend dispatch
// ---------------------------------------------------------------------------

type BackendContext = {
  query: string;
  count: number;
  type: "search" | "news";
  country?: string;
  language?: string;
  tbs?: string;
  timeoutSeconds: number;
  searchConfig?: SearchConfigRecord;
};

function backendKeyStatus(provider: string, searchConfig?: SearchConfigRecord): string | undefined {
  switch (provider) {
    case "serper":
      return resolveSerperApiKey(searchConfig);
    case "brave":
      return (
        resolveScopedString(
          searchConfig,
          "brave",
          "apiKey",
          "plugins.entries.brave.config.webSearch.apiKey",
        ) ?? readProviderEnvValue(["BRAVE_API_KEY"])
      );
    case "firecrawl":
      // Firecrawl hosted allows keyless starter calls; treat as always attemptable.
      return (
        resolveScopedString(
          searchConfig,
          "firecrawl",
          "apiKey",
          "plugins.entries.firecrawl.config.webSearch.apiKey",
        ) ??
        readProviderEnvValue(["FIRECRAWL_API_KEY"]) ??
        "keyless"
      );
    default:
      return undefined;
  }
}

async function runBackend(provider: string, ctx: BackendContext): Promise<BackendOutcome> {
  switch (provider) {
    case "serper": {
      const apiKey = resolveSerperApiKey(ctx.searchConfig);
      if (!apiKey) {
        throw new Error("serper: missing SERPER_API_KEY");
      }
      return fetchSerper({
        query: ctx.query,
        count: ctx.count,
        type: ctx.type,
        country: ctx.country,
        language: ctx.language,
        tbs: ctx.tbs,
        baseUrl: resolveSerperBaseUrl(ctx.searchConfig),
        apiKey,
        timeoutSeconds: ctx.timeoutSeconds,
      });
    }
    case "brave": {
      const apiKey =
        resolveScopedString(
          ctx.searchConfig,
          "brave",
          "apiKey",
          "plugins.entries.brave.config.webSearch.apiKey",
        ) ?? readProviderEnvValue(["BRAVE_API_KEY"]);
      if (!apiKey) {
        throw new Error("brave: missing BRAVE_API_KEY");
      }
      return fetchBrave({
        query: ctx.query,
        count: ctx.count,
        country: ctx.country,
        apiKey,
        timeoutSeconds: ctx.timeoutSeconds,
      });
    }
    case "firecrawl": {
      const apiKey =
        resolveScopedString(
          ctx.searchConfig,
          "firecrawl",
          "apiKey",
          "plugins.entries.firecrawl.config.webSearch.apiKey",
        ) ?? readProviderEnvValue(["FIRECRAWL_API_KEY"]);
      return fetchFirecrawl({
        query: ctx.query,
        count: ctx.count,
        apiKey,
        timeoutSeconds: ctx.timeoutSeconds,
      });
    }
    default:
      throw new Error(`unknown backend: ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// Tool execute (with fallback chain)
// ---------------------------------------------------------------------------

function missingKeyPayload(chain: string[]): Record<string, unknown> {
  return {
    error: "no_web_search_backend_available",
    message: `web_search (serper) found no usable backend. Tried: serper, ${chain.join(
      ", ",
    )}. Set SERPER_API_KEY (or BRAVE_API_KEY / FIRECRAWL_API_KEY) in the Gateway env, or run \`${formatCliCommand(
      "openclaw configure --section web",
    )}\`.`,
    docs: "https://serper.dev",
  };
}

async function executeSerperSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const query = readStringParam(args, "query");
  const batchQueries = readStringArrayParam(args, "queries");
  if ((query ? 1 : 0) + (batchQueries ? 1 : 0) !== 1) {
    return {
      error: "invalid_query_input",
      message: "Provide exactly one of query or queries.",
    };
  }
  if (batchQueries && batchQueries.length > MAX_BATCH_QUERIES) {
    return {
      error: "batch_too_large",
      message: `queries accepts at most ${MAX_BATCH_QUERIES} entries.`,
    };
  }
  if (batchQueries && new Set(batchQueries).size !== batchQueries.length) {
    return {
      error: "duplicate_batch_query",
      message: "queries must not contain duplicates.",
    };
  }

  const type: SearchOptions["type"] = readStringParam(args, "type") === "news" ? "news" : "search";
  const requested =
    readPositiveIntegerParam(args, "count", {
      max: MAX_SEARCH_COUNT,
      message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
    }) ??
    searchConfig?.maxResults ??
    undefined;
  const count = resolveSearchCount(requested, DEFAULT_SEARCH_COUNT);
  const country = readStringParam(args, "country");
  const language = readStringParam(args, "language");
  const rawDateRange = readStringParam(args, "date_range");
  const tbs = rawDateRange ? SERPER_TBS[rawDateRange.toLowerCase()] : undefined;
  if (rawDateRange && !tbs) {
    return {
      error: "invalid_date_range",
      message: "date_range must be one of day, week, month, or year.",
    };
  }

  const queries = batchQueries ?? [query as string];
  const options: SearchOptions[] = queries.map((entry) => ({
    query: entry,
    count,
    type,
    country,
    language,
    tbs,
  }));
  if (batchQueries) {
    return executeSerperBatch(options, searchConfig);
  }
  return executeSearchOptions(options[0] as SearchOptions, searchConfig);
}

function searchCacheKey(options: SearchOptions, providerOrder: string[]): string {
  return buildSearchCacheKey([
    "serper-chain",
    options.type,
    options.query,
    options.count,
    options.country,
    options.language,
    options.tbs,
    providerOrder.join(">"),
  ]);
}

function successPayload(params: {
  options: SearchOptions;
  provider: string;
  outcome: BackendOutcome;
  attempts: Array<{ provider: string; ok: boolean; error?: string; count?: number }>;
  startedAt: number;
}): Record<string, unknown> {
  const results = params.outcome.results.map((result) => ({
    title: result.title ? wrapWebContent(result.title, "web_search") : "",
    url: result.url,
    description: result.description ? wrapWebContent(result.description, "web_search") : "",
    published: result.published || undefined,
    siteName: result.siteName || undefined,
  }));
  const payload: Record<string, unknown> = {
    query: params.options.query,
    provider: "serper",
    servedBy: params.provider,
    fallbackUsed: params.provider !== "serper",
    mode: params.outcome.mode ?? params.options.type,
    count: results.length,
    tookMs: Date.now() - params.startedAt,
    attempts: params.attempts,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results,
  };
  if (params.outcome.answer) {
    payload.answer = wrapWebContent(params.outcome.answer, "web_search");
  }
  return payload;
}

async function executeSearchOptions(
  options: SearchOptions,
  searchConfig?: SearchConfigRecord,
  runOrder?: string[],
  initialAttempts: Array<{
    provider: string;
    ok: boolean;
    error?: string;
    count?: number;
  }> = [],
  startedAt = Date.now(),
): Promise<Record<string, unknown>> {
  const fallbackChain = resolveFallbackChain(searchConfig);
  const providerOrder = ["serper", ...fallbackChain];
  const cacheKey = searchCacheKey(options, providerOrder);
  if (!runOrder) {
    const cached = readCachedSearchPayload(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const ctx: BackendContext = {
    ...options,
    timeoutSeconds,
    searchConfig,
  };
  const attempts = [...initialAttempts];
  let anyKeyAvailable = attempts.some((attempt) => attempt.error !== "no credential");

  for (const provider of runOrder ?? providerOrder) {
    if (!backendKeyStatus(provider, searchConfig)) {
      attempts.push({ provider, ok: false, error: "no credential" });
      continue;
    }
    anyKeyAvailable = true;
    try {
      const outcome = await runBackend(provider, ctx);
      if (!outcome.results.length) {
        attempts.push({ provider, ok: false, error: "no results", count: 0 });
        continue;
      }
      attempts.push({ provider, ok: true, count: outcome.results.length });
      const payload = successPayload({
        options,
        provider,
        outcome,
        attempts,
        startedAt,
      });
      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    } catch (err) {
      attempts.push({
        provider,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!anyKeyAvailable) {
    return { ...missingKeyPayload(fallbackChain), query: options.query };
  }
  return {
    query: options.query,
    provider: "serper",
    error: "all_backends_failed",
    message: `All web_search backends failed or returned no results (tried: ${providerOrder.join(
      ", ",
    )}).`,
    attempts,
    tookMs: Date.now() - startedAt,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await worker(values[index], index);
      }
    }),
  );
  return results;
}

function compactBatchResult(
  payload: Record<string, unknown>,
  cached: boolean,
): Record<string, unknown> {
  if (typeof payload.error === "string") {
    return {
      query: payload.query,
      ok: false,
      cached,
      error: payload.error,
      message: payload.message,
      attempts: payload.attempts,
    };
  }
  return {
    query: payload.query,
    ok: true,
    cached,
    servedBy: payload.servedBy,
    fallbackUsed: payload.fallbackUsed,
    count: payload.count,
    tookMs: payload.tookMs,
    answer: payload.answer,
    results: payload.results,
  };
}

async function executeSerperBatch(
  options: SearchOptions[],
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const fallbackChain = resolveFallbackChain(searchConfig);
  const providerOrder = ["serper", ...fallbackChain];
  const payloads = Array.from<Record<string, unknown> | undefined>({ length: options.length });
  const cached = Array.from<boolean>({ length: options.length }).fill(false);
  const pending: Array<{ options: SearchOptions; index: number }> = [];

  for (const [index, entry] of options.entries()) {
    const hit = readCachedSearchPayload(searchCacheKey(entry, providerOrder));
    if (hit) {
      payloads[index] = hit;
      cached[index] = true;
    } else {
      pending.push({ options: entry, index });
    }
  }

  const fallbacks: Array<{
    options: SearchOptions;
    index: number;
    attempts: Array<{ provider: string; ok: boolean; error?: string; count?: number }>;
  }> = [];
  const apiKey = resolveSerperApiKey(searchConfig);
  if (pending.length && apiKey) {
    try {
      const first = pending[0].options;
      const outcomes = await fetchSerperBatch({
        queries: pending.map((entry) => entry.options.query),
        count: first.count,
        type: first.type,
        country: first.country,
        language: first.language,
        tbs: first.tbs,
        baseUrl: resolveSerperBaseUrl(searchConfig),
        apiKey,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });
      for (const [pendingIndex, entry] of pending.entries()) {
        const outcome = outcomes[pendingIndex];
        if (!outcome.results.length) {
          fallbacks.push({
            ...entry,
            attempts: [{ provider: "serper", ok: false, error: "no results", count: 0 }],
          });
          continue;
        }
        const attempts = [{ provider: "serper", ok: true, count: outcome.results.length }];
        const payload = successPayload({
          options: entry.options,
          provider: "serper",
          outcome,
          attempts,
          startedAt,
        });
        payloads[entry.index] = payload;
        writeCachedSearchPayload(
          searchCacheKey(entry.options, providerOrder),
          payload,
          resolveSearchCacheTtlMs(searchConfig),
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const entry of pending) {
        fallbacks.push({
          ...entry,
          attempts: [{ provider: "serper", ok: false, error }],
        });
      }
    }
  } else {
    for (const entry of pending) {
      fallbacks.push({
        ...entry,
        attempts: [{ provider: "serper", ok: false, error: "no credential" }],
      });
    }
  }

  const fallbackPayloads = await mapWithConcurrency(
    fallbacks,
    FALLBACK_CONCURRENCY,
    async (entry) => ({
      index: entry.index,
      payload: await executeSearchOptions(
        entry.options,
        searchConfig,
        fallbackChain,
        entry.attempts,
        startedAt,
      ),
    }),
  );
  for (const entry of fallbackPayloads) {
    payloads[entry.index] = entry.payload;
  }

  const results = payloads.map((payload, index) =>
    compactBatchResult(payload as Record<string, unknown>, cached[index]),
  );
  const failed = results.filter((entry) => entry.ok === false).length;
  return {
    provider: "serper",
    mode: options[0].type,
    batch: true,
    queryCount: options.length,
    cachedCount: cached.filter(Boolean).length,
    failedCount: failed,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      wrapped: true,
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function createSerperToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search one query or up to 100 queries using Serper.dev (Google SERP). Batched queries use Serper's native mini-batch API in one request; only failed queries use the configured fallback chain. Returns compact per-query organic/news results.",
    parameters: SerperSearchSchema,
    execute: async (args) => executeSerperSearch(args, searchConfig),
  };
}

function resolveConfiguredSerperCredential(config: unknown): unknown {
  return resolveProviderWebSearchPluginConfig(config as never, "serper")?.apiKey;
}

function createSerperWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "serper",
    label: "Serper (Google SERP + Brave/Firecrawl fallback)",
    hint: "Google organic/news · falls back to Brave then Firecrawl",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Serper API key",
    envVars: ["SERPER_API_KEY"],
    placeholder: "serper-...",
    signupUrl: "https://serper.dev",
    docsUrl: "https://serper.dev/playground",
    autoDetectOrder: 55,
    credentialPath: SERPER_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: SERPER_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "serper" },
    }),
    getConfiguredCredentialValue: resolveConfiguredSerperCredential,
    createTool: (ctx) =>
      createSerperToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "serper",
          resolveProviderWebSearchPluginConfig(ctx.config, "serper"),
          { mirrorApiKeyToTopLevel: true },
        ),
      ),
  };
}

export default definePluginEntry({
  id: "serper",
  name: "Serper Plugin",
  description:
    "Serper.dev Google SERP web-search provider for OpenClaw with Brave/Firecrawl fallback.",
  register(api) {
    api.registerWebSearchProvider(createSerperWebSearchProvider());
  },
});
