import { useEffect, useRef, useState } from 'react';

import { NOT_CONNECTED_CODES, type NotConnectedCode } from '../../shared/service-off';

import { useSession } from '../session';

import { type LineTotal } from './contracts';

import { statementExtrasCopy } from './statement-extras-copy';
import { BANK_STATEMENTS_LETTERS_REQUEST, BANK_STATEMENTS_TAX_LIST } from '@intafaced/contracts/bank-statements-procedures';

const outside = (code: string | null | undefined): NotConnectedCode | null =>
  code && (NOT_CONNECTED_CODES as readonly string[]).includes(code) ? (code as NotConnectedCode) : null;

/** Per coin, the net of a set of lines, as the bank folded them (J-bank-16 #1). The same list under a statement and on Activity. */
export function LineTotals({ totals, testId }: { totals: readonly LineTotal[]; testId: string }) {
  const { t } = statementExtrasCopy.useCopy();
  return (
    <div data-testid={testId} className="bd-stack">
      <p className="money-caption">{t('totalsTitle')}</p>
      {totals.length === 0 ? (
        <p>{t('totalsNone')}</p>
      ) : (
        <ul>
          {totals.map((total) => (
            <li key={total.asset} data-asset={total.asset} data-net={total.net}>
              {t('totalLine', { asset: total.asset, net: total.net, lines: String(total.lines) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Said = { kind: 'off'; code: NotConnectedCode } | { kind: 'refused'; words: string; code: string | null } | null;

/**
 * J-bank-16 #2 (BK-acct-07): an ownership letter or a balance certificate. The bank answers; while no banking partner is
 * connected it refuses `rail.bank`, shown as the one service-off notice, and nothing is made.
 */
/** The letter request: busy while the bank answers, then what it said. Shared with the statements room. */
export function useStatementLetters() {
  const { t } = statementExtrasCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);

  async function ask(kind: 'ownership' | 'balance') {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    const result = await api.call(BANK_STATEMENTS_LETTERS_REQUEST, { kind });
    setBusy(false);
    if (result.ok) return;
    const code = outside(result.code);
    setSaid(code ? { kind: 'off', code } : { kind: 'refused', words: t('letterRefused'), code: result.code ?? null });
  }

  // `t` by its catalog's name, so the hook's type can be written out (TS5088: inferred, it is cyclic).
  return { t: t as typeof statementExtrasCopy.t, busy, said, ask };
}

type Tax = { kind: 'loading' } | { kind: 'list'; count: number } | Exclude<Said, null>;

/**
 * J-bank-16 #3 (BK-acct-07): tax statements for a year. They come from a tax calculation provider; while none is
 * connected the bank refuses `vendor.tax`, shown as the one service-off notice. No tax figure is worked out here.
 */
/** The tax statements read for the chosen year. Shared with the statements room. */
export function useTaxStatements() {
  const { t } = statementExtrasCopy.useCopy();
  const { api } = useSession();
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const [tax, setTax] = useState<Tax>({ kind: 'loading' });
  // The copy function is new on every render; reading it through a ref keeps the read from restarting each render,
  // which left the panel on "Opening tax statements…" for good (J-bank-16 #3).
  const words = useRef(t);
  words.current = t;

  useEffect(() => {
    let live = true;
    setTax({ kind: 'loading' });
    void api.call(BANK_STATEMENTS_TAX_LIST, { year }).then((result) => {
      if (!live) return;
      if (result.ok) return setTax({ kind: 'list', count: result.data.items.length });
      const code = outside(result.code);
      setTax(code ? { kind: 'off', code } : { kind: 'refused', words: words.current('taxRefused'), code: result.code ?? null });
    });
    return () => {
      live = false;
    };
  }, [api, year]);

  // `t` by its catalog's name, so the hook's type can be written out (TS5088: inferred, it is cyclic).
  return { t: t as typeof statementExtrasCopy.t, thisYear, year, setYear, tax };
}
