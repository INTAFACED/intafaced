import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Panel } from '../../../shared/ui';
import type { OrdersContext } from './OrdersRoom';
import { refusalWords } from './OrdersRoom';

interface VaultView {
  vault: string;
  token: { address: string; symbol: string; decimals: number };
  tokens: { address: string; symbol: string; decimals: number }[];
  credit: string;
  strays: string;
}

/**
 * The order vault (D-limit-dca-01): the person's own credit per token, read from the vault contract. Deposit and
 * withdraw are calls the wallet sends; the service only builds them. Tokens sent straight to the vault are not credited
 * (the contract credits only `deposit`), and the keeper returns them to this wallet only. One status line says the
 * latest of these facts.
 */
export function VaultPanel({ ctx }: { ctx: OrdersContext }) {
  const { api, address, session, t, gated, send, revision, changed } = ctx;
  const [token, setToken] = useState<string | undefined>(undefined);
  const [view, setView] = useState<VaultView | null>(null);
  const [amount, setAmount] = useState('');
  // The latest action's result; with none, whether stray tokens from this wallet are waiting uncredited.
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.vault(address, token).then((r) => {
      if (!live) return;
      if (!r.ok) return setProblem(refusalWords(t, r));
      setView(r.data);
      setProblem(null);
    });
    return () => {
      live = false;
    };
  }, [api, address, token, revision, t]);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    try {
      const failed = await work();
      if (failed) setProblem(failed);
    } finally {
      setBusy(false);
      changed();
    }
  };

  const deposit = (event: FormEvent) => {
    event.preventDefault();
    if (!view) return;
    void run(() =>
      gated(async () => {
        const calls = await api.deposit(address, view.token.address, amount.trim());
        if (!calls.ok) return setProblem(refusalWords(t, calls));
        const failed = await send({
          title: t('vaultDepositSteps'),
          steps: calls.data.calls.map((c) => ({ label: c.label, request: { kind: 'transaction', to: c.to, data: c.data } })),
          facts: [{ label: t('vaultAddress'), value: view.vault }],
        });
        if (failed) return setProblem(failed);
        setStatus(t('vaultDeposited', { amount: amount.trim(), symbol: view.token.symbol }));
        setAmount('');
      }),
    );
  };

  const withdraw = () =>
    void run(() =>
      gated(async () => {
        if (!view) return;
        const built = await api.withdraw(address, view.token.address);
        if (!built.ok) return setProblem(refusalWords(t, built));
        const failed = await send({
          title: t('vaultWithdrawSteps'),
          steps: [{ label: built.data.call.label, request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data } }],
          facts: [{ label: t('vaultAddress'), value: view.vault }],
        });
        if (failed) return setProblem(failed);
        setStatus(t('vaultWithdrawn', { amount: built.data.amount, symbol: built.data.symbol }));
      }),
    );

  const sweep = () =>
    void run(async () => {
      if (!session) return t('needSession');
      const swept = await api.sweep(session.accessToken, view?.token.address);
      if (!swept.ok) return refusalWords(t, swept);
      setStatus(t('vaultSwept', { address: swept.data.to, amount: swept.data.returned, symbol: swept.data.symbol }));
      return null;
    });

  return (
    <Panel title={t('vaultTitle')} aria-label={t('vaultTitle')}>
      <p className="muted">{t('vaultIntro')}</p>
      {view && (
        <>
          <label className="field">
            <span>{t('vaultToken')}</span>
            <select aria-label={t('vaultToken')} value={view.token.address} onChange={(e) => setToken(e.target.value)}>
              {view.tokens.map((tk) => (
                <option key={tk.address} value={tk.address}>
                  {tk.symbol}
                </option>
              ))}
            </select>
          </label>
          <dl className="kv">
            <dt>{t('vaultCredit')}</dt>
            <dd className="numeric" data-testid="vault-credit">{`${view.credit} ${view.token.symbol}`}</dd>
            <dt>{t('vaultAddress')}</dt>
            <dd className="numeric">{view.vault}</dd>
          </dl>
          <form onSubmit={deposit} className="actions">
            <Field
              label={t('vaultDeposit', { symbol: view.token.symbol })}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button type="submit" disabled={busy || amount.trim() === ''}>
              {t('vaultDepositButton')}
            </Button>
          </form>
          <div className="actions">
            <Button variant="secondary" onClick={withdraw} disabled={busy || view.credit === '0'}>
              {t('vaultWithdraw')}
            </Button>
            {view.strays !== '0' && (
              <Button variant="secondary" onClick={sweep} disabled={busy}>
                {t('vaultSweep')}
              </Button>
            )}
          </div>
        </>
      )}
      <p role="status">
        {status ?? (view && view.strays !== '0' ? t('vaultStrays', { amount: view.strays, symbol: view.token.symbol }) : '')}
      </p>
      {problem && <p role="alert">{problem}</p>}
    </Panel>
  );
}
