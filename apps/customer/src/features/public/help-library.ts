import { z } from 'zod';
import { supportKbLibrarySchema } from '@intafaced/contracts/support-kb-library';
import { contractProcedure } from '../../shared/contract-call';
import { helpArticle } from './help-guards';

/** The help library (SP-kb-01): the categories and sections support staff made, read signed out. */
export const helpLibraryRead = contractProcedure('support', 'kbLibrary', { output: supportKbLibrarySchema });

/** One section's published answers the reader may see. */
export const helpSectionRead = contractProcedure('support', 'kbSection', {
  input: z.object({ sectionId: z.string().min(1), limit: z.number().int().positive() }),
  output: z.object({
    category: z.object({ id: z.string(), name: z.string() }),
    section: z.object({ id: z.string(), name: z.string() }),
    articles: z.array(helpArticle),
  }),
});

/** The page size a section page asks for. A section with more shows the first page and says so. */
export const HELP_SECTION_WINDOW = 100;

export type HelpLibraryPath = { kind: 'category'; id: string } | { kind: 'section'; id: string } | null;

/** `/help/category/<id>` and `/help/section/<id>`; anything else is not a library page. */
export function helpLibraryPath(path: string): HelpLibraryPath {
  const match = /^\/help\/(category|section)\/([a-z0-9][a-z0-9-]{0,63})$/.exec(path);
  return match ? { kind: match[1] as 'category' | 'section', id: match[2]! } : null;
}

export const helpCategoryHref = (id: string) => `/help/category/${encodeURIComponent(id)}`;
export const helpSectionHref = (id: string) => `/help/section/${encodeURIComponent(id)}`;
