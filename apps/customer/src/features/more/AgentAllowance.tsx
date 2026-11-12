import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { useVenueMode } from '../trade/use-venue-mode';
import { preparedAnswerSchema, venueOrderSchema, walletTypedData } from '../trade/venue-api';
import { VenueFrame, WalletBar, useOwner } from '../trade/venue/VenueKit';
import { useWallet } from '../protocol/wallet/WalletProvider';
import { Select } from './common';
import { agentAllowanceCopy } from './agent-allowance-copy';
import { ownAgentAccessSchema, ownAgentOrderDraftSchema, type OwnAgent, type OwnAgentOrderDraft } from '@intafaced/contracts/agents-own';

/**
 * An own agent's Allowance page (AG-spend-03, RC-agents-06; J-agents-08 #3 to #7). The person gives the agent an
 * allowance on the one sub-account they gave it access to, and their wallet signs the venue's agent permission for it;
 * they ask the agent for an order in their own words, see the venue's preview, and approve it; they revoke it, and the
 * wallet signs the venue's revoke. Every decision shown is a service's own (svc-trade's allowance and the venue's record,
 * svc-agents' draft and rules); the page never works one out, and nothing is sent until the person approves.
 */

const iso = z.string().datetime({ offset: true });
const nextSchema = z.object({
  actionKey: z.string(),
  step: z.enum(['approve_agent', 'revoke_agent']),
  prepared: preparedAnswerSchema.shape.prepared,
  signed: z.boolean(),
});
const allowanceSchema = z.object({
  allowanceId: z.string(),
  status: z.enum(['signing', 'active', 'ended', 'revoked', 'abandoned']),
  subAccount: z.string(),
  asset: z.string(),
  amount: decimalSchema,
  left: decimalSchema,
  period: z.enum(['day', 'week', 'month']),
  endsAt: iso,
  agentAddress: z.string(),
  permissionOnVenue: z.boolean(),
  next: nextSchema.nullable(),
  test: z.boolean(),
});
type Allowance = z.infer<typeof allowanceSchema>;
const allowancesSchema = z.object({ allowances: z.array(allowanceSchema) });
const previewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit']),
  size: decimalSchema,
  price: decimalSchema,
  notional: decimalSchema,
  asset: z.string(),
  fee: z.object({ asset: z.string(), amount: decimalSchema }).nullable(),
  left: decimalSchema,
  test: z.boolean(),
});
type Preview = z.infer<typeof previewSchema>;
const orderSchema = z.object({
  orderId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  size: decimalSchema,
  price: decimalSchema,
  signedBy: z.string(),
  subAccount: z.string(),
  state: z.enum(['accepted', 'refused', 'unknown', 'unsent']),
  order: venueOrderSchema.nullable(),
});
const ordersSchema = z.object({ orders: z.array(orderSchema) });

const KNOWN = new Set([
  'agents.allowance_amount_unset',
  'agents.allowance_amount_invalid',
  'agents.allowance_period_unset',
  'agents.allowance_live',
  'agents.allowance_unset',
  'agents.allowance_not_signed',
  'agents.allowance_ended',
  'agents.allowance_revoked',
  'agents.allowance_exceeded',
  'agents.allowance_sub_account_unknown',
  'agents.policy_unavailable',
  'agents.policy_denied',
  'agents.policy_no_match',
  'agents.access_account_denied',
  'agents.access_expired',
  'agents.order_not_understood',
  'agents.account_cap_above_ceiling',
]);

type Refusal = { code: string | null; message: string };
const refusalOf = (res: Extract<ApiResult<unknown>, { ok: false }>): Refusal => {
  const code = res.code && /^agents\.[a-z_.]+$/.test(res.code) ? res.code : /^agents\.[a-z_.]+$/.test(res.message) ? res.message : null;
  return { code, message: res.message };
};

function Refused({ refusal }: { refusal: Refusal }) {
  const { t } = agentAllowanceCopy.useCopy();
  if (!refusal.code) return <p role="alert">{refusal.message || t('code_other')}</p>;
  return (
    <p role="alert">
      {KNOWN.has(refusal.code) ? t(`code_${refusal.code.replaceAll('.', '_')}` as 'code_other') : t('code_other')}{' '}
      <code lang="zxx">{refusal.code}</code>
    </p>
  );
}

export function AllowancePage({ agent }: { agent: OwnAgent }) {
  const { t } = agentAllowanceCopy.useCopy();
  const mode = useVenueMode();
  return (
    <Panel title={t('title')} role="region" aria-label={t('title')}>
      <p className="muted">{t('intro')}</p>
      {mode.mode === 'on' ? (
        <VenueFrame mode={mode}>
          <AllowanceDesk agent={agent} />
        </VenueFrame>
      ) : mode.mode === 'checking' ? (
        <p className="muted">{t('checking')}</p>
      ) : (
        <p className="muted">{t('venueOff')}</p>
      )}
    </Panel>
  );
}

function AllowanceDesk({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentAllowanceCopy.useCopy();
  const wallet = useWallet();
  const owner = useOwner();
  const base = `/venue/own-agents/${encodeURIComponent(agent.id)}`;
  const access = useResource(
    (signal) => api.query('agents', 'own.access.get', { id: agent.id }, ownAgentAccessSchema, { signal }),
    `own-access:${agent.id}`,
  );
  const loaded = useResource((signal) => api.rest(`${base}/allowances`, allowancesSchema, { signal }), `own-allowances:${agent.id}`);
  const [allowances, setAllowances] = useState<Allowance[] | null>(null);
  const shown = allowances ?? (loaded.resource.status === 'ready' ? loaded.resource.data.allowances : null);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week');
  const [grantId, setGrantId] = useState(() => crypto.randomUUID());
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const grants = access.resource.status === 'ready' ? access.resource.data.grants : null;
  // The allowance is on the sub-account the person gave the agent access to (J-agents-08 #2).
  const granted = grants?.find((g) => owner && g.owner.toLowerCase() === owner) ?? null;

  const replace = (a: Allowance) =>
    setAllowances((current) => {
      const list = current ?? (loaded.resource.status === 'ready' ? loaded.resource.data.allowances : []);
      return [a, ...list.filter((x) => x.allowanceId !== a.allowanceId)];
    });

  /** The wallet signs what the allowance asks next, and the signature is sent once; a rejection grants or revokes nothing. */
  async function signNext(a: Allowance): Promise<void> {
    let current = a;
    for (let i = 0; current.next && i < 3 && owner; i += 1) {
      const p = current.next.prepared;
      const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
      if (signed.status !== 'signed') {
        if (current.next.step === 'approve_agent') {
          const gone = await api.rest(`${base}/allowances/${current.allowanceId}/abandon`, allowanceSchema, { method: 'POST', body: {} });
          if (gone.ok) replace(gone.data);
        }
        setRefused({ code: null, message: t(signed.status === 'rejected' ? 'walletRejected' : 'walletFailed') });
        return;
      }
      const sent = await api.rest(`${base}/allowances/${current.allowanceId}/submit`, allowanceSchema, {
        method: 'POST',
        body: { actionKey: current.next.actionKey, signature: { digest: p.digest, signature: signed.signature, signedBy: owner } },
      });
      if (!sent.ok) return setRefused(refusalOf(sent));
      current = sent.data;
      replace(current);
    }
  }

  async function grant() {
    if (!owner || !granted) return;
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.rest(`${base}/allowances`, allowanceSchema, {
        method: 'POST',
        body: { allowanceId: grantId, owner, subAccount: granted.subAccount, amount: amount.trim(), period },
      });
      if (!res.ok) return setRefused(refusalOf(res));
      replace(res.data);
      setGrantId(crypto.randomUUID());
      await signNext(res.data);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(a: Allowance) {
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.rest(`${base}/allowances/${a.allowanceId}/revoke`, allowanceSchema, { method: 'POST', body: {} });
      if (!res.ok) return setRefused(refusalOf(res));
      replace(res.data);
      await signNext(res.data);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <WalletBar />
      {!owner ? (
        <p className="muted">{t('connectFirst')}</p>
      ) : grants && !granted ? (
        <p className="muted">{t('noAccess')}</p>
      ) : granted ? (
        <form
          aria-label={t('formTitle')}
          onSubmit={(event) => {
            event.preventDefault();
            void grant();
          }}
        >
          <p className="muted">{t('onSubAccount', { name: granted.name })}</p>
          <Field
            label={t('amount')}
            hint={t('amountHint')}
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Select
            label={t('period')}
            value={period}
            onChange={(value) => setPeriod(value as typeof period)}
            options={(['day', 'week', 'month'] as const).map((value) => ({ value, label: t(`period_${value}`) }))}
          />
          <Button type="submit" disabled={busy}>
            {t('grant')}
          </Button>
          {refused ? <Refused refusal={refused} /> : null}
        </form>
      ) : null}
      {shown && shown.length ? (
        <DataTable label={t('table')} headers={[t('colAmount'), t('colLeft'), t('colEnds'), t('colStatus'), t('colRevoke')]}>
          {shown.map((a) => (
            <tr key={a.allowanceId}>
              <td>
                {a.test ? 'TEST ' : ''}
                {a.amount} {a.asset}
              </td>
              <td data-testid="allowance-left">{t('left', { amount: a.left, asset: a.asset })}</td>
              <td data-testid="allowance-expiry">
                {t('ends')} <time dateTime={a.endsAt}>{new Date(a.endsAt).toLocaleString()}</time>
              </td>
              <td data-testid="allowance-status">
                {t(`status_${a.status}`)}
                {a.status === 'revoked' && a.permissionOnVenue ? ` · ${t('revokeOnVenuePending')}` : ''}
              </td>
              <td>
                {a.status === 'active' || (a.status === 'revoked' && a.next) ? (
                  <Button type="button" disabled={busy} onClick={() => void revoke(a)}>
                    {a.status === 'active' ? t('revoke') : t('signRevoke')}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : shown ? (
        <p className="muted">{t('none')}</p>
      ) : null}
      <AskAgent agent={agent} base={base} />
    </>
  );
}

/** The person asks the agent for an order (#3 #5), sees the venue's preview, and approves it (#6). */
function AskAgent({ agent, base }: { agent: OwnAgent; base: string }) {
  const api = useApi();
  const { t } = agentAllowanceCopy.useCopy();
  const [ask, setAsk] = useState('');
  const [draft, setDraft] = useState<{ order: OwnAgentOrderDraft; preview: Preview; orderId: string } | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orders = useResource((signal) => api.rest(`${base}/orders`, ordersSchema, { signal }), `own-orders:${agent.id}`);
  const body = useMemo(
    () => (order: OwnAgentOrderDraft) => ({
      side: order.side,
      base: order.base,
      size: order.size,
      type: order.type,
      ...(order.price === null ? {} : { price: order.price }),
    }),
    [],
  );

  async function run() {
    setBusy(true);
    setRefused(null);
    setPlaced(null);
    setDraft(null);
    try {
      const drafted = await api.mutate('agents', 'own.trade.draft', { id: agent.id, ask }, ownAgentOrderDraftSchema);
      if (!drafted.ok) return setRefused(refusalOf(drafted));
      const preview = await api.rest(`${base}/orders/preview`, previewSchema, { method: 'POST', body: body(drafted.data) });
      if (!preview.ok) return setRefused(refusalOf(preview));
      // The order's id is chosen once, here: an approval sent again is the same order, never a second one.
      setDraft({ order: drafted.data, preview: preview.data, orderId: crypto.randomUUID() });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!draft) return;
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.rest(`${base}/orders`, orderSchema, { method: 'POST', body: { orderId: draft.orderId, ...body(draft.order) } });
      if (!res.ok) return setRefused(refusalOf(res));
      setPlaced(res.data.state === 'accepted' ? t('placed') : t('placedUnknown'));
      setDraft(null);
      orders.reload();
    } finally {
      setBusy(false);
    }
  }

  const p = draft?.preview;
  const listed = orders.resource.status === 'ready' ? orders.resource.data.orders : [];
  return (
    <section role="region" aria-label={t('askTitle')}>
      <h3>{t('askTitle')}</h3>
      <form
        aria-label={t('askTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Field label={t('ask')} hint={t('askHint')} value={ask} disabled={busy} onChange={(event) => setAsk(event.target.value)} />
        <Button type="submit" disabled={busy || ask.trim() === ''}>
          {t('run')}
        </Button>
      </form>
      {refused ? <Refused refusal={refused} /> : null}
      {placed ? <p role="status">{placed}</p> : null}
      {p ? (
        <section role="region" aria-label={t('previewTitle')}>
          <h4>
            {t('previewTitle')} {p.test ? 'TEST' : ''}
          </h4>
          <dl className="protocol-facts">
            <div>
              <dt>{t('side')}</dt>
              <dd>{t(`side_${p.side}`)}</dd>
            </div>
            <div>
              <dt>{t('market')}</dt>
              <dd>{p.symbol}</dd>
            </div>
            <div>
              <dt>{t('orderType')}</dt>
              <dd>{t(`type_${p.type}`)}</dd>
            </div>
            <div>
              <dt>{t('size')}</dt>
              <dd className="numeric">{p.size}</dd>
            </div>
            <div>
              <dt>{t(p.type === 'market' ? 'worstPrice' : 'price')}</dt>
              <dd className="numeric">
                {p.price} {p.asset}
              </dd>
            </div>
            <div>
              <dt>{t('fee')}</dt>
              <dd className="numeric">{p.fee ? `${p.fee.amount} ${p.fee.asset}` : t('feeUnknown')}</dd>
            </div>
            <div>
              <dt>{t('draws')}</dt>
              <dd className="numeric">{t('drawsOf', { notional: p.notional, left: p.left, asset: p.asset })}</dd>
            </div>
          </dl>
          <p className="muted">{t('nothingSent')}</p>
          <Button type="button" disabled={busy} onClick={() => void approve()}>
            {t('approve')}
          </Button>
        </section>
      ) : null}
      {listed.length ? (
        <DataTable label={t('ordersTable')} headers={[t('market'), t('side'), t('size'), t('price'), t('colState'), t('signedBy')]}>
          {listed.map((o) => (
            <tr key={o.orderId}>
              <td>{o.symbol}</td>
              <td>{t(`side_${o.side}`)}</td>
              <td className="numeric">{o.size}</td>
              <td className="numeric">{o.price}</td>
              <td data-testid="agent-order-state">
                {t(`state_${o.state}`)}
                {o.order ? ` · ${o.order.status}` : ''}
              </td>
              <td className="numeric" data-testid="agent-order-signer">
                {o.signedBy}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : null}
    </section>
  );
}
