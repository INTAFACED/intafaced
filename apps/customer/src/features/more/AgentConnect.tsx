// volt-room: /agents/connect
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyCreateOutput, ApiKeyList } from '@intafaced/contracts/api-keys';
import { Button, Checkbox, Field, Select, Tag } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { StepUpConfirm } from '../money';
import { useWallet } from '../protocol';
import { useVenueMode, VoltVenueFrame as VenueFrame, VoltWalletBar as WalletBar } from '../trade';
import { endOfDayUtc } from '../account';
import { EmptyNote, FailureNote, ScrollTable, Section, Waiting } from './volt-parts';
import {
  ASSISTANT_SCOPES,
  WITHDRAW_SCOPE,
  abandonAgentAccount,
  canonical,
  connectAssistant,
  connectStepUp,
  createAgentAccount,
  createAssistantKey,
  createStepUp,
  mcpSetup,
  readAgentAccounts,
  readAgentConnections,
  readAgentTerms,
  readKeys,
  submitAgentAction,
  venueTotal,
  walletTypedData,
  type AgentAccount,
  type AgentConnection,
  type AgentPermission,
  type AgentTerms,
} from './agent-connect-api';
import { agentConnectCopy as copy } from './agent-connect-copy';
import { STEP_KEY, refusalText, type Words } from './agent-connect-shared';
import { AccountControls, Connections } from './AgentAccountControls';

/** `off`: svc-trade's user-venue door is off here, so there are no agent accounts to read or make. */
type Ready =
  { off: true } | { off: false; terms: AgentTerms; accounts: AgentAccount[]; connections: AgentConnection[]; keys: ApiKeyList['keys'] };

async function readRoom(api: ReturnType<typeof useSession>['api'], signal: AbortSignal): Promise<ApiResult<Ready>> {
  const terms = await readAgentTerms(api, signal);
  if (!terms.ok) return terms.code === 'trade.user_venue_off' ? { ok: true, data: { off: true } } : terms;
  const [accounts, connections, keys] = await Promise.all([
    readAgentAccounts(api, signal),
    readAgentConnections(api, signal),
    readKeys(api, signal),
  ]);
  if (!accounts.ok) return accounts;
  if (!connections.ok) return connections;
  if (!keys.ok) return keys;
  return {
    ok: true,
    data: {
      off: false,
      terms: terms.data,
      accounts: accounts.data.accounts,
      connections: connections.data.connections,
      keys: keys.data.keys,
    },
  };
}

const STATUS_KEY: Record<string, 'status_opening' | 'status_open' | 'status_closed' | 'status_abandoned'> = {
  opening: 'status_opening',
  open: 'status_open',
  closed: 'status_closed',
  abandoned: 'status_abandoned',
};
const SCOPE_KEY: Record<string, 'scope_trade_read' | 'scope_trade_write' | 'scope_trade_withdraw'> = {
  'trade:read': 'scope_trade_read',
  'trade:write': 'scope_trade_write',
  [WITHDRAW_SCOPE]: 'scope_trade_withdraw',
};

const stepUpWords = (t: Words, why: 'stepUpWhy' | 'connectStepUpWhy') => ({
  why: t(why),
  code: t('stepUpCode'),
  codeHint: t('stepUpCodeHint'),
  codeShort: t('stepUpCodeShort'),
  noFactor: t('stepUpNoFactor'),
  sendWithout: t('stepUpSendWithout'),
});

/**
 * Connect your assistant (`/agents/connect`, J-agents-21; AG-outside-01, AG-outside-02, AG-outside-04): what the
 * person's own outside assistant can and cannot do, their agent accounts with Create agent account and each open
 * account's own controls (AgentAccountControls.tsx), and the connection: an API key tagged Agent with trade scopes, bound
 * to one agent account after step-up, its secret and MCP setup shown once, then its Activity and Revoke.
 * Every refusal is the service's own; nothing is checked only in the browser. INTAFACED holds and moves nothing.
 */
export function AgentConnect() {
  // The person's wallet signs every venue action here, so the room sits in the venue's wallet frame (its signing
  // network); with the door off or still being read there is no venue to sign for, and the room says so as before.
  const mode = useVenueMode();
  return mode.mode === 'on' ? (
    <VenueFrame mode={mode}>
      <AgentConnectRoom />
    </VenueFrame>
  ) : (
    <AgentConnectRoom />
  );
}

function AgentConnectRoom() {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readRoom(api, signal), `agent-connect:${userId}`);
  // A read again after a create or a connect keeps the last read on screen, so the room's own messages stay.
  const last = useRef<Ready | null>(null);
  if (resource.status === 'ready') last.current = resource.data;
  const data = resource.status === 'ready' ? resource.data : resource.status === 'loading' ? last.current : null;

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack" data-testid="agent-connect">
          <a className="lt-link" href="/agents">
            {t('back')}
          </a>
          <CanCannot terms={data && !data.off ? data.terms : null} />
          {resource.status === 'loading' && !data && <Waiting label={t('loading')} />}
          {resource.status === 'failed' && <FailureNote result={resource.failure} retry={reload} />}
          {data?.off && (
            <Section className="lt-stack" title={t('accountsTitle')} data-testid="agent-connect__accounts">
              <p className="lt-muted" role="status">
                {t('doorOff')}
              </p>
              <Button tone="primary" disabled>
                {t('create')}
              </Button>
            </Section>
          )}
          {data && !data.off && <Room data={data} reload={reload} />}
        </div>
      }
    />
  );
}

function CanCannot({ terms }: { terms: AgentTerms | null }) {
  const { t } = copy.useCopy();
  return (
    <Section className="lt-stack" title={t('canTitle')} data-testid="agent-connect__can">
      <ul>
        <li>{t('can1')}</li>
        <li>{t('can2')}</li>
      </ul>
      <section data-testid="agent-connect__cannot" aria-labelledby="agent-connect-cannot">
        <h3 id="agent-connect-cannot">{t('cannotTitle')}</h3>
        <ul>
          <li>{t('cannot1')}</li>
          <li>{t('cannot2')}</li>
          <li>{t('cannot3')}</li>
          <li>{t('cannot4')}</li>
          <li>{t('cannot5')}</li>
        </ul>
      </section>
      <p className="lt-muted">{t('mostLoss')}</p>
      {terms && (
        <p className="lt-muted" data-testid="agent-connect__ceiling">
          {terms.ceiling !== null && terms.asset !== null
            ? t('ceiling', { ceiling: terms.ceiling, asset: terms.asset })
            : t('ceilingUnset')}
        </p>
      )}
    </Section>
  );
}

function Room({ data, reload }: { data: Extract<Ready, { off: false }>; reload: () => void }) {
  const { t } = copy.useCopy();
  const open = data.accounts.filter((a) => a.status === 'open');
  return (
    <>
      <Section className="lt-stack" title={t('accountsTitle')} data-testid="agent-connect__accounts">
        {data.accounts.length === 0 ? (
          <EmptyNote title={t('accountsEmpty')} />
        ) : (
          <ScrollTable label={t('accountsTitle')} headers={[t('colAccount'), t('colStatus'), t('colBalance'), t('colCap'), t('colLimits')]}>
            {data.accounts.map((a) => {
              const total = venueTotal(a);
              return (
                <tr key={a.accountId} data-account={a.accountId}>
                  <td>
                    <bdi lang="und">{a.name}</bdi> {a.test ? <Tag tone="neutral">{t('testLabel')}</Tag> : null}
                  </td>
                  <td data-testid="agent-connect__status">{STATUS_KEY[a.status] ? t(STATUS_KEY[a.status]!) : a.status}</td>
                  <td data-testid="agent-connect__balance">{total === null ? t('notOpened') : `${total} ${a.asset}`}</td>
                  <td data-testid="agent-connect__cap">{`${a.cap} ${a.asset}`}</td>
                  <td data-testid="agent-connect__limits">
                    <AccountLimits account={a} />
                  </td>
                </tr>
              );
            })}
          </ScrollTable>
        )}
        {open.map((a) => (
          <AccountControls key={a.accountId} account={a} reload={reload} />
        ))}
        <CreateAccount terms={data.terms} reload={reload} />
      </Section>
      <ConnectAssistant open={open} keys={data.keys} reload={reload} />
      <Connections connections={data.connections} keys={data.keys} accounts={data.accounts} reload={reload} />
    </>
  );
}

/** The person's own three caps on the assistant's orders, beside the funding cap (J-agents-21 #16); one not set says so. */
function AccountLimits({ account }: { account: AgentAccount }) {
  const { t } = copy.useCopy();
  const limits = account.limits;
  const amount = (value: string | null | undefined) => (value ? `${value} ${account.asset}` : t('limitNotSet'));
  return (
    <ul>
      <li>{t('limitOrder', { value: amount(limits?.maxOrderNotional) })}</li>
      <li>{t('limitLeverage', { value: limits?.maxLeverage ? t('times', { times: limits.maxLeverage }) : t('limitNotSet') })}</li>
      <li>{t('limitDailyLoss', { value: amount(limits?.maxDailyLoss) })}</li>
    </ul>
  );
}

type CreateAsk = { accountId: string; owner: string; asset: string; cap: string; fund: string };

/**
 * Create agent account: a cap and a first move, step-up for exactly those, then the person's wallet signs each venue
 * action svc-trade prepares (open the sub-account, the agent permission, the move in), each sent once under its key.
 * A rejected signature while it opens ends it: nothing moved and no account made. The account's id is made once per
 * ask and kept for its retries, so a retry is the same account and never a second one.
 */
function CreateAccount({ terms, reload }: { terms: AgentTerms; reload: () => void }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const wallet = useWallet();
  const [formOpen, setFormOpen] = useState(false);
  const [ask, setAsk] = useState<CreateAsk | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const asset = terms.asset ?? '';
  const owner = wallet.status === 'connected' && wallet.address ? wallet.address.toLowerCase() : null;

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!owner) return setMessage({ text: t('walletNeeded'), failed: true });
    const form = new FormData(event.currentTarget);
    const cap = canonical(String(form.get('cap') ?? ''));
    const fund = canonical(String(form.get('fund') ?? ''));
    if (!cap || !fund) return setMessage({ text: t('amountBad'), failed: true });
    setAsk({ accountId: crypto.randomUUID(), owner, asset, cap, fund });
  }

  async function signAll(view: AgentAccount): Promise<void> {
    for (let i = 0; view.next && i < 6; i += 1) {
      const next = view.next;
      if (!alive.current) return;
      setBusy(t('signing', { step: STEP_KEY[next.step] ? t(STEP_KEY[next.step]!) : next.step }));
      const typedData = walletTypedData(next.prepared.typedData);
      if (!typedData) return setMessage({ text: t('payloadUnreadable'), failed: true });
      const signed = await wallet.sign({ kind: 'typedData', typedData });
      if (signed.status !== 'signed') {
        if (signed.status === 'rejected' && view.status === 'opening') {
          const ended = await abandonAgentAccount(api, view.accountId);
          // Nothing was signed, so nothing moved either way; only an ended account is "no account made".
          if (!ended.ok) return setMessage({ text: t('rejectedNotEnded', { message: refusalText(t, ended) }), failed: true });
          return setMessage({ text: t('rejected'), failed: true });
        }
        const reason = signed.status === 'failed' ? signed.message : signed.status;
        return setMessage({ text: t('walletFailed', { reason }), failed: true });
      }
      const sent = await submitAgentAction(api, view.accountId, next.actionKey, {
        digest: next.prepared.digest,
        signature: signed.signature,
        signedBy: view.owner,
      });
      if (!sent.ok) return setMessage({ text: refusalText(t, sent), failed: true });
      view = sent.data;
    }
    // Created means open with nothing left to sign: anything else says what the venue still waits on.
    if (view.next || view.status !== 'open') return setMessage({ text: t('notFinished'), failed: true });
    const total = venueTotal(view) ?? '0';
    setMessage({ text: t('created', { balance: total, cap: view.cap, asset: view.asset }), failed: false });
  }

  async function confirmed(stepUpApprovalId: string | null) {
    if (!ask || busy) return;
    setBusy(t('connecting'));
    setMessage(null);
    try {
      const made = await createAgentAccount(api, ask, stepUpApprovalId);
      if (!made.ok) {
        setMessage({ text: refusalText(t, made), failed: true });
        // A definite refusal ends this ask; one whose answer was lost keeps its id, so the retry is the same account.
        if (made.reason !== 'uncertain') setAsk(null);
        return;
      }
      setAsk(null);
      setFormOpen(false);
      await signAll(made.data);
    } finally {
      if (alive.current) {
        setBusy(null);
        reload();
      }
    }
  }

  return (
    <section className="lt-stack" data-testid="agent-connect__create" aria-labelledby="agent-connect-create">
      <h3 id="agent-connect-create">{t('createTitle')}</h3>
      <WalletBar />
      {!formOpen && !ask && (
        <Button tone="primary" onClick={() => setFormOpen(true)} disabled={busy !== null}>
          {t('create')}
        </Button>
      )}
      {formOpen && !ask && (
        <form className="lt-stack" noValidate onSubmit={start}>
          <p className="lt-muted">{t('createIntro')}</p>
          <PermissionReach permission={terms.agentPermission ?? null} />
          <Field label={t('cap', { asset })} hint={t('capHint')} name="cap" inputMode="decimal" autoComplete="off" />
          <Field label={t('fund', { asset })} hint={t('fundHint')} name="fund" inputMode="decimal" autoComplete="off" />
          {!owner && (
            <p className="lt-muted">
              {t('walletNeeded')}{' '}
              <a className="lt-link" href="/wallet/venue">
                {t('openWallet')}
              </a>
            </p>
          )}
          <div className="lt-actions">
            <Button tone="primary" type="submit">
              {t('create')}
            </Button>
            <Button tone="secondary" onClick={() => setFormOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {ask && (
        <>
          <PermissionReach permission={terms.agentPermission ?? null} />
          <StepUpConfirm
            request={() => createStepUp(ask)}
            words={stepUpWords(t, 'stepUpWhy')}
            disabled={busy !== null}
            onApproved={(id) => void confirmed(id)}
          />
          <Button tone="secondary" disabled={busy !== null} onClick={() => setAsk(null)}>
            {t('cancel')}
          </Button>
        </>
      )}
      {busy && (
        <p className="lt-muted" role="status">
          {busy}
        </p>
      )}
      {message &&
        (message.failed ? (
          <p className="lt-refusal" role="alert">
            {message.text}
          </p>
        ) : (
          <p className="lt-muted" role="status">
            {message.text}
          </p>
        ))}
    </section>
  );
}

/**
 * How far the agent permission the wallet is about to sign reaches (J-agents-21 #3): shown with the create form and
 * again with its step-up, before the wallet is asked to sign anything. The venue's own declaration, read by svc-trade;
 * not read is said as reaching the person's other accounts, never as a limit nobody declared.
 */
function PermissionReach({ permission }: { permission: AgentPermission | null }) {
  const { t } = copy.useCopy();
  const reachClass = permission?.reach !== 'own_account_only' ? 'lt-refusal' : 'lt-muted';
  return (
    <p className={reachClass} role="note" data-testid="agent-connect__reach" data-reach={permission?.reach ?? 'unknown'}>
      {permission === null
        ? t('reachUnknown')
        : permission.reach === 'own_account_only'
          ? t('reachOwn', { venue: permission.venue })
          : t('reachOthers', { venue: permission.venue })}
    </p>
  );
}

/**
 * The key's end (J-agents-21 #19): none without a day; the end of that day (UTC) without a time; else that minute of
 * that day (UTC). `false` when what was typed is not one, so a mistyped end never makes a key that never ends.
 */
function endsAt(day: string, time: string): string | undefined | false {
  if (day === '') return time === '' ? undefined : false;
  if (time === '') return endOfDayUtc(day) ?? false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return false;
  const at = Date.parse(`${day}T${time}:00.000Z`);
  return Number.isFinite(at) ? new Date(at).toISOString() : false;
}

type Made = { made: ApiKeyCreateOutput & { key: string }; account: AgentAccount };

/**
 * Connect your assistant: an API key tagged Agent, made with a passkey answer (identity refuses a withdraw scope on an
 * agent key at create, `auth.agent_scope_forbidden`), then bound to the chosen agent account after step-up. The key and
 * the MCP setup are held in memory for the shown-once panel and dropped when it closes or the page is left.
 */
function ConnectAssistant({ open, keys, reload }: { open: AgentAccount[]; keys: ApiKeyList['keys']; reload: () => void }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const [scopes, setScopes] = useState<string[]>([...ASSISTANT_SCOPES]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState<Made | null>(null);
  const [shown, setShown] = useState<Made | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function makeKey(form: HTMLFormElement) {
    if (busy || !userId) return;
    const data = new FormData(form);
    const account = open.find((a) => a.accountId === String(data.get('accountId') ?? ''));
    if (!account) return;
    const expiresAt = endsAt(String(data.get('ends') ?? ''), String(data.get('endsTime') ?? ''));
    if (expiresAt === false) return setRefusal(t('endsBad'));
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await createAssistantKey(api, userId, keys, {
        name: String(data.get('name') ?? ''),
        scopes: [...scopes],
        ...(expiresAt ? { expiresAt } : {}),
      });
      if (!alive.current) return;
      if (!answer.ok) return setRefusal(refusalText(t, answer));
      if (answer.data.key === null) return setRefusal(t('refusedOther', { message: 'identity.key_request_replayed' }));
      setPending({ made: { ...answer.data, key: answer.data.key }, account });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function bind(stepUpApprovalId: string | null) {
    if (!pending || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const bound = await connectAssistant(api, pending.account.accountId, pending.made.record.id, stepUpApprovalId);
      if (!alive.current) return;
      if (!bound.ok) return setRefusal(refusalText(t, bound));
      setShown(pending);
      setPending(null);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (shown)
    return (
      <ShownOnce
        shown={shown}
        onDone={() => {
          setShown(null);
          reload();
        }}
      />
    );
  return (
    <Section className="lt-stack" title={t('connectTitle')} data-testid="agent-connect__connect">
      <p className="lt-muted">{t('connectIntro')}</p>
      {open.length === 0 ? (
        <p className="lt-muted">{t('connectNeedsAccount')}</p>
      ) : pending ? (
        <StepUpConfirm
          request={() => connectStepUp(pending.made.record.id, pending.account.accountId)}
          words={stepUpWords(t, 'connectStepUpWhy')}
          disabled={busy}
          onApproved={(id) => void bind(id)}
        />
      ) : (
        <form
          className="lt-stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void makeKey(event.currentTarget);
          }}
        >
          <Select
            label={t('connectAccount')}
            name="accountId"
            defaultValue={open[0]!.accountId}
            options={open.map((a) => ({ value: a.accountId, label: a.name }))}
          />
          <Field label={t('keyName')} hint={t('keyNameHint')} name="name" autoComplete="off" maxLength={64} />
          <fieldset className="lt-stack">
            <legend>{t('permissions')}</legend>
            {[...ASSISTANT_SCOPES, WITHDRAW_SCOPE].map((scope) => (
              <Checkbox
                key={scope}
                name="scope"
                value={scope}
                checked={scopes.includes(scope)}
                onCheckedChange={(on) => {
                  setScopes((current) => (on ? [...current, scope] : current.filter((s) => s !== scope)));
                }}
              >
                {t(SCOPE_KEY[scope]!)}
              </Checkbox>
            ))}
          </fieldset>
          <Field label={t('ends')} hint={t('endsHint')} name="ends" type="date" />
          <Field label={t('endsTime')} hint={t('endsTimeHint')} name="endsTime" type="time" />
          <Button tone="primary" type="submit" disabled={busy}>
            {busy ? t('connecting') : t('connect')}
          </Button>
        </form>
      )}
      {refusal && (
        <p className="lt-refusal" role="alert" data-testid="agent-connect__refusal">
          {refusal}
        </p>
      )}
    </Section>
  );
}

/** The key, its signing secret and the MCP setup, once; a box to tick before the panel can close. */
function ShownOnce({ shown, onDone }: { shown: Made; onDone: () => void }) {
  const { t } = copy.useCopy();
  const [stored, setStored] = useState(false);
  const { made, account } = shown;
  const setup = mcpSetup(window.location.origin, made.key, made.signingSecret ?? null);
  return (
    <Section className="lt-stack" title={t('secretTitle')} data-testid="agent-connect__secret">
      <p role="alert">{t('secretOnce')}</p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> {made.record.kind === 'agent' && <Tag tone="neutral">{t('tagAgent')}</Tag>}
      </p>
      <p data-testid="agent-connect__bound">{t('boundTo', { account: account.name })}</p>
      <p data-testid="agent-connect__scopes">{t('scopesHeld', { scopes: made.record.scopes.join(', ') })}</p>
      <h3 id="agent-connect-key">{t('keyLabel')}</h3>
      <output data-testid="agent-connect__key" aria-labelledby="agent-connect-key">
        <code lang="und">{made.key}</code>
      </output>
      {made.signingSecret && (
        <>
          <h3 id="agent-connect-signing">{t('signingLabel')}</h3>
          <output data-testid="agent-connect__signing-secret" aria-labelledby="agent-connect-signing">
            <code lang="und">{made.signingSecret}</code>
          </output>
        </>
      )}
      <h3 id="agent-connect-mcp">{t('mcpTitle')}</h3>
      <p className="lt-muted">{t('mcpIntro')}</p>
      <pre data-testid="agent-connect__mcp" aria-labelledby="agent-connect-mcp" lang="und">
        {setup}
      </pre>
      <Checkbox checked={stored} onCheckedChange={setStored}>
        {t('stored')}
      </Checkbox>
      <Button tone="primary" disabled={!stored} onClick={onDone}>
        {t('done')}
      </Button>
    </Section>
  );
}
