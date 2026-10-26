import * as React from 'react';
import type { LegalMomentId, Market } from '../types.js';
import { LEGAL_MOMENTS, resolveLegal, type TextRun } from './registry.js';

const MISSING: Record<'market-unset' | 'lawyer' | 'value-unset', string> = {
  'market-unset': 'The market this account is served from isn’t set yet, so this notice can’t be shown.',
  lawyer: 'The wording for this notice hasn’t been approved yet.',
  'value-unset': 'A figure this notice must state isn’t set yet.',
};

function Runs({ runs, onLink }: { runs: readonly TextRun[]; onLink?: () => void }) {
  return (
    <>
      {runs.map((run, i) => {
        let node: React.ReactNode = run.text;
        if (run.link) {
          node = onLink ? (
            <button type="button" className="lt-legal-link" onClick={onLink}>
              {run.text}
            </button>
          ) : (
            <span className="lt-legal-link">{run.text}</span>
          );
        }
        if (run.underline && !run.link) node = <u>{node}</u>;
        if (run.bold) node = <strong>{node}</strong>;
        return <React.Fragment key={i}>{node}</React.Fragment>;
      })}
    </>
  );
}

export interface LegalSlotProps {
  moment: LegalMomentId;
  market: Market;
  /** ISO date the screen is shown on; dated wording switches on it. Defaults to today. */
  on?: string;
  values?: Readonly<Record<string, string | undefined>>;
  /** Opens the risk summary ("Take 2 mins to learn more"). */
  onLink?: () => void;
}

/**
 * One legal moment in the market in force. Fixed text renders exactly as the rule gives it; anything else renders
 * the designed "wording missing" refusal in the same slot, so the layout never moves and nothing is invented.
 */
export function LegalSlot({ moment, market, on, values, onLink }: LegalSlotProps) {
  const today = on ?? new Date().toISOString().slice(0, 10);
  const r = resolveLegal(moment, market, today, values);
  if (r.status === 'not-applicable') return null;
  const band = moment === 'crypto-risk-band' || moment === 'credit-warning' || moment === 'cfd-warning';
  return (
    <div
      className={band ? 'lt-legal lt-legal-band' : 'lt-legal'}
      data-slot="legal"
      data-moment={moment}
      data-legal-status={r.status}
      data-legal-slot={moment}
      data-legal-slot-type={LEGAL_MOMENTS[moment].type}
      data-legal-slot-state={r.status === 'missing' ? 'refused' : undefined}
      role={band ? 'region' : undefined}
      aria-label={band ? 'Risk warning' : undefined}
    >
      {r.status === 'fixed' ? (
        <p className="lt-legal-text" lang="en" dir="ltr">
          <Runs runs={r.runs} onLink={onLink} />
        </p>
      ) : (
        <p className="lt-legal-text lt-legal-missing">
          {MISSING[r.reason]}
          {r.rule ? <span className="lt-ref"> Ref {r.rule}</span> : null}
        </p>
      )}
    </div>
  );
}
