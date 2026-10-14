/**
 * What the address bar says about the CRM screen: which view is open, and which enquiry, if any. Only these two things are in
 * the address, never a name, an email or anything typed. `/crm?enquiry=<id>` (the old address, and where sign-in sends a
 * founder back to) still opens that enquiry in the Inbox.
 */
import { isEnquiryId } from '@/lib/crm-return';

export const MAIN_VIEWS = ['inbox', 'raise', 'people'] as const;
export const TOOL_VIEWS = ['followups', 'campaigns', 'duplicates', 'exports'] as const;
export type MainView = (typeof MAIN_VIEWS)[number];
export type ToolView = (typeof TOOL_VIEWS)[number];
export type CrmViewId = MainView | ToolView;
export const DEFAULT_VIEW: CrmViewId = 'inbox';

export const isMainView = (view: string): view is MainView => (MAIN_VIEWS as readonly string[]).includes(view);
export const isToolView = (view: string): view is ToolView => (TOOL_VIEWS as readonly string[]).includes(view);
export const isCrmView = (view: string): view is CrmViewId => isMainView(view) || isToolView(view);

export type CrmUrlState = { view: CrmViewId; enquiry: string | null };

/** Reads `?view=…&enquiry=…`. An unknown view is the Inbox; an enquiry that is not a real id is ignored; a tool view has no enquiry. */
export function parseCrmUrl(search: string): CrmUrlState {
  const params = new URLSearchParams(search);
  const asked = params.get('view') ?? '';
  const view: CrmViewId = isCrmView(asked) ? asked : DEFAULT_VIEW;
  const id = params.get('enquiry');
  return { view, enquiry: isMainView(view) && isEnquiryId(id) ? id : null };
}

/** "/crm?view=raise&enquiry=<id>". */
export function crmUrl(state: CrmUrlState): string {
  const params = new URLSearchParams({ view: state.view });
  if (state.enquiry && isMainView(state.view) && isEnquiryId(state.enquiry)) params.set('enquiry', state.enquiry);
  return `/crm?${params.toString()}`;
}

export const VIEW_TITLE: Record<CrmViewId, string> = {
  inbox: 'Waiting on us',
  raise: 'Raise',
  people: 'People',
  followups: 'Follow-ups',
  campaigns: 'Sources and campaigns',
  duplicates: 'Duplicates',
  exports: 'Exports',
};
export const VIEW_NOTE: Partial<Record<CrmViewId, string>> = {
  followups: 'Overdue first, then soonest due. Click a row to open the enquiry.',
  campaigns: 'A link code identifies a campaign, never the identity of a deck reader.',
  duplicates: 'Contacts that share an email address. A match is only a hint, and nothing is merged automatically.',
  exports: 'Up to 200 enquiries per file, with original answers, consent and source.',
};
export const TOOL_LABEL: Record<ToolView, string> = {
  followups: 'Follow-ups',
  campaigns: 'Sources and campaigns',
  duplicates: 'Duplicates',
  exports: 'Exports',
};
