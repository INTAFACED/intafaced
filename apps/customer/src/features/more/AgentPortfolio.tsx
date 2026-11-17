import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { useVenueMode } from '../trade/use-venue-mode';
import { VenueFrame } from '../trade/venue/VenueKit';
import { agentPortfolioCopy } from './agent-portfolio-copy';
import type { OwnAgent } from '@intafaced/contracts/agents-own';

/**
 * An own agent's Portfolio page (RC-agents-03, AG-approvals-01, AG-spend-03; J-agents-18 #1 #2). The person sets target
 * weights and asks the Portfolio planner for a rebalance of the sub-account the agent trades under its allowance; the
 * proposal lists what the venue reports the sub-account holds and each order, and sends nothing. They approve one, and
 * svc-trade places its orders through the agent permission within the allowance, each once; or reject one, and nothing
 * changes. Every figure is svc-trade's or the venue's own; the page works none out.
 */

const iso = z.string().datetime({ offset: true });
const proposalSchema = z.object({
  proposalId: z.string(),
  status: z.enum(['proposed', 'approved', 'rejected']),
  asset: z.string(),
  subAccount: z.string(),
  targets: z.array(z.object({ asset: z.string(), percent: decimalSchema })),
  holdings: z.array(z.object({ asset: z.string(), total: decimalSchema, price: decimalSchema, value: decimalSchema })),
  totalValue: decimalSchema,
  orders: z.array(
    z.object({
      orderId: z.string(),
      symbol: z.string(),
      base: z.string(),
      side: z.enum(['buy', 'sell']),
      size: decimalSchema,
      price: decimalSchema,
      notional: decimalSchema,
    }),
  ),
  createdAt: iso,
  test: z.boolean().optional(),
});
type Proposal = z.infer<typeof proposalSchema>;
const listSchema = z.object({ rebalances: z.array(proposalSchema) });
const orderStateSchema = z.object({ orderId: z.string(), state: z.enum(['accepted', 'refused', 'unknown', 'unsent']) });
const ordersSchema = z.object({ orders: z.array(orderStateSchema) });
const approvedSchema = z.object({ proposal: proposalSchema, orders: z.array(orderStateSchema) });

const KNOWN = new Set([
  'agents.allowance_unset',
  'agents.allowance_not_signed',
  'agents.allowance_revoked',
  'agents.allowance_ended',
  'agents.allowance_exceeded',
  'agents.rebalance_target_unset',
  'agents.rebalance_target_invalid',
  'agents.rebalance_nothing_held',
  'agents.rebalance_nothing_to_do',
  'agents.rebalance_rejected',
  'agents.rebalance_approved',
  'agents.rebalance_allowance_changed',
  'agents.rebalance_exceeds_allowance',
  'agents.order_market_unknown',
  'agents.order_price_unknown',
  'agents.policy_unavailable',
  'agents.policy_denied',
  'agents.policy_no_match',
  'agents.access_account_denied',
  'agents.access_expired',
]);

type Refusal = { code: string | null; message: string };
const refusalOf = (res: Extract<ApiResult<unknown>, { ok: false }>): Refusal => {
  const code = res.code && /^agents\.[a-z_.]+$/.test(res.code) ? res.code : /^agents\.[a-z_.]+$/.test(res.message) ? res.message : null;
  return { code, message: res.message };
};

function Refused({ refusal }: { refusal: Refusal }) {
  const { t } = agentPortfolioCopy.useCopy();
  if (!refusal.code) return <p role="alert">{refusal.message || t('code_other')}</p>;
  return (
    <p role="alert">
      {KNOWN.has(refusal.code) ? t(`code_${refusal.code.replaceAll('.', '_')}` as 'code_other') : t('code_other')}{' '}
      <code lang="zxx">{refusal.code}</code>
    </p>
  );
}

/** "BTC 25, ETH 10" as targets; null when a part is not an asset and a percent. */
function targetsOf(text: string): { asset: string; percent: string }[] | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const out: { asset: string; percent: string }[] = [];
  for (const part of parts) {
    const m = /^([A-Za-z0-9]{2,16})\s+([0-9]+(?:\.[0-9]+)?)\s*%?$/.exec(part);
    if (!m) return null;
    out.push({ asset: m[1]!.toUpperCase(), percent: m[2]! });
  }
  return out;
}

export function PortfolioPage({ agent }: { agent: OwnAgent }) {
  const { t } = agentPortfolioCopy.useCopy();
  const mode = useVenueMode();
  return (
    <Panel title={t('title')} role="region" aria-label={t('title')}>
      <p className="muted">{t('intro')}</p>
      {mode.mode === 'on' ? (
        <VenueFrame mode={mode}>
          <Planner agent={agent} />
        </VenueFrame>
      ) : mode.mode === 'checking' ? (
        <p className="muted">{t('checking')}</p>
      ) : (
        <p className="muted">{t('venueOff')}</p>
      )}
    </Panel>
  );
}

function Planner({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentPortfolioCopy.useCopy();
  const base = `/venue/own-agents/${encodeURIComponent(agent.id)}`;
  const loaded = useResource((signal) => api.rest(`${base}/rebalances`, listSchema, { signal }), `own-rebalances:${agent.id}`);
  const orders = useResource((signal) => api.rest(`${base}/orders`, ordersSchema, { signal }), `own-orders:${agent.id}`);
  const [text, setText] = useState('');
  // The proposal's id is chosen once per ask: the same ask sent again is the same proposal, never a second one.
  const [proposalId, setProposalId] = useState(() => crypto.randomUUID());
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<Proposal[] | null>(null);
  const shown = local ?? (loaded.resource.status === 'ready' ? loaded.resource.data.rebalances : null);
  const states = new Map((orders.resource.status === 'ready' ? orders.resource.data.orders : []).map((o) => [o.orderId, o.state]));

  const replace = (p: Proposal) =>
    setLocal((current) => {
      const list = current ?? (loaded.resource.status === 'ready' ? loaded.resource.data.rebalances : []);
      const rest = list.filter((x) => x.proposalId !== p.proposalId);
      return list.some((x) => x.proposalId === p.proposalId) ? list.map((x) => (x.proposalId === p.proposalId ? p : x)) : [p, ...rest];
    });

  async function propose() {
    setRefused(null);
    setSaid(null);
    const targets = targetsOf(text);
    if (targets === null) return setRefused({ code: null, message: t('targetsUnread') });
    setBusy(true);
    try {
      const res = await api.rest(`${base}/rebalances`, proposalSchema, { method: 'POST', body: { proposalId, targets } });
      if (!res.ok) return setRefused(refusalOf(res));
      replace(res.data);
      setProposalId(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }

  async function decide(p: Proposal, how: 'approve' | 'reject') {
    setRefused(null);
    setSaid(null);
    setBusy(true);
    try {
      if (how === 'approve') {
        const res = await api.rest(`${base}/rebalances/${p.proposalId}/approve`, approvedSchema, { method: 'POST', body: {} });
        orders.reload();
        if (!res.ok) return setRefused(refusalOf(res));
        replace(res.data.proposal);
        setSaid(t('approved'));
      } else {
        const res = await api.rest(`${base}/rebalances/${p.proposalId}/reject`, proposalSchema, { method: 'POST', body: {} });
        if (!res.ok) return setRefused(refusalOf(res));
        replace(res.data);
        setSaid(t('rejected'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        aria-label={t('formTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void propose();
        }}
      >
        <Field
          label={t('targets')}
          hint={t('targetsHint')}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={busy}>
          {t('ask')}
        </Button>
      </form>
      {refused ? <Refused refusal={refused} /> : null}
      {said ? <p role="status">{said}</p> : null}
      <section role="region" aria-label={t('proposals')}>
        <h3>{t('proposals')}</h3>
        {shown && shown.length === 0 ? <p className="muted">{t('none')}</p> : null}
        {(shown ?? []).map((p) => (
          <article key={p.proposalId} aria-label={`${t('proposal')} ${p.proposalId}`} data-proposal-id={p.proposalId}>
            <h4>
              {t('proposal')} {p.test ? 'TEST' : ''}
            </h4>
            <p data-testid="proposal-status">{t(`status_${p.status}`)}</p>
            <DataTable label={t('holdings')} headers={[t('colAsset'), t('colHeld'), t('colPrice'), t('colValue'), t('colTarget')]}>
              {p.holdings.map((h) => {
                const target = p.targets.find((x) => x.asset === h.asset);
                return (
                  <tr key={h.asset}>
                    <td>{h.asset}</td>
                    <td className="numeric">{h.total}</td>
                    <td className="numeric">
                      {h.price} {p.asset}
                    </td>
                    <td className="numeric">
                      {h.value} {p.asset}
                    </td>
                    <td className="numeric">{target ? `${target.percent}%` : t('rest')}</td>
                  </tr>
                );
              })}
            </DataTable>
            <p className="muted numeric" data-testid="proposal-total">
              {t('total', { value: p.totalValue, asset: p.asset })}
            </p>
            <DataTable
              label={t('orders')}
              headers={[t('colSide'), t('colMarket'), t('colSize'), t('colWorst'), t('colCommits'), t('colState')]}
            >
              {p.orders.map((o) => (
                <tr key={o.orderId} data-order-id={o.orderId}>
                  <td>{t(`side_${o.side}`)}</td>
                  <td>{o.symbol}</td>
                  <td className="numeric">{o.size}</td>
                  <td className="numeric">
                    {o.price} {p.asset}
                  </td>
                  <td className="numeric">
                    {o.notional} {p.asset}
                  </td>
                  <td data-testid="proposal-order-state">{t(`state_${states.get(o.orderId) ?? 'none'}`)}</td>
                </tr>
              ))}
            </DataTable>
            {p.status === 'proposed' ? (
              <p>
                <Button type="button" disabled={busy} onClick={() => void decide(p, 'approve')}>
                  {t('approve')}
                </Button>{' '}
                <Button type="button" disabled={busy} onClick={() => void decide(p, 'reject')}>
                  {t('reject')}
                </Button>
              </p>
            ) : null}
          </article>
        ))}
      </section>
    </>
  );
}
