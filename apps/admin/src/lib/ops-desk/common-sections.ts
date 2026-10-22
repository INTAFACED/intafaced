import type { DeskSpec } from './types';

/**
 * The same eight sections on every module desk (OPS-founder-01, founder-001), shaped on the trade-ops pages: overview, items,
 * failures, limits, halt, approvals, audit and exports.
 *
 * A desk keeps its own sections (pools, loans, cards…), because that is where its reads live. This set sits on top and says,
 * for each of the eight, which of those sections fill it, which other console page does, or exactly why nothing can yet.
 * A common section with no source is never hidden: it shows its blocker under the typed code `ops.desk_section_unwired`.
 */

export const COMMON_SECTION_IDS = ['overview', 'items', 'failures', 'limits', 'halt', 'approvals', 'audit', 'exports'] as const;
export type CommonSectionId = (typeof COMMON_SECTION_IDS)[number];

export const COMMON_SECTION_TITLES: Readonly<Record<CommonSectionId, string>> = {
  overview: 'Overview',
  items: 'Items',
  failures: 'Failures',
  limits: 'Limits',
  halt: 'Halt',
  approvals: 'Approvals',
  audit: 'Audit',
  exports: 'Exports',
};

/** The desks that carry the common set. Predict has no service yet, so its desk is the set alone, every section unwired. */
export type CommonDeskId = 'bank' | 'pay' | 'academy' | 'mining' | 'predict';

export const DESK_SECTION_UNWIRED = 'ops.desk_section_unwired';

export interface CommonLink {
  readonly href: string;
  readonly label: string;
}

/** Desk sections on the same page (by section id) and other console pages that fill it. */
export interface WiredFill {
  readonly kind: 'wired';
  readonly note: string;
  readonly sections: readonly string[];
  readonly links?: readonly CommonLink[];
}
/** No source yet. `blocker` names what is missing; `links` point to the nearest thing that does exist, if any. */
export interface UnwiredFill {
  readonly kind: 'unwired';
  readonly blocker: string;
  readonly links?: readonly CommonLink[];
}
/** What fills one common section on one desk. `exports`: every list on the desk downloads as CSV, worked out from the desk itself, so a new list is never left out. */
export type CommonFill = WiredFill | UnwiredFill | { readonly kind: 'exports' };

export type CommonSectionSet = Readonly<Record<CommonSectionId, CommonFill>>;

const wired = (note: string, sections: readonly string[], links?: readonly CommonLink[]): WiredFill => ({
  kind: 'wired',
  note,
  sections,
  ...(links ? { links } : {}),
});
const unwired = (blocker: string, links?: readonly CommonLink[]): UnwiredFill => ({
  kind: 'unwired',
  blocker,
  ...(links ? { links } : {}),
});
const EXPORTS: CommonFill = { kind: 'exports' };

const killLink = (module: string, label: string): CommonLink => ({ href: `/#module=${module}`, label });

export const COMMON_SECTION_SETS: Readonly<Record<CommonDeskId, CommonSectionSet>> = {
  bank: {
    overview: wired('Whether svc-bank answers, and the bank ops jobs that run on Operator tools.', ['service']),
    items: wired('Earn pools, the loan book, cards, ramps, business transfers and one customer’s balances, each from svc-bank.', [
      'pools',
      'loans',
      'cards',
      'ramps',
      'business',
      'customer-balances',
    ]),
    failures: wired(
      'Open loans with no usable price, ramp rail failures in the last 24 hours, and global sends held before they were debited.',
      ['loans', 'ramps', 'global-holds'],
    ),
    limits: wired('The thresholds a borrower is held to and the approval rules the business bank enforces.', ['loans', 'business']),
    halt: wired(
      'Stop the bank at the edge with a second founder, or stop one person or business from using it.',
      ['freezes'],
      [killLink('bank', 'Bank kill switch (two founders)')],
    ),
    approvals: wired('The two-founder card freeze, and business transfers waiting for their own checker.', ['cards', 'business']),
    audit: unwired(
      'svc-bank has no operator audit read, so who did what on this desk cannot be listed here. Kill-switch changes for the bank are audited on the edge and shown on the module board.',
      [killLink('bank', 'Bank on the module board')],
    ),
    exports: EXPORTS,
  },
  pay: {
    overview: wired('How personal transfers are doing in the last 24 hours and 7 days.', ['health']),
    items: wired('Bill payments and global sends across every payer, and any one transfer by its id.', ['bills', 'global', 'failures']),
    failures: wired('Rejected standing-order transfers, failed bill payments and failed global sends.', ['failures', 'bills', 'global']),
    limits: unwired(
      'svc-bank publishes the personal transfer limits (ops.publishTransferTerms, two founders) but has no operator read of the published terms, so this desk cannot show them.',
    ),
    halt: wired(
      'Personal transfers run in svc-bank, so the bank kill switch stops them; it needs a second founder.',
      [],
      [killLink('bank', 'Bank kill switch (two founders)')],
    ),
    approvals: unwired(
      'svc-bank has no operator action on a personal transfer, so there is nothing to approve. Each action is shown switched off.',
      [{ href: '#actions', label: 'Actions, switched off with the reason' }],
    ),
    audit: unwired('svc-bank keeps no operator audit read for personal transfers, so who did what cannot be listed here.'),
    exports: EXPORTS,
  },
  academy: {
    overview: wired('Whether svc-academy answers, and how much teaching content exists.', ['catalogue']),
    items: wired('The curriculum, certificate definitions, seasons and paper trading.', ['catalogue', 'certificates', 'programmes']),
    failures: unwired(
      'svc-academy gives no failure read: no list of failed imports, grants or enrolments. Import status shows only whether the content bar is met.',
    ),
    limits: unwired('svc-academy has no operator-set limits to read.'),
    halt: wired(
      'Stop the Academy at the edge; it needs a second founder.',
      [],
      [killLink('academy', 'Academy kill switch (two founders)')],
    ),
    approvals: wired('Appointing, freezing and unfreezing ambassadors, and deciding residencies, each a two-founder request.', [
      'ambassadors',
    ]),
    audit: unwired('svc-academy has no operator read of certificate grants or of who changed what, so there is no audit to show.'),
    exports: EXPORTS,
  },
  mining: {
    overview: wired('Pool terms and payout windows as svc-mining-pool reports them.', ['mining']),
    items: wired('Payout windows, shares by window and registered workers.', ['mining']),
    failures: wired('Shares refused in each window. svc-mining-pool gives no list of failed payouts: no window is paid yet.', ['mining']),
    limits: wired('The pool fee and window size from the pool’s configuration, blank with the reason when unset.', ['mining']),
    halt: unwired(
      'No edge route forwards to svc-mining-pool, so a kill would be recorded but would refuse nothing. The console does not offer one.',
      [killLink('mining-pool', 'Mining pool on the module board')],
    ),
    approvals: unwired('svc-mining-pool has no operator action to approve. Payouts refuse until emission is published.'),
    audit: unwired('svc-mining-pool has no operator audit read.'),
    exports: EXPORTS,
  },
  predict: Object.fromEntries(
    COMMON_SECTION_IDS.map((id) => [
      id,
      unwired(
        'No Predict service runs on this deployment: INTACORE and the Predict service are not built yet, so there is nothing to read or act on.',
      ),
    ]),
  ) as Record<CommonSectionId, CommonFill>,
};

export interface ResolvedCommonSection {
  readonly id: CommonSectionId;
  readonly title: string;
  readonly fill: WiredFill | UnwiredFill;
}

/** Desk sections holding at least one list, which is what carries an "Export CSV". */
export function exportableSections(desk: DeskSpec | null): string[] {
  return desk ? desk.sections.filter((s) => s.reads.some((r) => r.shape === 'list')).map((s) => s.id) : [];
}

/**
 * The eight sections for one desk, in order, with `exports` worked out from the desk and every section id checked against it.
 * A section id the desk does not have is a bug in this file, so it throws rather than draw a link to nothing.
 */
export function resolveCommonSections(setId: CommonDeskId, desk: DeskSpec | null): ResolvedCommonSection[] {
  const known = new Set(desk?.sections.map((s) => s.id) ?? []);
  return COMMON_SECTION_IDS.map((id) => {
    const raw = COMMON_SECTION_SETS[setId][id];
    let fill: WiredFill | UnwiredFill;
    if (raw.kind === 'exports') {
      const sections = exportableSections(desk);
      fill =
        sections.length > 0
          ? wired('Every list on this desk downloads as CSV of exactly the rows shown, with the read time in the file name.', sections)
          : unwired('This desk has no list to export.');
    } else {
      fill = raw;
    }
    if (fill.kind === 'wired') {
      for (const s of fill.sections)
        if (!known.has(s)) throw new Error(`${setId}.${id} names desk section "${s}", which the desk does not have`);
    }
    return { id, title: COMMON_SECTION_TITLES[id], fill };
  });
}
