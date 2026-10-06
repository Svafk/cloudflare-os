import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { AiGatewayConfig } from "../src/ai-gateway.js";
import type { WebEnv } from "../src/web-fetch.js";
import { formatWebSearchResults, webSearch } from "../src/web-search.js";

type WebSearchStub = (request: AiWebSearchRequest) => Promise<Response>;

// `sameAccount: false` is the cross-account deployment, which reaches its gateway over HTTPS and so
// has no gateway the binding can reach.
function makeEnv(websearch: WebSearchStub, { sameAccount = true } = {}): WebEnv {
  const ai = { websearch } as unknown as Ai;
  const gateway = new AiGatewayConfig({
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_USE_BINDING: sameAccount ? undefined : "false",
    WORKERS_AI: ai,
  } as Cloudflare.Env);
  return { ai, gateway };
}

function respond(items: unknown[]): WebSearchStub {
  return async () => Response.json({ items, metadata: { query: "q", requestId: "r", latencyMs: 1 } });
}

const insufficientCredits: WebSearchStub = async () => new Response("insufficient credits", { status: 402 });

function result(i: number) {
  return { title: `T${i}`, url: `https://example.com/${i}`, description: "d".repeat(900) };
}

function recorder() {
  const descriptions: ObservationDescription[] = [];
  return {
    descriptions,
    audit: async (description: ObservationDescription) => {
      descriptions.push(description);
    },
  };
}

describe("webSearch", () => {
  it("searches through the same-account gateway with the pinned provider", async () => {
    const websearch = vi.fn(respond([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
      faviconUrl: "https://developers.cloudflare.com/favicon.png",
    }]));

    const results = await webSearch(makeEnv(websearch), "workers docs", recorder().audit);

    expect(websearch).toHaveBeenCalledWith({
      gatewayId: "platform-gateway", query: "workers docs", provider: "ceramic",
    });
    expect(results).toEqual([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
    }]);
  });

  it("sends nothing without a gateway the binding can reach", async () => {
    const websearch = vi.fn(respond([]));
    const { audit, descriptions } = recorder();

    for (const env of [makeEnv(websearch, { sameAccount: false }), { ai: makeEnv(websearch).ai, gateway: null }]) {
      await expect(webSearch(env, "q", audit)).rejects.toThrow("Web search is not available");
    }
    expect(websearch).not.toHaveBeenCalled();
    expect(descriptions).toEqual([]);
  });

  it("audits a successful search with the query and result URLs as literal fields", async () => {
    const { audit, descriptions } = recorder();

    await webSearch(makeEnv(respond([
      { url: "https://a.example/", title: "A" },
      { url: "https://b.example/x", title: "B" },
    ])), "`code` and **markdown**", audit);

    expect(descriptions).toEqual([{
      title: "Search the web",
      description: "Sent this query to Ceramic.ai through AI Gateway. It returned 2 results.",
      fields: [
        { label: "Query", kind: "inline", value: "`code` and **markdown**" },
        { label: "Results", kind: "list", items: ["https://a.example/", "https://b.example/x"] },
      ],
    }]);
  });

  it("shows a query with invisible characters escaped in the audit", async () => {
    const { audit, descriptions } = recorder();

    await webSearch(makeEnv(respond([])), "secret\u202eterces", audit);

    expect(descriptions[0].fields).toEqual([
      { label: "Query", kind: "json", value: '"secret\\u202eterces"' },
    ]);
  });

  it("audits every failure once the query has been sent", async () => {
    const failures: WebSearchStub[] = [
      insufficientCredits,
      async () => { throw new Error("binding unavailable"); },
      async () => Response.json({ unexpected: true }),
    ];
    for (const websearch of failures) {
      const { audit, descriptions } = recorder();
      await expect(webSearch(makeEnv(websearch), "q", audit)).rejects.toThrow();
      expect(descriptions).toEqual([{
        title: "Search the web",
        description: "Sent this query to Ceramic.ai through AI Gateway. The search failed.",
        fields: [{ label: "Query", kind: "inline", value: "q" }],
      }]);
    }
  });

  it("reports the status and body of a failed search to the agent", async () => {
    await expect(webSearch(makeEnv(insufficientCredits), "q", recorder().audit))
      .rejects.toThrow("Web search failed with HTTP 402: insufficient credits");
  });
});

describe("formatWebSearchResults", () => {
  it("returns every result as JSON when they fit", () => {
    const results = [result(1), result(2)];
    expect(formatWebSearchResults(results, 10_000)).toBe(JSON.stringify(results));
  });

  it("keeps whole results while they fit and says how many were left out", () => {
    const results = Array.from({ length: 10 }, (_, i) => result(i));

    const text = formatWebSearchResults(results, 3000);

    expect(text.length).toBeLessThanOrEqual(3000);
    const [json, note] = text.split("\n");
    expect(JSON.parse(json)).toEqual(results.slice(0, 3));
    expect(note).toBe("(7 more results not shown)");
  });
});
