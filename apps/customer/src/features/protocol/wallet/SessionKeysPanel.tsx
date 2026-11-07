import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ProtocolSessionKey, ProtocolSessionsList } from '@intafaced/contracts/protocol-sessions';
import { Button, DataTable, Dialog, EmptyState, Failure, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE } from '../region';
import { formatUnits } from '../swap/swap-math';
import { walletCopy } from './copy';
import { RepresentationPanel } from './RepresentationPanel';
import { isFactoryUnset } from './AccountsPanel';
import { sessionCopy } from './session-copy';
import { shortContract } from './transfer';
import { useWallet, waitMined } from './WalletProvider';

type Api = ReturnType<typeof createProtocolApi>;
type T = ReturnType<typeof sessionCopy.forLocale>['t'];
/** A call in flight: built, then sent (`hash`), then mined at `minedAt` and waiting for the list's read to reach it. */
type Pending = { target: string; hash: string | null; minedAt?: bigint };
/** What the person asked to sign, held while the representation is accepted first. */
type Action = { kind: 'revoke'; key: string } | { kind: 'revokeAll' } | { kind: 'grant'; spec: GrantSpec };
type GrantSpec = { key: string; targets: string[]; selectors: string[]; spendLimitWei: string; validUntil: number };

const FOLLOW_MS = 120_000;
const CATCH_UP_EVERY_MS = 1_000;
const CATCH_UP_READS = 30;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const MAX_HOURS = 720;

/** "2026-11-07 08:30 UTC": one clock for everyone, as the chain keeps it. */
export function utcTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A decimal amount of native currency in wei; null when it is not a plain number of at most 18 decimals. */
export function toWei(text: string): string | null {
  const match = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!match) return null;
  return (BigInt(match[1]!) * 10n ** 18n + BigInt((match[2] ?? '').padEnd(18, '0'))).toString();
}

/**
 * /wallet/session-keys (D-portfolio-wallet-02): every session key the connected wallet's smart account granted, read from
 * the chain (`sessions.list`), each with its scope, cap, expiry, last use and status; Revoke per key and Revoke all in one
 * call; and New session key, whose scope the service refuses outright if it carries transfer or approval power. The
 * person's wallet signs every call; this page holds no key.
 */
export function SessionKeysPanel() {
  const { language } = usePreferences();
  const { t } = sessionCopy.forLocale(language);
  const { t: tw } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const ready = wallet.status === 'connected' && wallet.address !== null && wallet.guard?.ok === true;
  const blocker =
    wallet.status === 'connected' && wallet.address !== null && wallet.guard && !wallet.guard.ok
      ? tw('approvalsWrongNetwork')
      : tw('needsWallet');
  return (
    <Panel title={t('title')}>
      <p className="muted">{t('note')}</p>
      <p role="note">{t('never')}</p>
      {ready && wallet.address ? <OwnedSessions owner={wallet.address} /> : <KeysTable t={t} empty={blocker} />}
    </Panel>
  );
}

function KeysTable({
  t,
  empty,
  keys,
  pending,
  onRevoke,
  busy,
}: {
  t: T;
  empty?: string;
  keys?: readonly ProtocolSessionKey[];
  pending?: Pending | null;
  onRevoke?: (key: string) => void;
  busy?: boolean;
}) {
  const headers = ['hdr_key', 'hdr_scope', 'hdr_cap', 'hdr_expires', 'hdr_lastUsed', 'hdr_status', 'hdr_action'] as const;
  return (
    <DataTable label={t('title')} headers={headers.map((key) => t(key))}>
      {(!keys || keys.length === 0) && (
        <tr>
          <td colSpan={headers.length}>
            <EmptyState title={empty ?? t('empty')} />
          </td>
        </tr>
      )}
      {keys?.map((key) => {
        const revoking =
          pending?.hash && (pending.target === key.key.toLowerCase() || (pending.target === 'all' && key.status !== 'revoked'));
        const live = key.status === 'active' || key.status === 'not_yet_valid';
        return (
          <tr key={key.key} data-session-key={key.key}>
            <td className="numeric">{key.key}</td>
            <td>
              {t('scope', {
                selectors: key.selectors.join(', '),
                targets: key.targets.map((target) => shortContract(target)).join(', '),
              })}
            </td>
            <td className="numeric">
              {t('cap', {
                cap: formatUnits(BigInt(key.spendLimitWei), 18, 18),
                currency: 'ETH',
                spent: formatUnits(BigInt(key.spentWei), 18, 18),
              })}
            </td>
            <td className="numeric">{utcTime(new Date(key.validUntil * 1000).toISOString())}</td>
            <td className="numeric">{key.lastUsedAt ? utcTime(key.lastUsedAt) : t('never_used')}</td>
            <td>{revoking ? <span role="status">{t('revoking')}</span> : t(`status_${key.status}`)}</td>
            <td>
              {live && onRevoke && !revoking && (
                <Button variant="secondary" disabled={busy} onClick={() => onRevoke(key.key)}>
                  {t('revoke')}
                </Button>
              )}
            </td>
          </tr>
        );
      })}
    </DataTable>
  );
}

function OwnedSessions({ owner }: { owner: string }) {
  const { language } = usePreferences();
  const { t } = sessionCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource: account } = useResource((signal) => api.predictAccount(owner, signal), `wallet:accounts:${owner.toLowerCase()}`);
  if (account.status === 'loading') return <p role="status">{t('reading')}</p>;
  if (account.status === 'failed')
    return isFactoryUnset(account.failure.message) ? <KeysTable t={t} empty={t('factoryUnset')} /> : <Failure result={account.failure} />;
  return <AccountSessions owner={owner} account={account.data.address} api={api} />;
}

function AccountSessions({ owner, account, api }: { owner: string; account: string; api: Api }) {
  const { language } = usePreferences();
  const { t } = sessionCopy.forLocale(language);
  const wallet = useWallet();
  const { resource, reload } = useResource((signal) => api.sessionsList(account, signal), `wallet:sessions:${account.toLowerCase()}`);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [grantProblem, setGrantProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catchUp, setCatchUp] = useState(0);
  const [creating, setCreating] = useState(false);
  const [representation, setRepresentation] = useState<{ action: Action; status: RepresentationStatus } | null>(null);
  // A reload keeps showing the last list it had, so a key reads "Revoking" until the new read lands, never an empty table.
  const [last, setLast] = useState<ProtocolSessionsList | null>(null);
  useEffect(() => {
    if (resource.status === 'ready') setLast(resource.data);
  }, [resource]);
  const data: ProtocolSessionsList | null = resource.status === 'ready' ? resource.data : last;

  /**
   * The call is built first, so a scope the service refuses is refused before anything is signed; then the representation
   * gate, which never fails open; then the person's wallet sends it.
   */
  const act = async (action: Action) => {
    setProblem(null);
    setGrantProblem(null);
    setNotice(null);
    const target = action.kind === 'revoke' ? action.key.toLowerCase() : action.kind === 'revokeAll' ? 'all' : 'grant';
    setPending({ target, hash: null });
    const call =
      action.kind === 'revoke'
        ? await api.buildSessionRevoke({ account, sessionKey: action.key })
        : action.kind === 'revokeAll'
          ? await api.buildRevokeAllSessions({ account })
          : await api.buildSessionGrant({ account, spec: action.spec });
    if (!call.ok) {
      setPending(null);
      if (action.kind === 'grant')
        return setGrantProblem(/may never be granted/.test(call.message) ? t('refusedPower') : t('refusedScope', { reason: call.message }));
      return setProblem(t('buildFailed'));
    }
    const gate = await api.representationStatus(owner);
    if (!gate.ok) {
      setPending(null);
      return setProblem(
        t(
          gate.code === REGION_BLOCKED_CODE
            ? 'refused_region'
            : gate.code === 'compliance.representation_unset'
              ? 'refused_representation_unset'
              : 'refused_representation_unavailable',
        ),
      );
    }
    if (!gate.data.accepted) {
      setPending(null);
      return setRepresentation({ action, status: gate.data });
    }
    const facts =
      action.kind === 'revoke'
        ? [
            { label: t('factAccount'), value: account },
            { label: t('factKey'), value: action.key },
            { label: t('factEffect'), value: t('factEffectOne') },
          ]
        : action.kind === 'revokeAll'
          ? [
              { label: t('factAccount'), value: account },
              { label: t('factEffect'), value: t('factEffectAll') },
            ]
          : [
              { label: t('factAccount'), value: account },
              { label: t('factKey'), value: action.spec.key },
            ];
    const result = await wallet.sendSequence({
      title: action.kind === 'grant' ? t('grantSteps') : t('revokeSteps'),
      steps: [
        {
          label:
            action.kind === 'revoke'
              ? t('revokeStep', { key: action.key })
              : action.kind === 'revokeAll'
                ? t('revokeAllStep', { account })
                : t('grantStep', { key: action.spec.key }),
          request: { kind: 'transaction', to: call.data.to, data: call.data.data },
        },
      ],
      facts,
    });
    if (result.status !== 'sent') {
      setPending(null);
      return setProblem(result.status === 'rejected' ? t('rejected') : result.message);
    }
    if (action.kind === 'grant') setCreating(false);
    setCatchUp(0);
    setPending({ target, hash: result.hashes[result.hashes.length - 1]! });
  };

  // A sent call is followed until it is mined; then the list is read again until its block reaches the call's (the
  // service's node can be a block behind the wallet's). Until then the key reads "Revoking", never revoked (SAGA-2).
  useEffect(() => {
    const hash = pending?.hash;
    if (!hash || pending.minedAt !== undefined) return;
    let stopped = false;
    void (async () => {
      const mined = await waitMined(
        (receipt) => wallet.read('eth_getTransactionReceipt', [receipt]),
        hash,
        FOLLOW_MS,
        () => stopped,
      );
      if (stopped) return;
      if (mined.status === 'timeout') {
        setPending(null);
        return setProblem(t('notMined'));
      }
      if (mined.status === 'reverted') {
        setPending(null);
        return setProblem(t('reverted'));
      }
      // A receipt without its block number is placed at the wallet's own head, never at block 0.
      const minedAt = mined.blockNumber ?? BigInt(String(await wallet.read('eth_blockNumber', [])));
      if (stopped) return;
      setPending((now) => (now?.hash === hash ? { ...now, minedAt } : now));
      reload();
    })();
    return () => {
      stopped = true;
    };
    // Follows one call by its hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.hash]);

  useEffect(() => {
    if (pending?.minedAt === undefined) return;
    // A read that fails while catching up ends the wait with its own words, so no button stays disabled.
    if (resource.status === 'failed') {
      setPending(null);
      return setProblem(t('notRead'));
    }
    if (resource.status !== 'ready' || !data) return;
    if (BigInt(data.blockNumber) >= pending.minedAt) {
      if (pending.target === 'grant') setNotice(t('granted'));
      return setPending(null);
    }
    if (catchUp >= CATCH_UP_READS) {
      setPending(null);
      return setProblem(t('notRead'));
    }
    const timer = setTimeout(() => {
      setCatchUp((count) => count + 1);
      reload();
    }, CATCH_UP_EVERY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.minedAt, resource.status, data?.blockNumber, catchUp]);

  // The panic button works on the account itself, so it is offered whenever the account exists, whatever the list shows.
  const canRevokeAll = data?.deployed === true;
  return (
    <>
      {representation && (
        <RepresentationPanel
          address={owner}
          status={representation.status}
          api={api}
          onEnd={(end) => {
            const action = representation.action;
            setRepresentation(null);
            if (end.kind === 'accepted') void act(action);
            else if (end.kind === 'rejected') setProblem(t('rejected'));
            else if (end.kind === 'region') setProblem(t('refused_region'));
            else setProblem(end.message);
          }}
        />
      )}
      <p className="muted numeric">{t('account', { address: account })}</p>
      {data && <p className="muted">{t('asOf', { block: data.blockNumber, time: utcTime(data.blockTime), from: data.logsFromBlock })}</p>}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      <div className="actions">
        <Button
          disabled={pending !== null}
          onClick={() => {
            setProblem(null);
            setGrantProblem(null);
            setCreating(true);
          }}
        >
          {t('newKey')}
        </Button>{' '}
        <Button variant="secondary" disabled={!canRevokeAll || pending !== null} onClick={() => void act({ kind: 'revokeAll' })}>
          {t('revokeAll')}
        </Button>{' '}
        <span className="muted">{t('revokeAllNote')}</span>
      </div>
      {resource.status === 'loading' && <p role="status">{t('reading')}</p>}
      <KeysTable
        t={t}
        empty={data && !data.deployed ? t('accountNone') : t('empty')}
        keys={data?.keys ?? []}
        pending={pending}
        busy={pending !== null}
        onRevoke={(key) => void act({ kind: 'revoke', key })}
      />
      {notice && <p role="status">{notice}</p>}
      {problem && !creating && <p role="alert">{problem}</p>}
      {creating && (
        <NewKeyDialog
          onClose={() => setCreating(false)}
          onSubmit={(spec) => void act({ kind: 'grant', spec })}
          problem={grantProblem ?? problem}
          busy={pending !== null}
        />
      )}
    </>
  );
}

function NewKeyDialog({
  onClose,
  onSubmit,
  problem,
  busy,
}: {
  onClose: () => void;
  onSubmit: (spec: GrantSpec) => void;
  problem: string | null;
  busy: boolean;
}) {
  const { language } = usePreferences();
  const { t } = sessionCopy.forLocale(language);
  const [key, setKey] = useState('');
  const [target, setTarget] = useState('');
  const [selectors, setSelectors] = useState('');
  const [cap, setCap] = useState('0');
  const [hours, setHours] = useState('24');
  const [invalid, setInvalid] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const list = selectors
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const wei = toWei(cap);
    const h = /^\d{1,3}$/.test(hours.trim()) ? Number(hours.trim()) : NaN;
    if (!ADDRESS.test(key.trim())) return setInvalid(t('invalid_key'));
    if (!ADDRESS.test(target.trim())) return setInvalid(t('invalid_target'));
    if (list.length === 0 || !list.every((entry) => SELECTOR.test(entry))) return setInvalid(t('invalid_selectors'));
    if (wei === null) return setInvalid(t('invalid_cap'));
    if (!(h >= 1 && h <= MAX_HOURS)) return setInvalid(t('invalid_hours'));
    setInvalid(null);
    onSubmit({
      key: key.trim(),
      targets: [target.trim()],
      selectors: list.map((entry) => entry.toLowerCase()),
      spendLimitWei: wei,
      // Five minutes short of the 30-day limit at most, so a browser clock a little ahead of the chain's is never refused.
      validUntil: Math.floor(Date.now() / 1000) + Math.min(h * 3600, MAX_HOURS * 3600 - 300),
    });
  }
  return (
    <Dialog title={t('newKey')} onClose={onClose}>
      <form className="protocol-quote" onSubmit={submit}>
        <p className="muted">{t('newKeyNote')}</p>
        <Field label={t('keyLabel')} hint={t('keyHint')} value={key} onChange={(event) => setKey(event.target.value)} />
        <Field label={t('targetLabel')} value={target} onChange={(event) => setTarget(event.target.value)} />
        <Field
          label={t('selectorsLabel')}
          hint={t('selectorsHint')}
          value={selectors}
          onChange={(event) => setSelectors(event.target.value)}
        />
        <Field label={t('capLabel')} inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        <Field
          label={t('hoursLabel')}
          hint={t('hoursHint')}
          inputMode="numeric"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
        />
        {(invalid ?? problem) && <p role="alert">{invalid ?? problem}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>
            {t('grant')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
