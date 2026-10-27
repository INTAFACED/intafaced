import * as React from 'react';
import { LegalSlot } from '../../components/index.js';
import type { LegalMomentId, Market } from '../types.js';
import { LEGAL_MOMENTS, resolveLegal } from './registry.js';

const MISSING: Record<'market-unset' | 'lawyer' | 'value-unset', string> = {
  'market-unset': 'The market this account is served from isn’t set yet, so this notice can’t be shown.',
  lawyer: 'The wording for this notice hasn’t been approved yet.',
  'value-unset': 'A figure this notice must state isn’t set yet.',
};

/** Moments drawn as the risk band at the top of the room. */
export const BAND_MOMENTS: ReadonlySet<LegalMomentId> = new Set(
  Object.values(LEGAL_MOMENTS)
    .filter((m) => m.placement === 'frame-top')
    .map((m) => m.id),
);

export interface RegistryLegalSlotProps {
  moment: LegalMomentId;
  market: Market;
  /** ISO date the screen is shown on; dated wording switches on it. Defaults to today. */
  on?: string;
  values?: Readonly<Record<string, string | undefined>>;
  /** Opens the risk summary ("Take 2 mins to learn more"). */
  onLink?: () => void;
}

/**
 * One legal moment in the market in force, drawn by the kit's LegalSlot. This wrapper alone reads the registry:
 * fixed text goes in exactly as the rule gives it (the rule's link becomes the kit's learn-more button), and
 * anything else becomes the designed "wording missing" refusal in the same slot, so nothing is invented.
 */
export function RegistryLegalSlot({ moment, market, on, values, onLink }: RegistryLegalSlotProps) {
  const today = on ?? new Date().toISOString().slice(0, 10);
  const r = resolveLegal(moment, market, today, values);
  if (r.status === 'not-applicable') return null;
  const band = BAND_MOMENTS.has(moment);
  const common = {
    type: LEGAL_MOMENTS[moment].type,
    moment,
    jurisdiction: market,
    textId: `${moment}.${market}`,
    label: band ? 'Risk warning' : 'Legal notice',
  };
  if (r.status === 'missing') {
    const ref = r.rule ? ` Ref ${r.rule}` : '';
    return <LegalSlot {...common} className={band ? 'lt-legal-band' : undefined} text={null} missing={`${MISSING[r.reason]}${ref}`} />;
  }
  const link = r.runs.find((run) => run.link);
  // Without a handler the link's words stay in the text, so the fixed wording is never cut short.
  const body = r.runs
    .filter((run) => !run.link || !onLink)
    .map((run) => run.text)
    .join('')
    .trim();
  const bold = r.runs.some((run) => run.bold);
  return (
    <LegalSlot
      {...common}
      className={band ? 'lt-legal-band' : undefined}
      bold={bold}
      lang="en"
      dir="ltr"
      text={body}
      missing=""
      learnMore={link && onLink ? { label: link.text, onOpen: onLink } : undefined}
    />
  );
}
