import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  NAVIGATOR_ONCHAIN_TEST_CHAIN_ID,
  navigatorOnchainBindingReadSchema,
  navigatorOnchainBindingSchema,
  navigatorOnchainSignerSchema,
  type NavigatorOnchainBinding,
} from '@intafaced/contracts/agents-onchain';
import type { ProtocolSessionKey, ProtocolSessionsList } from '@intafaced/contracts/protocol-sessions';
import { Button, Failure, Field } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { useApi } from '../session/session';
import { createProtocolApi, type ProtocolApi, type RepresentationStatus } from '../protocol/api';
import { REGION_BLOCKED_CODE } from '../protocol/region';
import { WALLET_SECTIONS } from '../protocol/routes';
import { formatUnits } from '../protocol/swap/swap-math';
import { isFactoryUnset } from '../protocol/wallet/AccountsPanel';
import { RepresentationPanel } from '../protocol/wallet/RepresentationPanel';
import { toWei, utcTime } from '../protocol/wallet/SessionKeysPanel';
import { useWallet, waitMined, WalletProvider } from '../protocol/wallet/WalletProvider';
import { Select } from './common';
import { navigatorOnchainCopy } from './navigator-onchain-copy';

type T = ReturnType<typeof navigatorOnchainCopy.forLocale>['t'];
type Agents = ReturnType<typeof useApi>;

/** The router's `swapExactIn(address,address,uint256,uint256,address)`: the Navigator's one default call. */
export const NAVIGATOR_DEFAULT_SELECTOR = '0x7b32b50e';
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const FOLLOW_MS = 120_000;
const CATCH_UP_EVERY_MS = 1_000;
const CATCH_UP_READS = 30;
/** The choices of expiry, in seconds. The longest stays 5 minutes under the 30-day limit, so a clock a little ahead of the chain's is never refused. */
export const EXPIRY_SECONDS = { '1h': 3_600, '1d': 86_400, '7d': 604_800, '30d': 2_592_000 - 300 } as const;
type Expiry = keyof typeof EXPIRY_SECONDS;
/** Allowlist codes the signer read can answer with, drawn by the shared service-off notice. */
const SERVICE_OFF = ['rail.crypto', 'audit.external'] as const;

/** What the panel shows for the key, read from the chain, with the person's revoke request from the binding. */
export type KeyStatus = 'none' | 'active' | 'later' | 'expired' | 'revoking' | 'revoked';
export function keyStatus(binding: NavigatorOnchainBinding, key: ProtocolSessionKey | null): KeyStatus {
  if (!key) return 'none';
  if (key.status === 'revoked') return 'revoked';
  if (key.status === 'expired') return 'expired';
  if (binding.revokeRequestedAt) return 'revoking';
  return key.status === 'not_yet_valid' ? 'later' : 'active';
}

/** True when the key on the chain carries exactly the scope, cap and expiry the binding recorded. */
export function sameGrant(binding: NavigatorOnchainBinding, key: ProtocolSessionKey): boolean {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((entry) => b.some((other) => other.toLowerCase() === entry.toLowerCase()));
  return (
    same(binding.targets, key.targets) &&
    same(binding.selectors, key.selectors) &&
    binding.spendLimitWei === key.spendLimitWei &&
    binding.validUntil === key.validUntil
  );
}

/**
 * The Navigator's on-chain access in its details (RC-agents-01, J-agents-19): a scoped, expiring session key the person
 * grants on their own smart account and can revoke. Its own wallet connection, restored without a prompt from the one the
 * person made in Wallet. The person signs the grant and the revoke; nothing here holds a key or moves value.
 */
export function NavigatorOnChain() {
  return (
    <WalletProvider scope="agents-onchain">
      <OnChainPanel />
    </WalletProvider>
  );
}

function OnChainPanel() {
  const { t } = navigatorOnchainCopy.useCopy();
  const wallet = useWallet();
  const connected = wallet.status === 'connected' && wallet.address !== null;
  return (
    <section aria-label={t('title')} className="navigator-onchain">
      <h4>{t('title')}</h4>
      <p className="muted">{t('intro')}</p>
      <p role="note">
        <strong>{t('ceiling')}</strong> {t('ceilingRule')}
      </p>
      {!connected || !wallet.address ? (
        <p role="status">
          {t('needsWallet')} <a href={WALLET_SECTIONS.overview}>{t('openWallet')}</a>
        </p>
      ) : !wallet.guard?.ok || wallet.chainId === null ? (
        <p role="status">
          {t('wrongNetwork')} <a href={WALLET_SECTIONS.overview}>{t('openWallet')}</a>
        </p>
      ) : (
        <OnChainSigner owner={wallet.address} chainId={wallet.chainId} />
      )}
    </section>
  );
}

function OnChainSigner({ owner, chainId }: { owner: string; chainId: number }) {
  const { t } = navigatorOnchainCopy.useCopy();
  const agents = useApi();
  const protocol = useMemo(() => createProtocolApi(agents), [agents]);
  const signer = useResource(
    (signal) => agents.query('agents', 'navigator.onchain.signer', { chainId }, navigatorOnchainSignerSchema, { signal }),
    `navigator-onchain:signer:${chainId}`,
  );
  const account = useResource((signal) => protocol.predictAccount(owner, signal), `navigator-onchain:account:${owner.toLowerCase()}`);
  const testnet = chainId === NAVIGATOR_ONCHAIN_TEST_CHAIN_ID;
  const label = testnet ? (
    <p>
      <span className="pill" data-network="testnet">
        {t('testnet')}
      </span>{' '}
      <span className="muted">{t('testnetNote')}</span>
    </p>
  ) : null;
  if (signer.resource.status === 'loading' || account.resource.status === 'loading')
    return (
      <>
        {label}
        <p role="status">{t('reading')}</p>
      </>
    );
  if (signer.resource.status === 'failed') {
    const failure = signer.resource.failure;
    const off = SERVICE_OFF.find((code) => code === failure.message || code === failure.code);
    return (
      <>
        {label}
        {off ? <ServiceOffNotice code={off} action={t('actionGrant')} /> : <Failure result={failure} retry={signer.reload} />}
      </>
    );
  }
  if (account.resource.status === 'failed')
    return (
      <>
        {label}
        {isFactoryUnset(account.resource.failure.message) ? (
          <p role="status">{t('factoryUnset')}</p>
        ) : (
          <Failure result={account.resource.failure} retry={account.reload} />
        )}
      </>
    );
  if (!account.resource.data.deployed)
    return (
      <>
        {label}
        <p role="status">
          {t('accountNone')} <a href={WALLET_SECTIONS.accounts}>{t('openAccounts')}</a>
        </p>
      </>
    );
  return (
    <>
      {label}
      <OnChainControls
        owner={owner}
        chainId={chainId}
        account={account.resource.data.address}
        signer={signer.resource.data.signer}
        pools={signer.resource.data.pools}
        marketRouter={signer.resource.data.router}
        agents={agents}
        protocol={protocol}
      />
    </>
  );
}

type Call = { kind: 'grant' | 'revoke'; to: string; data: string };
type Pending = { kind: 'grant' | 'revoke'; hash: string; minedAt?: bigint };

function OnChainControls({
  owner,
  chainId,
  account,
  signer,
  pools,
  marketRouter,
  agents,
  protocol,
}: {
  owner: string;
  chainId: number;
  account: string;
  signer: string;
  pools: readonly string[];
  marketRouter: string | null;
  agents: Agents;
  protocol: ProtocolApi;
}) {
  const { t } = navigatorOnchainCopy.useCopy();
  const wallet = useWallet();
  const bindingRead = useResource(
    (signal) => agents.query('agents', 'navigator.onchain.binding', { chainId, account }, navigatorOnchainBindingReadSchema, { signal }),
    `navigator-onchain:binding:${chainId}:${account.toLowerCase()}`,
  );
  const chainRead = useResource((signal) => protocol.sessionsList(account, signal), `navigator-onchain:sessions:${account.toLowerCase()}`);
  const deployments = useResource((signal) => protocol.deploymentsList(chainId, signal), `navigator-onchain:deployments:${chainId}`);
  // A reload keeps the last reads, so the key never blinks out while the chain is read again.
  const [binding, setBinding] = useState<NavigatorOnchainBinding | null | undefined>(undefined);
  const [chain, setChain] = useState<ProtocolSessionsList | null>(null);
  useEffect(() => {
    if (bindingRead.resource.status === 'ready') setBinding(bindingRead.resource.data.binding);
  }, [bindingRead.resource]);
  useEffect(() => {
    if (chainRead.resource.status === 'ready') setChain(chainRead.resource.data);
  }, [chainRead.resource]);

  const [cap, setCap] = useState('');
  const [calls, setCalls] = useState('');
  const [expiry, setExpiry] = useState<Expiry | ''>('');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [catchUp, setCatchUp] = useState(0);
  const [representation, setRepresentation] = useState<{ call: Call; status: RepresentationStatus } | null>(null);

  // The router the Navigator trades through, when its market is set; otherwise the network's published router.
  const router =
    marketRouter ??
    (deployments.resource.status === 'ready'
      ? (deployments.resource.data.routers.find((row) => row.name === 'SovereignRouter' && row.sunsetAt === null)?.address ?? null)
      : null);
  const key = chain?.keys.find((entry) => entry.key.toLowerCase() === signer.toLowerCase()) ?? null;
  const status = binding ? keyStatus(binding, key) : null;

  // A revoke asked but not signed (after a reload, say) offers its unsigned call again.
  useEffect(() => {
    if (status !== 'revoking' || call || pending || busy) return;
    void (async () => {
      const built = await protocol.buildSessionRevoke({ account, sessionKey: signer });
      if (built.ok) setCall({ kind: 'revoke', to: built.data.to, data: built.data.data });
    })();
    // Builds once per revoking read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function prepare(event: FormEvent) {
    event.preventDefault();
    setFormProblem(null);
    setProblem(null);
    setNotice(null);
    if (!cap.trim()) return setFormProblem(t('capRequired'));
    const wei = toWei(cap);
    if (wei === null) return setFormProblem(t('capInvalid'));
    const extra = calls
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!extra.every((entry) => SELECTOR.test(entry))) return setFormProblem(t('callsInvalid'));
    if (!expiry) return setFormProblem(t('expiryRequired'));
    if (!router) return setFormProblem(t('routerUnset'));
    const selectors = [...new Set([NAVIGATOR_DEFAULT_SELECTOR, ...extra.map((entry) => entry.toLowerCase())])];
    const spec = {
      key: signer,
      // The router and the Navigator's pools: a session key reaches only the pools in its own targets.
      targets: [router, ...pools],
      selectors,
      spendLimitWei: wei,
      validUntil: Math.floor(Date.now() / 1000) + EXPIRY_SECONDS[expiry],
    };
    setBusy(true);
    setCall(null);
    try {
      const built = await protocol.buildSessionGrant({ account, spec });
      if (!built.ok)
        return setFormProblem(
          /may never be granted/.test(built.message) ? t('refusedPower') : t('refusedScope', { reason: built.message }),
        );
      const bound = await agents.mutate(
        'agents',
        'navigator.onchain.bind',
        {
          chainId,
          account,
          specHash: built.data.specHash,
          spendLimitWei: spec.spendLimitWei,
          validUntil: built.data.validUntil,
          targets: spec.targets,
          selectors: spec.selectors,
        },
        navigatorOnchainBindingSchema,
      );
      if (!bound.ok) return setFormProblem(t('notRecorded', { reason: bound.message }));
      setBinding(bound.data);
      setCall({ kind: 'grant', to: built.data.to, data: built.data.data });
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setProblem(null);
    setNotice(null);
    setBusy(true);
    try {
      const asked = await agents.mutate('agents', 'navigator.onchain.revoke', { chainId, account }, navigatorOnchainBindingSchema);
      if (!asked.ok) return setProblem(asked.message);
      setBinding(asked.data);
      const built = await protocol.buildSessionRevoke({ account, sessionKey: signer });
      if (!built.ok) return setProblem(built.message);
      setCall({ kind: 'revoke', to: built.data.to, data: built.data.data });
    } finally {
      setBusy(false);
    }
  }

  /** The representation gate first, which never fails open; then the person's wallet sends the call. */
  async function sign(current: Call) {
    setProblem(null);
    setNotice(null);
    setBusy(true);
    try {
      const gate = await protocol.representationStatus(owner);
      if (!gate.ok)
        return setProblem(
          t(
            gate.code === REGION_BLOCKED_CODE
              ? 'refused_region'
              : gate.code === 'compliance.representation_unset'
                ? 'refused_representation_unset'
                : 'refused_representation_unavailable',
          ),
        );
      if (!gate.data.accepted) return setRepresentation({ call: current, status: gate.data });
      const facts =
        current.kind === 'grant'
          ? [
              { label: t('factAccount'), value: account },
              { label: t('factKey'), value: signer },
              { label: t('factCap'), value: `${cap} TEST ETH` },
            ]
          : [
              { label: t('factAccount'), value: account },
              { label: t('factKey'), value: signer },
              { label: t('factEffect'), value: t('factEffectRevoke') },
            ];
      const result = await wallet.sendSequence({
        title: current.kind === 'grant' ? t('grantSteps') : t('revokeSteps'),
        steps: [
          {
            label: current.kind === 'grant' ? t('grantStep', { key: signer }) : t('revokeStep', { key: signer }),
            request: { kind: 'transaction', to: current.to, data: current.data },
          },
        ],
        facts,
      });
      if (result.status !== 'sent') return setProblem(result.status === 'rejected' ? t('rejected') : result.message);
      setCatchUp(0);
      setPending({ kind: current.kind, hash: result.hashes[result.hashes.length - 1]! });
    } finally {
      setBusy(false);
    }
  }

  // A sent call is followed until it is mined; then the chain is read again until its block reaches the call's.
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
      if (mined.status !== 'success') {
        setPending(null);
        return setProblem(t(mined.status === 'timeout' ? 'notMined' : 'reverted'));
      }
      const minedAt = mined.blockNumber ?? BigInt(String(await wallet.read('eth_blockNumber', [])));
      if (stopped) return;
      setPending((now) => (now?.hash === hash ? { ...now, minedAt } : now));
      chainRead.reload();
    })();
    return () => {
      stopped = true;
    };
    // Follows one call by its hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.hash]);

  useEffect(() => {
    if (pending?.minedAt === undefined) return;
    if (chainRead.resource.status === 'failed') {
      setPending(null);
      return setProblem(t('notRead'));
    }
    if (chainRead.resource.status !== 'ready') return;
    if (BigInt(chainRead.resource.data.blockNumber) >= pending.minedAt) {
      setNotice(t(pending.kind === 'grant' ? 'done_grant' : 'done_revoke'));
      setCall(null);
      bindingRead.reload();
      return setPending(null);
    }
    if (catchUp >= CATCH_UP_READS) {
      setPending(null);
      return setProblem(t('notRead'));
    }
    const timer = setTimeout(() => {
      setCatchUp((count) => count + 1);
      chainRead.reload();
    }, CATCH_UP_EVERY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.minedAt, chainRead.resource.status, catchUp]);

  const locked = busy || pending !== null;
  return (
    <>
      {representation && (
        <RepresentationPanel
          address={owner}
          status={representation.status}
          api={protocol}
          onEnd={(end) => {
            const next = representation.call;
            setRepresentation(null);
            if (end.kind === 'accepted') void sign(next);
            else if (end.kind === 'rejected') setProblem(t('rejected'));
            else if (end.kind === 'region') setProblem(t('refused_region'));
            else setProblem(end.message);
          }}
        />
      )}
      <p className="muted numeric">{t('signer', { address: signer })}</p>
      <p className="muted numeric">{t('account', { address: account })}</p>
      <form aria-label={t('formLabel')} className="protocol-quote" onSubmit={(event) => void prepare(event)} noValidate>
        <Field label={t('capLabel')} hint={t('capHint')} inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        <Field label={t('callsLabel')} hint={t('callsHint')} value={calls} onChange={(event) => setCalls(event.target.value)} />
        <p className="muted numeric">
          {router
            ? t('defaultCall', { selector: NAVIGATOR_DEFAULT_SELECTOR, router })
            : deployments.resource.status === 'loading'
              ? t('reading')
              : t('routerUnset')}
        </p>
        <Select
          label={t('expiresLabel')}
          value={expiry}
          onChange={(value) => setExpiry(value as Expiry | '')}
          options={[
            { value: '', label: t('expiresChoose') },
            { value: '1h', label: t('expires_1h') },
            { value: '1d', label: t('expires_1d') },
            { value: '7d', label: t('expires_7d') },
            { value: '30d', label: t('expires_30d') },
          ]}
        />
        {formProblem && <p role="alert">{formProblem}</p>}
        <div className="actions">
          <Button type="submit" disabled={locked}>
            {t('prepare')}
          </Button>
        </div>
      </form>
      {binding && status && <KeyFacts t={t} binding={binding} chain={chain} chainKey={key} status={status} />}
      {chainRead.resource.status === 'failed' && <Failure result={chainRead.resource.failure} retry={chainRead.reload} />}
      {binding && (status === 'active' || status === 'later' || status === 'revoking') && (
        <div className="actions">
          <Button variant="secondary" disabled={locked} onClick={() => void revoke()}>
            {t('revoke')}
          </Button>{' '}
          <span className="muted">{t('revokeNote')}</span>
        </div>
      )}
      {call && (
        <div className="navigator-onchain-call">
          <h5>{t('callTitle')}</h5>
          <p>{t(call.kind === 'grant' ? 'callGrant' : 'callRevoke')}</p>
          <dl>
            <dt>{t('callTo')}</dt>
            <dd className="numeric">
              <code lang="zxx">{call.to}</code>
            </dd>
            <dt>{t('callData')}</dt>
            <dd className="numeric">
              <code data-testid="unsigned-call" lang="zxx" className="navigator-onchain-data">
                {call.data}
              </code>
            </dd>
          </dl>
          <Button disabled={locked} onClick={() => void sign(call)}>
            {t('sign')}
          </Button>
        </div>
      )}
      {pending && <p role="status">{t('waiting')}</p>}
      {notice && <p role="status">{notice}</p>}
      {problem && <p role="alert">{problem}</p>}
    </>
  );
}

function KeyFacts({
  t,
  binding,
  chain,
  chainKey,
  status,
}: {
  t: T;
  binding: NavigatorOnchainBinding;
  chain: ProtocolSessionsList | null;
  chainKey: ProtocolSessionKey | null;
  status: KeyStatus;
}) {
  // The chain's own record when it has one; until then what was prepared here, said to be only that.
  const source = chainKey ?? binding;
  const prepared = chainKey ? '' : ` (${t('preparedOnly')})`;
  return (
    <div className="navigator-onchain-key">
      <h5>{t('bindingTitle')}</h5>
      <dl>
        <dt>{t('termScope')}</dt>
        <dd className="numeric">{t('scope', { selectors: source.selectors.join(', '), targets: source.targets.join(', ') }) + prepared}</dd>
        <dt>{t('termExpiry')}</dt>
        <dd className="numeric">{utcTime(new Date(source.validUntil * 1000).toISOString()) + prepared}</dd>
        <dt>{t('termStatus')}</dt>
        <dd>
          <span data-testid="binding-status">{t(`status_${status}`)}</span>
        </dd>
        <dt>{t('termSpent')}</dt>
        <dd className="numeric">
          {t('spent', {
            spent: chainKey ? formatUnits(BigInt(chainKey.spentWei), 18, 18) : '0',
            cap: formatUnits(BigInt(source.spendLimitWei), 18, 18),
          }) + prepared}
        </dd>
      </dl>
      {chainKey && !sameGrant(binding, chainKey) && <p role="note">{t('otherScope')}</p>}
      {chain && <p className="muted">{t('asOf', { block: chain.blockNumber, time: utcTime(chain.blockTime) })}</p>}
    </div>
  );
}
