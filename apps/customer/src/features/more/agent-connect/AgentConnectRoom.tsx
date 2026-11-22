import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyCreateOutput, ApiKeyList } from '@intafaced/contracts/api-keys';
import { Button, Checkbox, EmptyState, Field, Select, Tag } from '@intafaced/ui/lit';
import { FlowTemplate, Table, type Refusal, type RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import { useSession } from '../../session';
import { StepUpConfirm } from '../../money';
import { useWallet } from '../../protocol';
import { WalletBar } from '../../trade';
import { endOfDayUtc } from '../../account';
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
} from '../agent-connect-api';
import { agentConnectCopy as copy } from '../agent-connect-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Words = ReturnType<typeof copy.useCopy>['t'];
type UiWords = ReturnType<typeof uiCopy.useCopy>['t'];

const ROUTE = '/agents/connect';

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

/** A refusal in this room's words when it has some, else the service's own sentence with its code. */
function refusalText(t: Words, failed: Failed): string {
  const key = `refused.${failed.code ?? ''}`;
  if (failed.code && key in REFUSAL_KEYS) return t(key as RefusalKey);
  return t('refusedOther', { message: [failed.code, failed.message].filter(Boolean).join(': ') });
}
const REFUSAL_KEYS = {
  'refused.auth.agent_scope_forbidden': true,
  'refused.auth.scope_empty': true,
  'refused.identity.key_name_invalid': true,
  'refused.identity.key_name_taken': true,
  'refused.identity.key_expiry_invalid': true,
  'refused.auth.webauthn_invalid': true,
  'refused.auth.passkey_missing': true,
} as const;
type RefusalKey = keyof typeof REFUSAL_KEYS;

/**
 * The room's read refused, in the app's shared words for its reason: signed out offers Sign in, a network trouble
 * offers a fresh read, and the service's own sentence and code are kept.
 */
function readRefusal(ui: UiWords, failed: Failed): Refusal {
  const notConnected = failed.reason === 'not_mounted';
  const again = failed.reason === 'unreachable' || failed.reason === 'invalid_response' || failed.reason === 'aborted';
  return {
    variant: failed.reason === 'unreachable' ? 'unreachable' : 'refused',
    title: ui(failed.reason),
    body: notConnected ? ui('serviceNotConnected') : failed.message,
    ...(failed.code ? { reference: failed.code } : {}),
    ...(failed.reason === 'unauthorized'
      ? { action: { label: ui('signIn'), href: `/login?redirect=${encodeURIComponent(ROUTE)}` } }
      : again
        ? { action: { label: ui('retry'), href: ROUTE } }
        : {}),
  };
}

const STATUS_KEY: Record<string, 'status_opening' | 'status_open' | 'status_closed' | 'status_abandoned'> = {
  opening: 'status_opening',
  open: 'status_open',
  closed: 'status_closed',
  abandoned: 'status_abandoned',
};
const STEP_KEY: Record<string, 'step_open_sub_account' | 'step_approve_agent' | 'step_move_in' | 'step_move_out' | 'step_revoke_agent'> = {
  open_sub_account: 'step_open_sub_account',
  approve_agent: 'step_approve_agent',
  move_in: 'step_move_in',
  move_out: 'step_move_out',
  revoke_agent: 'step_revoke_agent',
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
 * Connect your assistant (`/agents/connect`, J-agents-21 #2 and #6; AG-outside-01, AG-outside-02), on the flow template:
 * what the person's own outside assistant can and cannot do, their agent accounts with Create agent account, and the
 * connection: an API key tagged Agent with trade scopes, bound to one agent account after step-up, its secret and MCP
 * setup shown once. Every refusal is the service's own; nothing is checked only in the browser. INTAFACED holds and
 * moves nothing. It signs with the wallet of the venue frame around it (`./AgentConnect`).
 */
export function AgentConnectRoom() {
  const { t } = copy.useCopy();
  const { t: ui } = uiCopy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readRoom(api, signal), `agent-connect:${userId}`);
  // A read again after a create or a connect keeps the last read on screen, so the room's own messages stay.
  const last = useRef<Ready | null>(null);
  if (resource.status === 'ready') last.current = resource.data;
  const data = resource.status === 'ready' ? resource.data : resource.status === 'loading' ? last.current : null;

  let state: RoomState = { kind: 'ready' };
  if (resource.status === 'failed') state = { kind: 'refused', refusal: readRefusal(ui, resource.failure) };
  else if (!data) state = { kind: 'loading' };

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      roomAction={
        <a className="lt-link" href="/agents">
          {t('back')}
        </a>
      }
      step={
        data ? (
          <div data-testid="agent-connect">
            {data.off ? (
              <section data-testid="agent-connect__accounts" aria-labelledby="agent-connect-accounts">
                <h2 id="agent-connect-accounts">{t('accountsTitle')}</h2>
                <p className="lt-hint" role="status">
                  {t('doorOff')}
                </p>
                <Button tone="primary" disabled>
                  {t('create')}
                </Button>
              </section>
            ) : (
              <Room data={data} reload={reload} />
            )}
          </div>
        ) : null
      }
      help={<CanCannot terms={data && !data.off ? data.terms : null} />}
    />
  );
}

function CanCannot({ terms }: { terms: AgentTerms | null }) {
  const { t } = copy.useCopy();
  return (
    <section data-testid="agent-connect__can" aria-labelledby="agent-connect-can">
      <h2 id="agent-connect-can">{t('canTitle')}</h2>
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
      <p className="lt-hint">{t('mostLoss')}</p>
      {terms && (
        <p className="lt-hint" data-testid="agent-connect__ceiling">
          {terms.ceiling !== null && terms.asset !== null
            ? t('ceiling', { ceiling: terms.ceiling, asset: terms.asset })
            : t('ceilingUnset')}
        </p>
      )}
    </section>
  );
}

function Room({ data, reload }: { data: Extract<Ready, { off: false }>; reload: () => void }) {
  const { t } = copy.useCopy();
  const open = data.accounts.filter((a) => a.status === 'open');
  return (
    <>
      <section data-testid="agent-connect__accounts" aria-labelledby="agent-connect-accounts">
        <h2 id="agent-connect-accounts">{t('accountsTitle')}</h2>
        {data.accounts.length === 0 ? (
          <EmptyState title={t('accountsEmpty')} />
        ) : (
          <Table
            caption={t('accountsTitle')}
            rows={data.accounts}
            rowKey={(a) => a.accountId}
            columns={[
              {
                key: 'account',
                label: t('colAccount'),
                cell: (a) => (
                  <>
                    <bdi lang="und">{a.name}</bdi> {a.test ? <span className="lt-test">{t('testLabel')}</span> : null}
                  </>
                ),
              },
              { key: 'status', label: t('colStatus'), cell: (a) => (STATUS_KEY[a.status] ? t(STATUS_KEY[a.status]!) : a.status) },
              {
                key: 'balance',
                label: t('colBalance'),
                align: 'end',
                cell: (a) => {
                  const total = venueTotal(a);
                  return total === null ? t('notOpened') : `${total} ${a.asset}`;
                },
              },
              { key: 'cap', label: t('colCap'), align: 'end', cell: (a) => `${a.cap} ${a.asset}` },
            ]}
          />
        )}
        <CreateAccount terms={data.terms} reload={reload} />
      </section>
      <ConnectAssistant open={open} keys={data.keys} reload={reload} />
      <section data-testid="agent-connect__connections" aria-labelledby="agent-connect-connections">
        <h2 id="agent-connect-connections">{t('connectionsTitle')}</h2>
        {data.connections.length === 0 ? (
          <p className="lt-hint">{t('connectionsEmpty')}</p>
        ) : (
          <Table
            caption={t('connectionsTitle')}
            rows={data.connections}
            rowKey={(c) => c.keyId}
            columns={[
              {
                key: 'key',
                label: t('colKey'),
                cell: (c) => (
                  <>
                    <bdi lang="und">{data.keys.find((k) => k.id === c.keyId)?.name ?? c.keyId}</bdi>{' '}
                    <Tag tone="neutral">{t('tagAgent')}</Tag>
                  </>
                ),
              },
              {
                key: 'account',
                label: t('colAccount'),
                cell: (c) => <bdi lang="und">{data.accounts.find((a) => a.accountId === c.accountId)?.name ?? c.accountId}</bdi>,
              },
            ]}
          />
        )}
      </section>
    </>
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
    <section data-testid="agent-connect__create" aria-labelledby="agent-connect-create">
      <h3 id="agent-connect-create">{t('createTitle')}</h3>
      <WalletBar />
      {!formOpen && !ask && (
        <Button tone="primary" onClick={() => setFormOpen(true)} disabled={busy !== null}>
          {t('create')}
        </Button>
      )}
      {formOpen && !ask && (
        <form noValidate onSubmit={start}>
          <p className="lt-hint">{t('createIntro')}</p>
          <PermissionReach permission={terms.agentPermission ?? null} />
          <Field label={t('cap', { asset })} hint={t('capHint')} name="cap" inputMode="decimal" autoComplete="off" />
          <Field label={t('fund', { asset })} hint={t('fundHint')} name="fund" inputMode="decimal" autoComplete="off" />
          {!owner && (
            <p className="lt-hint">
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
        <p className="lt-hint" role="status">
          {busy}
        </p>
      )}
      {message && (
        <p className={message.failed ? undefined : 'lt-hint'} role={message.failed ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
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
  const others = permission?.reach !== 'own_account_only';
  return (
    <p
      className={others ? undefined : 'lt-hint'}
      role="note"
      data-testid="agent-connect__reach"
      data-reach={permission?.reach ?? 'unknown'}
    >
      {permission === null
        ? t('reachUnknown')
        : permission.reach === 'own_account_only'
          ? t('reachOwn', { venue: permission.venue })
          : t('reachOthers', { venue: permission.venue })}
    </p>
  );
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
    const ends = String(data.get('ends') ?? '');
    const expiresAt = ends ? endOfDayUtc(ends) : undefined;
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
    <section data-testid="agent-connect__connect" aria-labelledby="agent-connect-connect">
      <h2 id="agent-connect-connect">{t('connectTitle')}</h2>
      <p className="lt-hint">{t('connectIntro')}</p>
      {open.length === 0 ? (
        <p className="lt-hint">{t('connectNeedsAccount')}</p>
      ) : pending ? (
        <StepUpConfirm
          request={() => connectStepUp(pending.made.record.id, pending.account.accountId)}
          words={stepUpWords(t, 'connectStepUpWhy')}
          disabled={busy}
          onApproved={(id) => void bind(id)}
        />
      ) : (
        <form
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
            options={open.map((a) => [a.accountId, a.name] as const)}
          />
          <Field label={t('keyName')} hint={t('keyNameHint')} name="name" autoComplete="off" maxLength={64} />
          <fieldset>
            <legend>{t('permissions')}</legend>
            {[...ASSISTANT_SCOPES, WITHDRAW_SCOPE].map((scope) => (
              <Checkbox
                key={scope}
                label={t(SCOPE_KEY[scope]!)}
                name="scope"
                value={scope}
                checked={scopes.includes(scope)}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setScopes((current) => (on ? [...current, scope] : current.filter((s) => s !== scope)));
                }}
              />
            ))}
          </fieldset>
          <Field label={t('ends')} hint={t('endsHint')} name="ends" type="date" />
          <Button tone="primary" type="submit" disabled={busy}>
            {busy ? t('connecting') : t('connect')}
          </Button>
        </form>
      )}
      {refusal && (
        <p role="alert" data-testid="agent-connect__refusal">
          {refusal}
        </p>
      )}
    </section>
  );
}

/** The key, its signing secret and the MCP setup, once; a box to tick before the panel can close. */
function ShownOnce({ shown, onDone }: { shown: Made; onDone: () => void }) {
  const { t } = copy.useCopy();
  const [stored, setStored] = useState(false);
  const { made, account } = shown;
  const setup = mcpSetup(window.location.origin, made.key, made.signingSecret ?? null);
  return (
    <section data-testid="agent-connect__secret" aria-labelledby="agent-connect-secret">
      <h2 id="agent-connect-secret">{t('secretTitle')}</h2>
      <p role="alert">{t('secretOnce')}</p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> {made.record.kind === 'agent' && <Tag tone="neutral">{t('tagAgent')}</Tag>}
      </p>
      <p data-testid="agent-connect__bound">{t('boundTo', { account: account.name })}</p>
      <p data-testid="agent-connect__scopes">{t('scopesHeld', { scopes: made.record.scopes.join(', ') })}</p>
      <h3 id="agent-connect-key">{t('keyLabel')}</h3>
      <output data-testid="agent-connect__key" aria-labelledby="agent-connect-key">
        <code className="lt-mono" lang="und">
          {made.key}
        </code>
      </output>
      {made.signingSecret && (
        <>
          <h3 id="agent-connect-signing">{t('signingLabel')}</h3>
          <output data-testid="agent-connect__signing-secret" aria-labelledby="agent-connect-signing">
            <code className="lt-mono" lang="und">
              {made.signingSecret}
            </code>
          </output>
        </>
      )}
      <h3 id="agent-connect-mcp">{t('mcpTitle')}</h3>
      <p className="lt-hint">{t('mcpIntro')}</p>
      <pre className="lt-mono" data-testid="agent-connect__mcp" aria-labelledby="agent-connect-mcp" lang="und">
        {setup}
      </pre>
      <Checkbox label={t('stored')} checked={stored} onChange={(event) => setStored(event.currentTarget.checked)} />
      <Button tone="primary" disabled={!stored} onClick={onDone}>
        {t('done')}
      </Button>
    </section>
  );
}
