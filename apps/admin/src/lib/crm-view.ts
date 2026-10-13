/** Words and rules for the CRM's views: one title per view, one line of description under it, and what each view shows. */
export type CrmView = 'enquiries' | 'tasks' | 'campaigns' | 'duplicates' | 'exports';

const HEADINGS: Record<CrmView, { title: string; description: string | null }> = {
  enquiries: { title: 'Enquiries', description: null },
  tasks: { title: 'Follow-ups', description: 'Overdue first, then soonest due. Click a row to open the enquiry.' },
  campaigns: { title: 'Sources and campaigns', description: 'A link code identifies a campaign, never the identity of a deck reader.' },
  duplicates: {
    title: 'Duplicates',
    description: 'Contacts that share an email address. A match is only a hint, and nothing is merged automatically.',
  },
  exports: { title: 'Exports', description: 'Up to 200 enquiries per file, with original answers, consent and source.' },
};

export const viewHeading = (view: string) => HEADINGS[(view in HEADINGS ? view : 'enquiries') as CrmView];

/** The totals strip and Reports describe enquiries, so they appear only where enquiries do. */
export const viewShowsTotals = (view: string) => view === 'enquiries' || view === 'tasks';

const TOOLS: Partial<Record<string, string>> = { campaigns: 'Sources and campaigns', duplicates: 'Duplicates', exports: 'Exports' };
/** "Tools", or "Tools · Duplicates" while a tool is the open view. */
export const toolsLabel = (view: string) => (TOOLS[view] ? `Tools · ${TOOLS[view]}` : 'Tools');

/**
 * The line above the list. It is shown only while a search is running, because the totals strip already counts everything else.
 * Null means show nothing.
 */
export function listSummary({
  searching,
  loading,
  shown,
  overdue,
}: {
  searching: boolean;
  loading: boolean;
  shown: number;
  overdue: number;
}): string | null {
  if (!searching) return null;
  if (loading) return 'Searching…';
  return `${shown} shown · ${overdue} overdue`;
}

/** Pagination is only worth showing when there is somewhere to go. */
export const pagerVisible = (hasNext: boolean, onLaterPage: boolean) => hasNext || onLaterPage;
