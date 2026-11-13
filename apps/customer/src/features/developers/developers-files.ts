/**
 * The developer docs' static files: each written page's markdown variant, the assistants' index (llms.txt) and the
 * machine-readable files (OpenAPI, the request collection). They are made from the same English copy and route tables
 * as the pages, at build time (`developerDocs` in vite.config.ts writes them into `dist/developers/`, and `vite dev`
 * serves them from memory), so they are never committed: two changes that each add a route no longer edit the same
 * generated lines.
 */
import { DOCS_PAGES, llmsTxt, markdownOf } from './developers-markdown';
import { openApiDocument, requestCollection } from './developers-reference';

/** Every file by its name under `/developers/`, exactly as served. */
export function developerFiles(): Record<string, string> {
  return {
    'openapi.json': JSON.stringify(openApiDocument(), null, 2),
    'collection.json': JSON.stringify(requestCollection(), null, 2),
    'llms.txt': llmsTxt(),
    ...Object.fromEntries(DOCS_PAGES.map((page) => [`${page.slug}.md`, markdownOf(page)])),
  };
}
