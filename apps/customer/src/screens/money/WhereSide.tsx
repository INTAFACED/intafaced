import { useMemo } from 'react';
import { Button, PanelHead, Tag } from '@intafaced/ui/lit';
import { KeyValue, Stepper } from '@intafaced/ui/lit/templates';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import type { VenueDeposit } from '@intafaced/contracts/protocol-venue-account';
import { useSession } from '../../features/session';
import { useWallet } from '../../features/protocol';
import { createVenueAccountApi } from '../../features/protocol/venue-wallet/venue-account-api';
import { useResource } from '../../shared/resource';
import { isHiddenPath } from './deps';
import { whereCopy } from './where-it-sits-copy';

type T = ReturnType<typeof whereCopy.useCopy>['t'];

/**
 * Assets' side column (owner's pick, 25 Nov: direction A, "Ledger"): what is on its way into the venue account, step by
 * step; where a withdrawal goes; and the person's verification level. Each reads its own source and says so when it can't.
 */
export function WhereSide({ owner, t }: { owner: string; t: T }) {
  return (
    <>
      <MovingNow owner={owner} t={t} />
      <WithdrawTo owner={owner} t={t} />
      <YourLevel t={t} />
    </>
  );
}

/** The steps of a deposit as the venue reports it: signed in the wallet, seen on chain while confirming, then credited. */
function depositStep(deposit: VenueDeposit): number {
  return deposit.status === 'credited' ? 3 : 1;
}

function MovingNow({ owner, t }: { owner: string; t: T }) {
  const { api } = useSession();
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const { resource } = useResource((signal) => account.deposits(owner, signal), `where-moving:${owner}`);
  const moving = resource.status === 'ready' ? resource.data.value.filter((d) => d.status === 'confirming') : [];
  const recent = resource.status === 'ready' ? resource.data.value.filter((d) => d.status !== 'confirming').slice(0, 2) : [];
  const steps = [t('Moving signed'), t('Moving on chain'), t('Moving credited')];
  return (
    <section className="lt-panel" aria-labelledby="where-moving-title" data-testid="assets-moving">
      <PanelHead
        title={<span id="where-moving-title">{t('Moving title')}</span>}
        aside={moving.length > 0 ? String(moving.length) : undefined}
      />
      {resource.status === 'loading' ? <p className="lt-hint">{t('Moving reading')}</p> : null}
      {resource.status === 'failed' ? <p className="lt-hint">{t('Moving unread')}</p> : null}
      {resource.status === 'ready' && moving.length === 0 ? <p className="lt-hint">{t('Moving none')}</p> : null}
      {moving.map((deposit) => (
        <div key={deposit.depositRef} className="lt-stack" data-deposit-status={deposit.status}>
          <KeyValue
            rows={[
              { label: t('Moving into venue'), value: `${deposit.amount} ${deposit.asset}` },
              {
                label: t('Moving confirmations'),
                value: t('Moving confirmations value', { n: String(deposit.confirmations), of: String(deposit.required) }),
              },
            ]}
          />
          <Stepper labels={steps} current={depositStep(deposit)} />
        </div>
      ))}
      {recent.length > 0 ? (
        <KeyValue
          label={t('Moving recent')}
          rows={recent.map((d) => ({
            label: `${d.amount} ${d.asset}`,
            value: d.status === 'credited' ? t('Moving done') : t('Moving not credited'),
          }))}
        />
      ) : null}
    </section>
  );
}

/** "0x71C2…9A4F": the start and end of an address, the way a person checks it against their wallet. */
function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Where a withdrawal from the venue account goes: the connected wallet, unless the person edits it at the withdrawal.
 * The face shows the address short; the full address is its title and is read out in full.
 */
function WithdrawTo({ owner, t }: { owner: string; t: T }) {
  const wallet = useWallet();
  return (
    <section className="lt-panel" aria-labelledby="where-withdraw-title" data-testid="assets-withdraw-to">
      <PanelHead title={<span id="where-withdraw-title">{t('Withdraw to title')}</span>} />
      <div className="lt-row lt-row-between lt-row-nowrap" data-testid="assets-withdraw-to-wallet">
        <span className="lt-stack lt-stack-tight">
          <span>{t('Withdraw to wallet')}</span>
          <span className="lt-mono lt-hint" title={owner} data-address={owner}>
            <span aria-hidden="true">{shortAddress(owner)}</span>
            <span className="lt-sr">{t('Withdraw to short', { address: owner })}</span>
          </span>
        </span>
        <Tag tone="up">{t('Withdraw to ready')}</Tag>
      </div>
      <p className="lt-hint">{t('Withdraw to note')}</p>
      {/* The wallet's one control on Assets: the connected address and network are above and in the wallet panel's fold. */}
      <div className="lt-actions">
        <Button tone="secondary" size="sm" onClick={wallet.disconnect} data-testid="assets-disconnect">
          {t('Disconnect')}
        </Button>
      </div>
      {wallet.problem ? (
        <p className="lt-refusal" role="alert">
          {wallet.problem}
        </p>
      ) : null}
    </section>
  );
}

const LEVEL_WORD = { none: 'Level none', basic: 'Level basic', full: 'Level full', institutional: 'Level institutional' } as const;
const LEVEL_SENTENCE = {
  none: 'Level none sentence',
  basic: 'Level basic sentence',
  full: 'Level full sentence',
  institutional: 'Level institutional sentence',
} as const;

/** The person's level as a chip beside the title, one sentence under it, and the way to Verification. */
function YourLevel({ t }: { t: T }) {
  const { api, userId } = useSession();
  const { resource } = useResource((signal) => api.call(IDENTITY_KYC_STATUS, { limit: 1 }, { signal }), `where-level:${userId ?? ''}`);
  const room = isHiddenPath('/verification') ? null : '/verification';
  const level = resource.status === 'ready' ? resource.data : null;
  return (
    <section className="lt-panel" aria-labelledby="where-level-title" data-testid="assets-level">
      <PanelHead
        title={<span id="where-level-title">{t('Level title')}</span>}
        aside={
          level ? (
            <Tag tone={level.tier === 'none' ? 'neutral' : 'up'} data-testid="assets-level-tier" data-tier={level.tier}>
              {t(LEVEL_WORD[level.tier])}
            </Tag>
          ) : undefined
        }
      />
      {level ? (
        <p className="lt-hint">
          {t(level.tier === 'basic' && level.tradingOnly ? 'Level basic trading sentence' : LEVEL_SENTENCE[level.tier])}{' '}
          {room ? <a href={room}>{t('Level open')}</a> : null}
        </p>
      ) : (
        <p className="lt-hint">{resource.status === 'loading' ? t('Level reading') : t('Level unread')}</p>
      )}
    </section>
  );
}
