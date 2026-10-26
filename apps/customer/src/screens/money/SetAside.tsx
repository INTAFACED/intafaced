import { Amount, fmtAmount } from './deps';
import { moneyCopy } from './copy';
import { setAsideLines, setAsideSum, shortId, type SetAsideWhat } from './set-aside';
import { useLockSplits } from './portfolio-source';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/**
 * One claim in plain words: an order or a withdrawal by its short id, anything else by what kind of lock it is. The
 * bank's own purpose is an internal reference, so it goes in the title, not in the words.
 */
export function setAsideLabel(what: SetAsideWhat, copy: Copy): string {
  switch (what.kind) {
    case 'order':
      return copy.t('Set aside order', { id: shortId(what.id) });
    case 'withdrawal':
      return copy.t('Set aside withdrawal', { id: shortId(what.id) });
    case 'hold':
      return copy.t('Set aside hold');
    case 'escrow':
      return copy.t('Set aside escrow');
    case 'stake':
      return copy.t('Set aside stake');
    case 'collateral':
      return copy.t('Set aside collateral');
    case 'other':
      return copy.t('Set aside other');
  }
}

/** The full reference behind a line, for its title: an order's or withdrawal's whole id, or the bank's purpose. */
export function setAsideRef(what: SetAsideWhat): string | undefined {
  if (what.kind === 'order' || what.kind === 'withdrawal') return what.id;
  const ref = what.kind === 'other' ? `${what.lock} ${what.purpose}`.trim() : what.purpose;
  return ref === '' ? undefined : ref;
}

/**
 * W-balances-01: every amount of the coin that is set aside, one line per claim as the bank names it (an open order's
 * hold names the order), and the check that available plus set aside is the coin's whole balance.
 */
export function SetAside({ asset, hidden }: { asset: string; hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const splits = useLockSplits(true);
  let body: React.ReactNode;
  if (splits.status === 'loading') {
    body = null;
  } else if (splits.status !== 'ready' && splits.status !== 'empty') {
    body = <p className="money-detail__note">{t('Set aside unavailable')}</p>;
  } else {
    const split = splits.status === 'ready' ? splits.data[asset] : undefined;
    const lines = setAsideLines(split);
    if (lines.length === 0) {
      body = <p className="money-detail__note">{t('Set aside none', { asset })}</p>;
    } else {
      const sum = split?.total === undefined ? null : setAsideSum(split, split.total);
      const figure = (value: string) => (hidden ? '••••' : fmtAmount(value));
      body = (
        <>
          <table className="money-table money-table--activity" data-testid="set-aside">
            <thead>
              <tr>
                <th scope="col">{t('Set aside column what')}</th>
                <th scope="col" className="money-num">
                  {t('Set aside column amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td title={setAsideRef(line.what)}>{setAsideLabel(line.what, copy)}</td>
                  <td className="money-num">
                    <Amount value={`${fmtAmount(line.amount)} ${asset}`} hidden={hidden} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sum && split?.total !== undefined && (
            <p className="money-detail__note" data-testid="set-aside-sum">
              {t(sum.adds ? 'Set aside adds up' : 'Set aside does not add up', {
                available: figure(split.available),
                setAside: figure(sum.setAside),
                total: figure(split.total),
                asset,
              })}
            </p>
          )}
        </>
      );
    }
  }
  return (
    <section data-testid="money-card" className="money-card money-detail__card" aria-label={t('Set aside title')}>
      <h2 className="money-detail__h">{t('Set aside title')}</h2>
      <p className="money-detail__note">{t('Set aside intro')}</p>
      {body}
    </section>
  );
}
