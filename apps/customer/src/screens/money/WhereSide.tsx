import { Button, ButtonLink, PanelHead, Tag } from '@intafaced/ui/lit';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import { useSession } from '../../features/session';
import { useResource } from '../../shared/resource';
import { KeyValue, Stepper } from '@intafaced/ui/lit/templates';
import type { VenueDeposit } from '@intafaced/contracts/protocol-venue-account';
import { useWallet, WalletAccountLink } from '../../features/protocol';
import { shortAddress } from '../../features/protocol/wallet/eip1193';
import type { Resource } from '../../shared/resource';
import { isHiddenPath } from './deps';
import { whereCopy } from './where-it-sits-copy';

type T = ReturnType<typeof whereCopy.useCopy>['t'];

/** The venue's deposits as Assets reads them once (the Moving tile and Moving now share the one read). */
export type DepositsRead = Resource<{ value: readonly VenueDeposit[] }>;

/**
 * Assets' side column (the owner's Money target, 25 Nov): what is on its way into the venue account, step by step; where
 * a withdrawal goes; the wallet the person connected; the emergency freeze, kept in the Security room; and, at the foot,
 * the person's verification level. Each reads its own source and says so when it can't; nothing here is an address book
 * or a control the app does not have.
 */
export function WhereSide({ owner, deposits, t }: { owner: string; deposits: DepositsRead; t: T }) {
  return (
    <>
      <MovingNow deposits={deposits} t={t} />
      <WithdrawTo owner={owner} t={t} />
      <OwnWallet owner={owner} t={t} />
      <Emergency t={t} />
      <YourLevel t={t} />
    </>
  );
}

/** The steps of a deposit as the venue reports it: signed in the wallet, seen on chain while confirming, then credited. */
function depositStep(deposit: VenueDeposit): number {
  return deposit.status === 'credited' ? 3 : 1;
}

function MovingNow({ deposits, t }: { deposits: DepositsRead; t: T }) {
  const moving = deposits.status === 'ready' ? deposits.data.value.filter((d) => d.status === 'confirming') : [];
  const recent = deposits.status === 'ready' ? deposits.data.value.filter((d) => d.status !== 'confirming').slice(0, 2) : [];
  const steps = [t('Moving signed'), t('Moving on chain'), t('Moving credited')];
  return (
    <section className="lt-stack" aria-labelledby="where-moving-title" data-testid="assets-moving">
      <PanelHead
        title={<span id="where-moving-title">{t('Moving title')}</span>}
        aside={moving.length > 0 ? <Tag tone="warn">{t('Moving pending')}</Tag> : undefined}
      />
      {deposits.status === 'loading' ? <p className="lt-hint">{t('Moving reading')}</p> : null}
      {deposits.status === 'failed' ? <p className="lt-hint">{t('Moving unread')}</p> : null}
      {deposits.status === 'ready' && moving.length === 0 ? <p className="lt-hint">{t('Moving none')}</p> : null}
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

/**
 * Where a withdrawal from the venue account goes: the connected wallet, unless the person changes it at the withdrawal.
 * The launch model keeps no address book of its own, so there is no Add here. The supported assets and networks are linked
 * here, beside where money goes out (J-wallet-01 #5).
 */
function WithdrawTo({ owner, t }: { owner: string; t: T }) {
  return (
    <section className="lt-stack" aria-labelledby="where-withdraw-title" data-testid="assets-withdraw-to">
      <PanelHead title={<span id="where-withdraw-title">{t('Withdraw to title')}</span>} />
      <div className="lt-row lt-row-between lt-row-nowrap" data-testid="assets-withdraw-to-wallet">
        <span className="lt-stack lt-stack-tight money-where__address">
          <span>{t('Withdraw to wallet')}</span>
          <span className="lt-hint" title={owner}>
            {shortAddress(owner)}
          </span>
        </span>
        <Tag tone="up">{t('Withdraw to ready')}</Tag>
      </div>
      <p className="lt-hint">{t('Withdraw to note')}</p>
      {isHiddenPath('/uc/assets') ? null : (
        <a className="lt-hint" href="/uc/assets" aria-label={t('Supported assets')}>
          {t('Supported assets short')}
        </a>
      )}
    </section>
  );
}

/**
 * The wallet the person connected: its name as it announces itself, its whole address (the venue rooms name it
 * venue-wallet-address, and the journeys that open /money connect through it and match it exactly), and the one control.
 */
function OwnWallet({ owner, t }: { owner: string; t: T }) {
  const wallet = useWallet();
  return (
    <section className="lt-stack" aria-labelledby="where-own-wallet-title" data-testid="venue-wallet">
      <PanelHead title={<span id="where-own-wallet-title">{t('Own wallet title')}</span>} />
      <div className="lt-row lt-row-between lt-row-nowrap">
        <span className="lt-stack lt-stack-tight money-where__address">
          <span>{wallet.connected?.info.name ?? t('Own wallet unnamed')}</span>
          <span className="lt-hint">{shortAddress(owner)}</span>
          {/* The whole address once, small (the venue rooms name it venue-wallet-address; the journeys that open /money
              connect through it and match it exactly). */}
          <small className="lt-hint lt-wrap" data-testid="venue-wallet-address" data-address={owner}>
            {owner}
          </small>
        </span>
        <Tag tone="up">{t('Own wallet connected')}</Tag>
      </div>
      <p className="lt-hint">{t('Own wallet note')}</p>
      <WalletAccountLink address={owner} href={isHiddenPath('/wallet/venue') ? null : '/wallet/venue'} />
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

/**
 * The emergency freeze, as the Security room holds it: freezing needs the person's password and a reason, so the key here
 * opens that room rather than freezing from Assets. With the room not in this build, the words say where it is not.
 */
function Emergency({ t }: { t: T }) {
  const room = isHiddenPath('/uc/safe') ? null : '/uc/safe';
  return (
    <section className="lt-stack" aria-labelledby="where-emergency-title" data-testid="assets-emergency">
      <PanelHead title={<span id="where-emergency-title">{t('Emergency title')}</span>} />
      <p className="lt-hint">{t('Emergency note')}</p>
      {room ? (
        <ButtonLink tone="secondary" block href={room} data-testid="assets-freeze">
          {t('Freeze everything')}
        </ButtonLink>
      ) : (
        <p className="lt-refusal">{t('Freeze not here')}</p>
      )}
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

/** The person's level as a chip beside the title, one sentence under it, and the way to Verification; at the rail's foot. */
function YourLevel({ t }: { t: T }) {
  const { api, userId } = useSession();
  const { resource } = useResource((signal) => api.call(IDENTITY_KYC_STATUS, { limit: 1 }, { signal }), `where-level:${userId ?? ''}`);
  const room = isHiddenPath('/verification') ? null : '/verification';
  const level = resource.status === 'ready' ? resource.data : null;
  return (
    <section className="lt-stack" aria-labelledby="where-level-title" data-testid="assets-level">
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
