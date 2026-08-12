import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestBodies: [] as unknown[],
  responses: [] as unknown[],
  writeCache: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...original,
    readCachedSearchPayload: vi.fn(() => undefined),
    writeCachedSearchPayload: mocks.writeCache,
    withTrustedWebSearchEndpoint: vi.fn(
      async (params: { init: RequestInit }, run: (response: Response) => Promise<unknown>) => {
        mocks.requestBodies.push(JSON.parse(String(params.init.body)));
        return run(
          new Response(JSON.stringify(mocks.responses.shift()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    ),
  };
});

import plugin from "./index.js";

const TEST_API_KEY = ["test", "key"].join("-");

function createTool() {
  type CapturedProvider = {
    createTool: (context: {
      config?: Record<string, unknown>;
      searchConfig?: Record<string, unknown>;
    }) => {
      parameters: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const capture: { provider?: CapturedProvider } = {};
  plugin.register({
    registerWebSearchProvider(value: CapturedProvider) {
      capture.provider = value;
    },
  } as never);
  const provider = capture.provider;
  if (!provider) {
    throw new Error("provider was not registered");
  }
  return provider.createTool({
    searchConfig: {
      apiKey: TEST_API_KEY,
      cacheTtlMinutes: 1,
      serper: { fallbacks: [] },
    },
  });
}

function responseFor(query: string) {
  return {
    organic: [{ title: `${query} title`, link: `https://example.com/${query}`, snippet: query }],
  };
}

describe("Serper native mini-batches", () => {
  beforeEach(() => {
    process.env.SERPER_API_KEY = TEST_API_KEY;
    mocks.requestBodies.length = 0;
    mocks.responses.length = 0;
    mocks.writeCache.mockClear();
  });

  it("advertises batches of up to 100 queries", () => {
    const tool = createTool();
    const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.queries.maxItems).toBe(100);
  });

  it("sends all queries in one native Serper request", async () => {
    mocks.responses.push([responseFor("alpha"), responseFor("beta"), responseFor("gamma")]);
    const result = await createTool().execute({
      queries: ["alpha", "beta", "gamma"],
      count: 1,
    });

    expect(mocks.requestBodies).toEqual([
      [
        { q: "alpha", num: 1 },
        { q: "beta", num: 1 },
        { q: "gamma", num: 1 },
      ],
    ]);
    expect(result).toMatchObject({ batch: true, queryCount: 3, failedCount: 0 });
    expect(result.results).toHaveLength(3);
    expect(mocks.writeCache).toHaveBeenCalledTimes(3);
  });

  it("keeps a full 100-query batch in one provider request", async () => {
    const queries = Array.from({ length: 100 }, (_, index) => `query-${index}`);
    mocks.responses.push(queries.map(responseFor));

    const result = await createTool().execute({ queries, count: 1 });

    expect(mocks.requestBodies).toHaveLength(1);
    expect(mocks.requestBodies[0]).toHaveLength(100);
    expect(result).toMatchObject({ batch: true, queryCount: 100, failedCount: 0 });
  });

  it("reports an individual empty response without failing the whole batch", async () => {
    mocks.responses.push([responseFor("alpha"), { organic: [] }, responseFor("gamma")]);
    const result = await createTool().execute({
      queries: ["alpha", "beta", "gamma"],
      count: 1,
    });

    expect(result).toMatchObject({ batch: true, queryCount: 3, failedCount: 1 });
    expect(result.results).toMatchObject([
      { query: "alpha", ok: true },
      { query: "beta", ok: false, error: "all_backends_failed" },
      { query: "gamma", ok: true },
    ]);
  });

  it("rejects ambiguous and oversized inputs before network access", async () => {
    const tool = createTool();
    await expect(tool.execute({ query: "alpha", queries: ["beta"] })).resolves.toMatchObject({
      error: "invalid_query_input",
    });
    await expect(
      tool.execute({ queries: Array.from({ length: 101 }, (_, index) => `q${index}`) }),
    ).resolves.toMatchObject({ error: "batch_too_large" });
    expect(mocks.requestBodies).toHaveLength(0);
  });
});
