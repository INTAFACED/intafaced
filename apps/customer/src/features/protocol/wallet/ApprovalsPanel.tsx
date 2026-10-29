import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProtocolAllowanceRow, ProtocolAllowances, ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
import { Button, DataTable, EmptyState, Failure, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE } from '../region';
import { formatUnits } from '../swap/swap-math';
import { walletCopy } from './copy';
import { RepresentationPanel } from './RepresentationPanel';
import { shortContract, tokenLabel } from './transfer';
import { useWallet } from './WalletProvider';

type Pending = { key: string; hash: string | null };
const rowKey = (row: Pick<ProtocolAllowanceRow, 'token' | 'spender'>) => `${row.token.toLowerCase()}:${row.spender.toLowerCase()}`;
/** How long a sent revoke is followed before the page says it was not mined in time. */
const REVOKE_FOLLOW_MS = 120_000;

/** What a row shows as its spender: a pool the factory lists by its pair, anything else by its address. */
export function spenderText(row: ProtocolAllowanceRow, tokens: readonly ProtocolSwapToken[], poolLabel: (pair: string) => string) {
  if (!row.pool) return row.spender;
  const symbol = (address: string) =>
    tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? shortContract(address);
  return `${poolLabel(`${symbol(row.pool.token0)}/${symbol(row.pool.token1)}`)} · ${shortContract(row.spender)}`;
}

/**
 * Approvals (D-swap-09): every live allowance the connected wallet has given for the tokens the network's pools trade, read
 * from the chain at one block, with Revoke per row. Revoke builds `approve(spender, 0)`, shows it on the plain-words sheet
 * and the person's wallet sends it; the row goes once the chain reads zero. No row is invented and none is kept locally.
 */
export function ApprovalsPanel() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const ready = wallet.status === 'connected' && wallet.address !== null && wallet.guard?.ok === true;
  const headers = [t('hdr_token'), t('hdr_spender'), t('hdr_allowance'), t('hdr_action')];
  return (
    <Panel title={t('section_approvals')}>
      {ready && wallet.address ? (
        <Allowances owner={wallet.address} headers={headers} />
      ) : (
        <DataTable label={t('section_approvals')} headers={headers}>
          <tr>
            <td colSpan={headers.length}>
              <EmptyState title={t('needsWallet')} />
            </td>
          </tr>
        </DataTable>
      )}
    </Panel>
  );
}

function Allowances({ owner, headers }: { owner: string; headers: string[] }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource, reload } = useResource((signal) => api.allowances(owner, signal), `wallet:approvals:${owner.toLowerCase()}`);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [representation, setRepresentation] = useState<{ row: ProtocolAllowanceRow; status: RepresentationStatus } | null>(null);
  const data: ProtocolAllowances | null = resource.status === 'ready' ? resource.data : null;

  const revoke = async (row: ProtocolAllowanceRow, token: ProtocolSwapToken | undefined) => {
    setProblem(null);
    setPending({ key: rowKey(row), hash: null });
    // Revoking is a signing action: the representation gate comes first and never fails open.
    const gate = await api.representationStatus(owner);
    if (!gate.ok) {
      setPending(null);
      return setProblem(
        t(
          gate.code === REGION_BLOCKED_CODE
            ? 'permitRefused_region'
            : gate.code === 'compliance.representation_unset'
              ? 'permitRefused_representation_unset'
              : 'permitRefused_representation_unavailable',
        ),
      );
    }
    if (!gate.data.accepted) {
      setPending(null);
      return setRepresentation({ row, status: gate.data });
    }
    const call = await api.buildRevoke({ token: row.token, spender: row.spender });
    if (!call.ok) {
      setPending(null);
      return setProblem(t('revokeBuildFailed'));
    }
    const name = token?.name ?? row.token;
    const result = await wallet.sendSequence({
      title: t('revokeSteps'),
      steps: [
        {
          label: t('revokeStep', { token: name, spender: row.spender }),
          request: { kind: 'transaction', to: call.data.to, data: call.data.data },
        },
      ],
      facts: [
        { label: t('revokeFactToken'), value: row.token },
        { label: t('revokeFactSpender'), value: row.spender },
      ],
    });
    if (result.status !== 'sent') {
      setPending(null);
      return setProblem(result.status === 'rejected' ? t('revokeRejected') : result.message);
    }
    setPending({ key: rowKey(row), hash: result.hashes[result.hashes.length - 1]! });
  };

  // A sent revoke is followed until it is mined; then the list is read again from the chain, and the row goes when it
  // reads zero. A revert says so and leaves the row.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    const hash = pending?.hash;
    if (!hash) return;
    let stopped = false;
    const until = Date.now() + REVOKE_FOLLOW_MS;
    const timer = setInterval(() => {
      void (async () => {
        if (stopped || pendingRef.current?.hash !== hash) return;
        if (Date.now() > until) {
          stopped = true;
          setPending(null);
          return setProblem(t('revokeNotMined'));
        }
        const receipt = (await wallet.read('eth_getTransactionReceipt', [hash])) as { status?: string } | null;
        if (stopped || !receipt?.status) return;
        stopped = true;
        setPending(null);
        if (receipt.status === '0x1') reload();
        else setProblem(t('revokeReverted'));
      })();
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // Follows one revoke by its hash; the rest is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.hash]);

  const tokens = data?.tokens ?? [];
  return (
    <>
      {representation && (
        <RepresentationPanel
          address={owner}
          status={representation.status}
          api={api}
          onEnd={(end) => {
            const row = representation.row;
            setRepresentation(null);
            if (end.kind === 'accepted')
              void revoke(
                row,
                tokens.find((token) => token.address.toLowerCase() === row.token.toLowerCase()),
              );
            else if (end.kind === 'rejected') setProblem(t('revokeRejected'));
            else if (end.kind === 'region') setProblem(t('permitRefused_region'));
            else setProblem(end.message);
          }}
        />
      )}
      {data && <p className="muted">{t('approvalsNote', { block: data.blockNumber, from: data.logsFromBlock })}</p>}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      <DataTable label={t('section_approvals')} headers={headers}>
        {resource.status === 'loading' && (
          <tr>
            <td colSpan={headers.length}>
              <p role="status">{t('approvalsReading')}</p>
            </td>
          </tr>
        )}
        {data && data.rows.length === 0 && (
          <tr>
            <td colSpan={headers.length}>
              <EmptyState title={t('empty_approvals')} />
            </td>
          </tr>
        )}
        {data?.rows.map((row) => {
          const token = tokens.find((entry) => entry.address.toLowerCase() === row.token.toLowerCase());
          const busy = pending?.key === rowKey(row);
          return (
            <tr key={rowKey(row)}>
              <td>
                {token ? tokenLabel(token, tokens) : row.token}
                <br />
                <small className="muted numeric">{shortContract(row.token)}</small>
              </td>
              <td className="numeric">{spenderText(row, tokens, (pair) => t('approvalPool', { pair }))}</td>
              <td className="numeric">
                {row.unlimited
                  ? t('approvalUnlimited')
                  : token
                    ? `${formatUnits(BigInt(row.allowance), token.decimals, token.decimals)} ${token.symbol}`
                    : row.allowance}
              </td>
              <td>
                {busy && pending?.hash ? (
                  <span role="status">{t('revoking')}</span>
                ) : (
                  <Button variant="secondary" disabled={pending !== null} onClick={() => void revoke(row, token)}>
                    {t('revoke')}
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </DataTable>
      {data && data.unread > 0 && <p className="muted">{t('approvalsUnread', { count: String(data.unread) })}</p>}
      {data?.truncated && <p className="muted">{t('approvalsTruncated')}</p>}
      {problem && <p role="alert">{problem}</p>}
    </>
  );
}
