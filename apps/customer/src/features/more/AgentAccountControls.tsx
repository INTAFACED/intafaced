import { useState, type FormEvent } from 'react';
import type { ApiKeyList } from '@intafaced/contracts/api-keys';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Failure, Field, Loading, Panel } from '../../shared/ui';
import { useSession } from '../session';
import { useWallet, utcTime } from '../protocol';
import {
  canonical,
  closeAgentAccount,
  moveAgentFunds,
  readAgentActivity,
  revokeAssistant,
  revokeAssistantKey,
  setAgentCap,
  setAgentLimits,
  submitAgentAction,
  venueTotal,
  walletTypedData,
  type AgentAccount,
  type AgentActivityRow,
  type AgentConnection,
  type AgentNext,
  type AgentRevoke,
} from './agent-connect-api';
import { agentConnectCopy as copy } from './agent-connect-copy';
import { STEP_KEY, refusalText } from './agent-connect-shared';
import { downloadCsv, toCsv } from './depth-csv';

type Note = { text: string; failed: boolean };
type Signed = { ok: true; signature: { digest: string; signature: string; signedBy: string } } | { ok: false; why: string };
/** A venue action svc-trade prepared for the wallet: an agent account's next step, or the venue's revoke of its agent. */
type Signable = { prepared: { digest: string; typedData: AgentNext['prepared']['typedData'] } };

/** The person's wallet signs one venue action svc-trade prepared; when it does not, why, and nothing was sent. */
function useVenueSigner(): (next: Signable, owner: string) => Promise<Signed> {
  const { t } = copy.useCopy();
  const wallet = useWallet();
  return async (next, owner) => {
    if (wallet.status !== 'connected' || !wallet.address) return { ok: false, why: t('walletNeeded') };
    const typedData = walletTypedData(next.prepared.typedData);
    if (!typedData) return { ok: false, why: t('payloadUnreadable') };
    const signed = await wallet.sign({ kind: 'typedData', typedData });
    if (signed.status === 'signed')
      return { ok: true, signature: { digest: next.prepared.digest, signature: signed.signature, signedBy: owner } };
    if (signed.status === 'rejected') return { ok: false, why: t('rejectedSignature') };
    return { ok: false, why: t('walletFailed', { reason: signed.status === 'failed' ? signed.message : signed.status }) };
  };
}

function Said({ note }: { note: Note | null }) {
  if (!note) return null;
  return (
    <p className={note.failed ? 'error-text' : 'muted'} role={note.failed ? 'alert' : 'status'} data-testid="agent-connect__said">
      {note.text}
    </p>
  );
}

/**
 * One open agent account's own controls (J-agents-21 #4 #5 #13 #14 #16): move more in or move it back (each the
 * person's own wallet-signed venue transfer, under an id made once per ask), change the funding cap, set the three caps
 * on the assistant's orders, and close. svc-trade decides every one: a move in past the cap is refused before anything
 * is prepared for the wallet, a cap above the owner's ceiling is refused and stays, and a close is refused while a
 * position, an order or a balance is still there. INTAFACED holds and moves nothing.
 */
export function AccountControls({ account, reload }: { account: AgentAccount; reload: () => void }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const sign = useVenueSigner();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  // A move's id is made once per ask and kept while its answer is not definite, so a press again is the same move.
  const [asked, setAsked] = useState<{ direction: 'fund' | 'withdraw'; amount: string; moveId: string } | null>(null);
  const { accountId, asset } = account;
  const titleId = `agent-connect-manage-${accountId}`;

  async function run(work: () => Promise<Note>) {
    if (busy) return;
    setBusy(t('connecting'));
    setNote(null);
    try {
      setNote(await work());
    } finally {
      setBusy(null);
      reload();
    }
  }

  /** The wallet signs each venue action waiting on this account, each sent once under its key. */
  async function signWaiting(view: AgentAccount): Promise<Note> {
    for (let i = 0; view.next && i < 3; i += 1) {
      const next = view.next;
      setBusy(t('signing', { step: STEP_KEY[next.step] ? t(STEP_KEY[next.step]!) : next.step }));
      const signed = await sign(next, view.owner);
      if (!signed.ok) return { text: t('moveWaits', { why: signed.why }), failed: true };
      const sent = await submitAgentAction(api, accountId, next.actionKey, signed.signature);
      if (!sent.ok) return { text: refusalText(t, sent), failed: true };
      view = sent.data;
    }
    if (view.next) return { text: t('notFinished'), failed: true };
    return { text: t('moved', { balance: venueTotal(view) ?? '0', asset }), failed: false };
  }

  function move(direction: 'fund' | 'withdraw', event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = canonical(String(new FormData(event.currentTarget).get('amount') ?? ''));
    if (!amount) return setNote({ text: t('amountOneBad'), failed: true });
    const ask =
      asked && asked.direction === direction && asked.amount === amount ? asked : { direction, amount, moveId: crypto.randomUUID() };
    setAsked(ask);
    void run(async () => {
      const prepared = await moveAgentFunds(api, accountId, direction, ask.moveId, amount);
      if (!prepared.ok) {
        // A definite refusal ends this ask; one whose answer was lost keeps its id, so the retry is the same move.
        if (prepared.reason !== 'uncertain') setAsked(null);
        return { text: refusalText(t, prepared), failed: true };
      }
      setAsked(null);
      return signWaiting(prepared.data);
    });
  }

  function changeCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cap = canonical(String(new FormData(event.currentTarget).get('cap') ?? ''));
    if (!cap) return setNote({ text: t('amountOneBad'), failed: true });
    void run(async () => {
      const set = await setAgentCap(api, accountId, cap);
      return set.ok ? { text: t('capSet', { cap: set.data.cap, asset }), failed: false } : { text: refusalText(t, set), failed: true };
    });
  }

  function saveLimits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const typed = (name: string) => String(form.get(name) ?? '').trim();
    const limits: { maxOrderNotional?: string; maxLeverage?: string; maxDailyLoss?: string } = {};
    for (const name of ['maxOrderNotional', 'maxDailyLoss'] as const) {
      if (typed(name) === '') continue;
      const amount = canonical(typed(name));
      if (!amount) return setNote({ text: t('amountOneBad'), failed: true });
      limits[name] = amount;
    }
    if (typed('maxLeverage') !== '') limits.maxLeverage = typed('maxLeverage');
    if (Object.keys(limits).length === 0) return setNote({ text: t('limitsNone'), failed: true });
    void run(async () => {
      const set = await setAgentLimits(api, accountId, limits);
      return set.ok ? { text: t('limitsSet'), failed: false } : { text: refusalText(t, set), failed: true };
    });
  }

  const close = () =>
    void run(async () => {
      const closed = await closeAgentAccount(api, accountId);
      return closed.ok ? { text: t('closed'), failed: false } : { text: refusalText(t, closed), failed: true };
    });

  return (
    <section className="lt-stack" data-testid="agent-connect__manage" data-account={accountId} aria-labelledby={titleId}>
      <h3 id={titleId}>
        {t('manageTitle')} <bdi lang="und">{account.name}</bdi>
      </h3>
      <p className="lt-muted" data-testid="agent-connect__room">
        {t('roomLeft', { room: account.room, cap: account.cap, asset })}
      </p>
      {account.next && (
        <div className="lt-actions">
          <p className="lt-muted">{t('waiting')}</p>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void run(() => signWaiting(account))}>
            {t('signWaiting')}
          </Button>
        </div>
      )}
      <form className="lt-stack" noValidate data-testid="agent-connect__fund" onSubmit={(event) => move('fund', event)}>
        <Field label={t('moveIn', { asset })} hint={t('moveInHint')} name="amount" inputMode="decimal" autoComplete="off" />
        <div className="lt-actions">
          <Button type="submit" variant="secondary" disabled={busy !== null}>
            {t('moveInSubmit')}
          </Button>
        </div>
      </form>
      <form className="lt-stack" noValidate data-testid="agent-connect__withdraw" onSubmit={(event) => move('withdraw', event)}>
        <Field label={t('moveBack', { asset })} hint={t('moveBackHint')} name="amount" inputMode="decimal" autoComplete="off" />
        <div className="lt-actions">
          <Button type="submit" variant="secondary" disabled={busy !== null}>
            {t('moveBackSubmit')}
          </Button>
        </div>
      </form>
      <form className="lt-stack" noValidate data-testid="agent-connect__change-cap" onSubmit={changeCap}>
        <Field label={t('newCap', { asset })} hint={t('newCapHint')} name="cap" inputMode="decimal" autoComplete="off" />
        <div className="lt-actions">
          <Button type="submit" variant="secondary" disabled={busy !== null}>
            {t('newCapSubmit')}
          </Button>
        </div>
      </form>
      <form className="lt-stack" noValidate data-testid="agent-connect__set-limits" onSubmit={saveLimits}>
        <p className="lt-muted">{t('limitsIntro')}</p>
        <Field label={t('limitOrderField', { asset })} name="maxOrderNotional" inputMode="decimal" autoComplete="off" />
        <Field label={t('limitLeverageField')} name="maxLeverage" inputMode="numeric" autoComplete="off" />
        <Field label={t('limitDailyLossField', { asset })} name="maxDailyLoss" inputMode="decimal" autoComplete="off" />
        <div className="lt-actions">
          <Button type="submit" variant="secondary" disabled={busy !== null}>
            {t('limitsSubmit')}
          </Button>
        </div>
      </form>
      <div className="lt-actions">
        <Button variant="danger" disabled={busy !== null} onClick={close}>
          {t('close')}
        </Button>
      </div>
      {busy && (
        <p className="lt-muted" role="status">
          {busy}
        </p>
      )}
      <Said note={note} />
    </section>
  );
}

const OUTCOME_KEY = { accepted: 'outcome_accepted', refused: 'outcome_refused', failed: 'outcome_failed' } as const;

/**
 * A connection's Activity (J-agents-21 #11): one row per call made with the assistant's key, refused ones included,
 * newest first, as svc-trade answers it from identity's call log. The export is the same rows, as a file.
 */
function Activity({ keyId, name }: { keyId: string; name: string }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const { resource, reload } = useResource((signal) => readAgentActivity(api, keyId, signal), `agent-connect-activity:${keyId}`);
  const [exportFailed, setExportFailed] = useState(false);
  const outcome = (row: AgentActivityRow) => t(OUTCOME_KEY[row.outcome]);

  function exportRows(rows: readonly AgentActivityRow[]) {
    const header = [
      t('colTime'),
      t('colTool'),
      t('colOutcome'),
      t('colStatus'),
      t('colCode'),
      t('colOrder'),
      t('colVenueOrder'),
      t('colRequest'),
    ];
    const lines = rows.map((r) => [
      r.at,
      r.tool,
      outcome(r),
      String(r.status),
      r.code ?? '',
      r.order?.clientOrderId ?? '',
      r.order?.venueOrderId ?? '',
      r.requestId,
    ]);
    setExportFailed(!downloadCsv(`assistant-activity-${keyId}.csv`, toCsv(header, lines)));
  }

  return (
    <section className="lt-stack" data-testid="agent-connect__activity" data-key={keyId} aria-labelledby="agent-connect-activity">
      <h3 id="agent-connect-activity">
        {t('activityTitle')} <bdi lang="und">{name}</bdi>
      </h3>
      {resource.status === 'loading' && <Loading label={t('activityLoading')} />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && resource.data.rows.length === 0 && <p className="lt-muted">{t('activityEmpty')}</p>}
      {resource.status === 'ready' && resource.data.rows.length > 0 && (
        <>
          <DataTable
            label={t('activityTitle')}
            headers={[t('colTime'), t('colTool'), t('colOutcome'), t('colStatus'), t('colCode'), t('colOrder'), t('colVenueOrder')]}
          >
            {resource.data.rows.map((r) => (
              <tr key={r.requestId} data-request={r.requestId} data-outcome={r.outcome}>
                <td>
                  <time dateTime={r.at}>{utcTime(r.at)}</time>
                </td>
                <td>
                  <code lang="und">{r.tool}</code>
                </td>
                <td>{outcome(r)}</td>
                <td>{r.status}</td>
                <td>{r.code === null ? t('none') : <code lang="und">{r.code}</code>}</td>
                <td>{r.order === null ? t('none') : <code lang="und">{r.order.clientOrderId}</code>}</td>
                <td>{r.order?.venueOrderId ? <code lang="und">{r.order.venueOrderId}</code> : t('none')}</td>
              </tr>
            ))}
          </DataTable>
          <div className="lt-actions">
            <Button variant="secondary" onClick={() => exportRows(resource.data.rows)}>
              {t('activityExport')}
            </Button>
            <Button variant="ghost" onClick={reload}>
              {t('retry')}
            </Button>
          </div>
          {exportFailed && (
            <p className="error-text" role="alert">
              {t('activityExportFailed')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The person's connected assistants (J-agents-21 #11 #12 #19): each key with the agent account it trades and its end
 * date as identity holds it, its Activity, and Revoke. Revoke is the person's own two calls, then their wallet: identity
 * switches the API key off, svc-trade ends the connection, cancels the assistant's resting orders once and drops our
 * copy of the venue agent key, and the wallet signs the venue's own revoke of that agent. Nothing moves.
 */
export function Connections({
  connections,
  keys,
  accounts,
  reload,
}: {
  connections: AgentConnection[];
  keys: ApiKeyList['keys'];
  accounts: AgentAccount[];
  reload: () => void;
}) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const sign = useVenueSigner();
  const [shown, setShown] = useState<{ keyId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // A revoke the venue still waits on: its key is off already, and the wallet can be asked again while this page is open.
  const [unsigned, setUnsigned] = useState<{ keyId: string; owner: string; view: AgentRevoke } | null>(null);

  const revokedNote = (view: AgentRevoke): Note => ({
    text: t('revoked', { cancelled: String(view.cancels.filter((c) => c.state === 'cancelled').length) }),
    failed: false,
  });

  /** The wallet signs the venue's revoke of the agent behind the key; until it does, the venue still lists it. */
  async function signVenueRevoke(keyId: string, owner: string, view: AgentRevoke): Promise<Note> {
    if (!view.next) {
      setUnsigned(null);
      return revokedNote(view);
    }
    setUnsigned({ keyId, owner, view });
    const signed = await sign(view.next, owner);
    if (!signed.ok) return { text: t('revokedVenueWaits', { why: signed.why }), failed: true };
    const sent = await revokeAssistant(api, keyId, { actionKey: view.next.actionKey, signature: signed.signature });
    if (!sent.ok) return { text: t('revokedVenueWaits', { why: refusalText(t, sent) }), failed: true };
    if (sent.data.next) return { text: t('revokedVenueWaits', { why: t('notFinished') }), failed: true };
    setUnsigned(null);
    return revokedNote(sent.data);
  }

  async function run(work: () => Promise<Note>) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(await work());
    } finally {
      setBusy(false);
      reload();
    }
  }

  const revoke = (c: AgentConnection) =>
    void run(async () => {
      const off = await revokeAssistantKey(api, c.keyId);
      if (!off.ok) return { text: refusalText(t, off), failed: true };
      const ended = await revokeAssistant(api, c.keyId);
      if (!ended.ok) return { text: refusalText(t, ended), failed: true };
      const owner = accounts.find((a) => a.accountId === c.accountId)?.owner ?? '';
      return signVenueRevoke(c.keyId, owner, ended.data);
    });

  return (
    <Panel title={t('connectionsTitle')} data-testid="agent-connect__connections">
      {connections.length === 0 ? (
        <p className="lt-muted">{t('connectionsEmpty')}</p>
      ) : (
        <DataTable label={t('connectionsTitle')} headers={[t('colKey'), t('colAccount'), t('colEnds'), t('colActions')]}>
          {connections.map((c) => {
            const name = keys.find((k) => k.id === c.keyId)?.name ?? c.keyId;
            const account = accounts.find((a) => a.accountId === c.accountId);
            const ends = c.expiry?.known ? c.expiry.expiresAt : undefined;
            return (
              <tr key={c.keyId} data-key={c.keyId}>
                <td>
                  <bdi lang="und">{name}</bdi> <span className="badge">{t('tagAgent')}</span>
                </td>
                <td>
                  <bdi lang="und">{account?.name ?? c.accountId}</bdi>
                </td>
                <td data-testid="agent-connect__ends">
                  {ends === undefined ? t('endUnknown') : ends === null ? t('noEnd') : <time dateTime={ends}>{utcTime(ends)}</time>}
                </td>
                <td>
                  <div className="lt-actions">
                    <Button variant="secondary" onClick={() => setShown({ keyId: c.keyId, name })}>
                      {t('activity')}
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => revoke(c)}>
                      {t('revoke')}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
      <Said note={note} />
      {unsigned && !busy && (
        <div className="lt-actions">
          <Button variant="secondary" onClick={() => void run(() => signVenueRevoke(unsigned.keyId, unsigned.owner, unsigned.view))}>
            {t('signVenueRevoke')}
          </Button>
        </div>
      )}
      {shown && <Activity key={shown.keyId} keyId={shown.keyId} name={shown.name} />}
    </Panel>
  );
}
