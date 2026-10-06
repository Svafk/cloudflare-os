// The agent's web search: Cloudflare's Web Search API, through the Workers AI binding's
// `websearch()` and the deployment's own AI Gateway. docs/web-search.md explains the design.
//
// A query is text the agent wrote, sent to a third party, so it is treated like a webFetch URL: the
// caller gets `WebEnv` from the restricted-data gate, and every query that is sent is recorded as an
// observation, whatever comes back.

import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { z } from "zod";
import type { WebEnv } from "./web-fetch";

// Pinned rather than left to the API's default, so the provider stays one with zero data
// retention.
const PROVIDER = "ceramic";

// What the model sees of each result; zod drops the rest (image and favicon URLs).
const RESULT_SCHEMA = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  lastModifiedDate: z.string().optional(),
});
const RESPONSE_SCHEMA = z.object({ items: z.array(RESULT_SCHEMA) });

/** One search result, as the provider returned it. */
export type WebSearchResult = z.infer<typeof RESULT_SCHEMA>;

/**
 * Searches the web for `query`. Throws without sending anything if the deployment has no AI Gateway
 * the binding can reach. Once the query is sent, calls `audit` exactly once, whether the search
 * succeeds or fails.
 */
export async function webSearch(
  env: WebEnv,
  query: string,
  audit: (description: ObservationDescription) => Promise<void>,
): Promise<WebSearchResult[]> {
  // The binding reaches only gateways in the Worker's own account.
  const gatewayId = env.gateway?.sameAccountGateway;
  if (gatewayId === undefined) {
    throw new Error(
      "Web search is not available on this deployment. It needs an AI Gateway in the Worker's " +
        "own account, reached through the Workers AI binding.",
    );
  }

  let results: WebSearchResult[] | undefined;
  try {
    const response = await env.ai.websearch({ gatewayId, query, provider: PROVIDER });
    if (!response.ok) {
      throw new Error(`Web search failed with HTTP ${response.status}: ${await response.text()}`);
    }
    results = RESPONSE_SCHEMA.parse(await response.json()).items;
    return results;
  } finally {
    await audit(describeSearch(query, results));
  }
}

/**
 * Renders results as the tool output the model sees: JSON, so page text can't pose as structure,
 * holding as many whole results as fit in `maxChars`, then a note of how many were left out.
 */
export function formatWebSearchResults(results: WebSearchResult[], maxChars: number): string {
  let shown = results.length;
  let text = JSON.stringify(results);
  while (shown > 0 && text.length > maxChars) {
    shown--;
    text = `${JSON.stringify(results.slice(0, shown))}\n(${results.length - shown} more results not shown)`;
  }
  return text;
}

// Built like a gatekeeper's description, so the query and URLs are shown exactly: as literal
// fields, escaped as JSON if they contain invisible characters.
function describeSearch(query: string, results: WebSearchResult[] | undefined): ObservationDescription {
  const outcome = results === undefined
    ? "The search failed."
    : `It returned ${results.length} ${results.length === 1 ? "result" : "results"}.`;
  const builder = buildDescription(`Sent this query to Ceramic.ai through AI Gateway. ${outcome}`)
    .inline("Query", query);
  if (results !== undefined && results.length > 0) {
    builder.list("Results", results.map((result) => result.url));
  }
  const { description, fields } = builder.finish();
  return { title: "Search the web", description, fields };
}
