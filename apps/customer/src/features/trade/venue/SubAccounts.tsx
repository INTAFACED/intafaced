import { useRef, useState } from 'react';
import { Button, DataTable } from '../../../shared/ui';
import { displayAmount } from '../../../shared/money';
import { usePolled } from '../../protocol/wallet/use-polled';
import { canonicalDecimal, draftId, keys, type AsOf, type VenueBalance } from '../venue-api';
import { AsOfLine, OutcomeLine, TestMark, VENUE_POLL_MS, keepsDraft, useVenueApi, type ActionResult, type RunAction } from './VenueKit';
import { venueCopy } from './venue-copy';

/**
 * The person's own sub-accounts on the venue (J-portfolio-04 #2): open one, and move a coin from the main account into
 * one, each signed by the wallet on the main account through the door (user-venue-door.ts, own sub-account). The figures
 * are the venue's own, with its time. INTAFACED holds nothing and the ledger posts nothing; Profit and loss carries each
 * moved lot with its acquired date and cost (svc-tax venue-book.ts).
 */
export function SubAccountsPanel({
  owner,
  balances,
  test,
  run,
  onMoved,
}: {
  owner: string;
  balances: AsOf<VenueBalance[]> | null;
  test: boolean;
  run: RunAction;
  onMoved: () => void;
}) {
  const { t } = venueCopy.useCopy();
  const venue = useVenueApi();
  const subs = usePolled((signal) => venue.subAccounts(owner, signal), `subs:${owner}`, VENUE_POLL_MS);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState('');
  const coins = (balances?.value ?? []).filter((b) => !/^0(\.0*)?$/.test(b.free));
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  // One move's draft id, held until the venue answers definitely, so a double press or a lost answer is the same move.
  const draft = useRef<{ id: string; of: string } | null>(null);
  const counter = useRef(0);

  async function open() {
    setProblem(null);
    if (name.trim() === '') return setProblem(t('Enter name'));
    const subAccountKey = keys.ownSubAccount(owner, name);
    const answer = await run({ kind: 'create_sub_account', name: name.trim(), subAccountKey }, { actionKey: subAccountKey });
    setResult(answer);
    subs.reload();
  }

  async function move() {
    setProblem(null);
    const list = subs.data?.value ?? [];
    const subAccount = chosen || list[0]?.subAccount || '';
    const coin = asset || coins[0]?.asset || '';
    if (!subAccount) return setProblem(t('Choose sub-account'));
    let exact: string;
    try {
      exact = canonicalDecimal(amount);
    } catch {
      return setProblem(t('Enter amount'));
    }
    if (exact === '0' || exact.startsWith('-')) return setProblem(t('Enter amount'));
    const of = `${subAccount}|${coin}|${exact}`;
    if (!draft.current || draft.current.of !== of) draft.current = { id: draftId(Date.now(), (counter.current += 1)), of };
    const moveKey = keys.ownMove(owner, draft.current.id);
    const answer = await run(
      { kind: 'sub_account_transfer', subAccount, direction: 'into_sub_account', asset: coin, amount: exact, moveKey },
      { actionKey: moveKey },
    );
    if (!keepsDraft(answer)) draft.current = null;
    setResult(answer);
    onMoved();
  }

  const list = subs.data?.value ?? [];
  return (
    <section className="dk-panel form-stack" aria-label={t('Sub-accounts')} data-testid="venue-sub-accounts">
      <h2 className="dk-tab-title">
        {t('Sub-accounts')} <TestMark test={test} />
      </h2>
      <p className="muted">{t('Sub-accounts why')}</p>
      {subs.failure ? (
        <p className="failure" role="alert" data-refusal={subs.failure.code}>
          {t('Sub-accounts not offered', { detail: subs.failure.message })}
        </p>
      ) : null}
      {subs.data && list.length === 0 ? <p className="muted">{t('No sub-accounts')}</p> : null}
      {list.map((s) => (
        <SubAccountBalances key={s.subAccount} owner={owner} subAccount={s.subAccount} name={s.name} />
      ))}
      <label className="field">
        <span>{t('Sub-account name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('Sub-account name')} />
      </label>
      <Button variant="secondary" onClick={() => void open()}>
        {t('Open sub-account')}
      </Button>
      {list.length > 0 ? (
        <>
          <label className="field">
            <span>{t('Sub-account')}</span>
            <select value={chosen || list[0]!.subAccount} onChange={(e) => setChosen(e.target.value)} aria-label={t('Sub-account')}>
              {list.map((s) => (
                <option key={s.subAccount} value={s.subAccount}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('Move asset')}</span>
            <select value={asset || coins[0]?.asset || ''} onChange={(e) => setAsset(e.target.value)} aria-label={t('Move asset')}>
              {coins.map((b) => (
                <option key={b.asset} value={b.asset}>
                  {b.asset}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('Move amount')}</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={t('Move amount')} />
          </label>
          <Button onClick={() => void move()}>{t('Move to sub-account')}</Button>
        </>
      ) : null}
      {problem ? (
        <p className="failure" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} />
    </section>
  );
}

function SubAccountBalances({ owner, subAccount, name }: { owner: string; subAccount: string; name: string }) {
  const { t } = venueCopy.useCopy();
  const venue = useVenueApi();
  const read = usePolled((signal) => venue.balances(owner, signal, subAccount), `sb:${owner}:${subAccount}`, VENUE_POLL_MS);
  const rows = read.data?.value ?? [];
  return (
    <div data-testid="venue-sub-account" data-sub-account={subAccount}>
      <h3>{t('Sub-account balances', { name })}</h3>
      {rows.length > 0 ? (
        <DataTable label={t('Sub-account balances', { name })} headers={[t('Asset'), t('Free'), t('Used'), t('Total')]}>
          {rows.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <td>{b.asset}</td>
              <td className="numeric" data-cell="free">
                {displayAmount(b.free)}
              </td>
              <td className="numeric" data-cell="used">
                {displayAmount(b.locked)}
              </td>
              <td className="numeric" data-cell="total">
                {displayAmount(b.total)}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : read.data ? (
        <p className="muted">{t('No balances')}</p>
      ) : null}
      <AsOfLine asOf={read.data?.asOf ?? null} />
    </div>
  );
}
