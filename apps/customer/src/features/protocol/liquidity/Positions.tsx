import { useMemo, useState, type ReactNode } from 'react';
import type { LiquidityPosition } from '@intafaced/contracts/protocol-liquidity';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { ServiceOffNotice } from '../../../shared/service-off';
import { Button, DataTable, Dialog, EmptyState, Field, Loading, Panel } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { networkLabel } from '../blockers';
import { WatchShell } from '../watch/AddressPage';
import { APP_CHAIN_ID, ADDRESS } from '../wallet/eip1193';
import { useWallet } from '../wallet/WalletProvider';
import { liquidityCopy, type LiquidityTranslate } from './copy';
import { amountText, bpsPercent, toUnits } from './format';
import { createLiquidityApi, refusalCode } from './liquidity-api';
import { NoWalletNote, useLiquiditySigning } from './signing';

const SHARE_DECIMALS = 18;
const NO_NETWORK = new Set(['protocol.amm_factory_unset', 'protocol.chain_unreachable', 'protocol.liquidity_router_unset']);

/** A position's id in its path: `<pool>:<account>`, both addresses. */
export const positionPath = (pool: string, account: string) => `/dex/positions/${pool.toLowerCase()}:${account.toLowerCase()}`;
export function parsePositionId(id: string): { pool: string; account: string } | null {
  const [pool, account, ...rest] = id.split(':');
  return rest.length === 0 && pool && account && ADDRESS.test(pool) && ADDRESS.test(account) ? { pool, account } : null;
}

/**
 * /dex/positions (D-liquidity-01): every factory pool the connected wallet holds shares in, read from the pools at one
 * block. A position is the wallet's own shares in a pool; nothing is kept for it anywhere else.
 */
export function PositionsList() {
  const { language } = usePreferences();
  const { t } = liquidityCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createLiquidityApi(transport), [transport]);
  const account = wallet.address;
  const positions = useResource(
    (signal) => (account ? api.positions(account, signal) : Promise.resolve({ ok: true as const, data: null })),
    `liquidity:positions:${account ?? 'none'}`,
  );
  const network = networkLabel(APP_CHAIN_ID).name;
  const headers = [t('hdrPool'), t('hdrShares'), t('hdrShare')];
  const { resource } = positions;
  let body: ReactNode;
  const note = (content: ReactNode) => (
    <tr>
      <td colSpan={headers.length}>{content}</td>
    </tr>
  );
  if (!account) body = note(<EmptyState title={t('positionsEmpty', { network })} />);
  else if (resource.status === 'loading') body = note(<Loading label={t('positionsTitle')} />);
  else if (resource.status === 'failed')
    body = note(
      NO_NETWORK.has(refusalCode(resource.failure) ?? '') ? (
        <ServiceOffNotice code="rail.crypto" action={t('positionsTitle')} role="status" />
      ) : (
        <p role="status">{t('positionsUnread', { reason: resource.failure.message })}</p>
      ),
    );
  else if (!resource.data || resource.data.positions.length === 0) body = note(<EmptyState title={t('positionsEmpty', { network })} />);
  else
    body = resource.data.positions.map((p) => (
      <tr key={p.pool}>
        <th scope="row">
          <a href={positionPath(p.pool, account)}>
            {t('positionName', { token0: p.token0.name, token1: p.token1.name, fee: bpsPercent(p.feeBps) })}
          </a>
        </th>
        <td className="numeric">{amountText(p.shares, SHARE_DECIMALS, SHARE_DECIMALS)}</td>
        <td className="numeric">{`${bpsPercent(Number((BigInt(p.shares) * 10_000n) / BigInt(p.totalSupply || '1')))}%`}</td>
      </tr>
    ));
  return (
    <WatchShell title={t('positionsTitle')} description={t('network', { network })}>
      <Panel title={t('positionsTitle')}>
        {!account && <NoWalletNote t={t} />}
        <DataTable label={t('positionsTitle')} headers={headers}>
          {body}
        </DataTable>
      </Panel>
      <Button variant="secondary" onClick={() => navigate('/dex/pools')}>
        {t('backToPools')}
      </Button>
    </WatchShell>
  );
}

const tokenPair = (p: LiquidityPosition, a0: string, a1: string, t: LiquidityTranslate) =>
  t('pair', {
    amount0: amountText(a0, p.token0.decimals),
    symbol0: p.token0.name,
    amount1: amountText(a1, p.token1.decimals),
    symbol1: p.token1.name,
  });

/**
 * /dex/positions/:positionId (D-liquidity-01, -02, -04, J-dex-protocol-12 #5, #6, #8): one wallet's shares in one pool,
 * its share of the pool, what the shares are worth now and the fees earned; the impermanent-loss card (held against in
 * the pool, with the difference), or "Entry unknown" for shares that came from another wallet; and, for the connected
 * wallet's own position, Send shares, Collect fees (fees compound, so it says so) and Remove all.
 */
export function PositionPage({ id }: { id: string }) {
  const { language } = usePreferences();
  const { t } = liquidityCopy.forLocale(language);
  const signing = useLiquiditySigning(t);
  const { wallet, liquidity } = signing;
  const parsed = parsePositionId(id);
  const [revision, setRevision] = useState(0);
  const position = useResource(
    (signal) => (parsed ? liquidity.position(parsed.pool, parsed.account, signal) : Promise.resolve({ ok: true as const, data: null })),
    `liquidity:position:${id}:${revision}`,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const network = networkLabel(APP_CHAIN_ID).name;
  const { resource } = position;
  const p = resource.status === 'ready' ? resource.data : null;
  const mine = !!p && !!wallet.address && wallet.address.toLowerCase() === p.account.toLowerCase();

  const collect = async () => {
    if (!p) return;
    setProblem(null);
    const answer = await liquidity.claimFees(p.pool);
    // A compounding pool has nothing separate to collect: the service refuses by name and the room says why.
    if (!answer.ok && refusalCode(answer) === 'protocol.fees_compound') setStatus(t('feesCompounded'));
    else setProblem(answer.ok ? t('feesCompounded') : t('refused', { reason: answer.message }));
  };

  const removeAll = async () => {
    if (!p || !wallet.address) return;
    setProblem(null);
    setStatus(null);
    setBusy(true);
    try {
      const gate = await signing.withRepresentation(async () => {
        const built = await liquidity.buildRemove({ owner: wallet.address!, pool: p.pool, shares: p.shares });
        if (!built.ok) return setProblem(t('refused', { reason: built.message.replace(/^[a-z_]+\.[a-z_.]+: /, '') }));
        const shown = amountText(p.shares, SHARE_DECIMALS, SHARE_DECIMALS);
        const approve = await signing.approvals({ address: p.pool, name: 'LP' }, built.data.router, BigInt(p.shares), shown);
        if (!approve.ok) return setProblem(approve.reason);
        const steps = approve.steps.map((step) => ({ ...step, label: t('stepApproveShares', { shares: shown }) }));
        const outcome = await signing.send(
          {
            title: t('stepsRemove'),
            steps: [
              ...steps,
              {
                label: t('stepRemove', {
                  shares: shown,
                  amount0: amountText(built.data.amount0Min, p.token0.decimals),
                  symbol0: p.token0.name,
                  amount1: amountText(built.data.amount1Min, p.token1.decimals),
                  symbol1: p.token1.name,
                }),
                request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data },
              },
            ],
          },
          built.data.call,
        );
        if (!outcome.ok) return setProblem(outcome.reason);
        setStatus(
          t('removed', {
            amount0: amountText(built.data.amount0, p.token0.decimals),
            symbol0: p.token0.name,
            amount1: amountText(built.data.amount1, p.token1.decimals),
            symbol1: p.token1.name,
          }),
        );
        setRevision((n) => n + 1);
      });
      if (gate) setProblem(gate);
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (!parsed) body = <p role="status">{t('positionUnread', { reason: id })}</p>;
  else if (resource.status === 'loading') body = <Loading label={t('positionTitle')} />;
  else if (resource.status === 'failed')
    body = NO_NETWORK.has(refusalCode(resource.failure) ?? '') ? (
      <ServiceOffNotice code="rail.crypto" action={t('positionTitle')} role="status" />
    ) : (
      <p role="status">{t('positionUnread', { reason: resource.failure.message })}</p>
    );
  else if (p) {
    const il = p.impermanentLoss;
    body = (
      <>
        {BigInt(p.shares) === 0n && <p role="status">{t('noShares')}</p>}
        <dl className="protocol-facts">
          <div>
            <dt>{t('lpShares')}</dt>
            <dd className="numeric" data-testid="lp-shares">
              {amountText(p.shares, SHARE_DECIMALS, SHARE_DECIMALS)}
            </dd>
          </div>
          <div>
            <dt>{t('shareOfPool')}</dt>
            <dd className="numeric">{`${bpsPercent(p.shareOfPoolBps)}%`}</dd>
          </div>
          <div>
            <dt>{t('worthNow')}</dt>
            <dd className="numeric">{tokenPair(p, p.amount0, p.amount1, t)}</dd>
          </div>
          <div>
            <dt>{t('feesEarned')}</dt>
            <dd className="numeric" data-testid="fees-earned">
              {p.feesEarned ? tokenPair(p, p.feesEarned.amount0, p.feesEarned.amount1, t) : t('entryUnknown')}
            </dd>
          </div>
        </dl>
        <p className="muted">{p.feesEarned ? `${t('feesEstimate')} ${t('feesNote')}` : t('feesNote')}</p>
        <section aria-label={t('ilTitle')} className="protocol-quote">
          <h3>{t('ilTitle')}</h3>
          <p className="muted">{t('ilFormula')}</p>
          {il ? (
            <>
              <dl className="protocol-facts">
                <div>
                  <dt>{t('ifHeld')}</dt>
                  <dd className="numeric" data-testid="il-held">
                    {tokenPair(p, il.held0, il.held1, t)}
                  </dd>
                </div>
                <div>
                  <dt>{t('inPool')}</dt>
                  <dd className="numeric" data-testid="il-now">
                    {tokenPair(p, il.now0, il.now1, t)}
                  </dd>
                </div>
                <div>
                  <dt>{t('difference')}</dt>
                  <dd className="numeric" data-testid="il-diff">
                    {tokenPair(p, il.diff0, il.diff1, t)}
                  </dd>
                </div>
              </dl>
              <p className="numeric" data-testid="il-value">
                {t('valued', {
                  symbol: p.token1.name,
                  held: amountText(il.valueHeld1, p.token1.decimals),
                  now: amountText(il.valueNow1, p.token1.decimals),
                  diff: bpsPercent(il.diffBps),
                })}
              </p>
              <p className="numeric" data-testid="il-closed-form">
                {t('closedForm', { percent: bpsPercent(il.closedFormBps) })}
              </p>
            </>
          ) : (
            <p role="status">
              <strong>{t('entryUnknown')}</strong> {t('entryUnknownNote')}
            </p>
          )}
        </section>
        <p className="muted">{t('readAt', { block: p.blockNumber })}</p>
        {mine && BigInt(p.shares) > 0n && (
          <div className="protocol-actions">
            <Button variant="secondary" onClick={() => setSending(true)}>
              {t('sendShares')}
            </Button>
            <Button variant="secondary" onClick={() => void collect()}>
              {t('collectFees')}
            </Button>
            <Button disabled={busy} onClick={() => void removeAll()}>
              {t('removeAll')}
            </Button>
          </div>
        )}
        {status && <p role="status">{status}</p>}
        {problem && <p role="alert">{problem}</p>}
        {signing.gateProblem && <p role="alert">{signing.gateProblem}</p>}
      </>
    );
  }
  const title = p ? t('positionName', { token0: p.token0.name, token1: p.token1.name, fee: bpsPercent(p.feeBps) }) : t('positionTitle');
  return (
    <WatchShell title={title} description={t('network', { network })}>
      {signing.panel}
      <Panel title={t('positionTitle')} aria-label={t('positionTitle')}>
        {!wallet.address && <NoWalletNote t={t} />}
        {body}
      </Panel>
      {sending && p && (
        <SendShares
          position={p}
          t={t}
          signing={signing}
          onClose={() => setSending(false)}
          onSent={(words) => {
            setSending(false);
            setStatus(words);
            setRevision((n) => n + 1);
          }}
        />
      )}
      <Button variant="secondary" onClick={() => navigate('/dex/positions')}>
        {t('backToPositions')}
      </Button>
    </WatchShell>
  );
}

function SendShares({
  position,
  t,
  signing,
  onClose,
  onSent,
}: {
  position: LiquidityPosition;
  t: LiquidityTranslate;
  signing: ReturnType<typeof useLiquiditySigning>;
  onClose: () => void;
  onSent: (words: string) => void;
}) {
  const [to, setTo] = useState('');
  const [shares, setShares] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const units = toUnits(shares, SHARE_DECIMALS);
  const valid = ADDRESS.test(to.trim()) && units !== null && units <= BigInt(position.shares);
  const send = async () => {
    if (!valid || units === null || !signing.wallet.address) return setProblem(t('sendInvalid'));
    setProblem(null);
    setBusy(true);
    try {
      const gate = await signing.withRepresentation(async () => {
        const built = await signing.liquidity.buildSend({
          owner: signing.wallet.address!,
          pool: position.pool,
          to: to.trim(),
          shares: units.toString(),
        });
        if (!built.ok) return setProblem(t('refused', { reason: built.message.replace(/^[a-z_]+\.[a-z_.]+: /, '') }));
        const shown = amountText(units, SHARE_DECIMALS, SHARE_DECIMALS);
        const outcome = await signing.send(
          {
            title: t('stepsSend'),
            steps: [
              {
                label: t('stepSend', { shares: shown, to: to.trim() }),
                request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data },
              },
            ],
          },
          built.data.call,
        );
        if (outcome.ok) onSent(t('sent', { shares: shown, to: to.trim() }));
        else setProblem(outcome.reason);
      });
      if (gate) setProblem(gate);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('sendShares')} onClose={onClose}>
      <form
        className="protocol-quote"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Field label={t('sendTo')} value={to} onChange={(event) => setTo(event.target.value)} />
        <Field label={t('sendAmount')} inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} />
        <Button type="submit" disabled={busy || !valid}>
          {t('send')}
        </Button>
        {problem && <p role="alert">{problem}</p>}
      </form>
    </Dialog>
  );
}
