// volt-room: /campaigns/drops
import { useState } from 'react';
import { type DropReward, type DropView, type TgeNetwork, type TgeView } from '@intafaced/contracts/campaigns-drops';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate, FirstState, KeyValue } from '@intafaced/ui/lit/templates';
import { t as copyText } from './copy';
import { dropRoomCopy } from './drop-room-copy';
import { EmptyNote, FailureNote, ScrollTable, Section, Waiting } from './volt-parts';
import { Sparkles } from 'lucide-react';
import { IDENTITY_WAITLIST_MINE } from '@intafaced/contracts/identity-waitlist-procedures';
import { CAMPAIGNS_DROPS_ROOM, CAMPAIGNS_DROPS_CLAIM } from '@intafaced/contracts/campaigns-drops-procedures';
import { CAMPAIGNS_TGE_CLAIM } from '@intafaced/contracts/campaigns-tge-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

/** Refusals this room puts into its own words; any other failure goes to the shared Failure. */
const ROOM_CODES = ['drop.sold_out', 'drop.not_open', 'drop.unknown', 'launch.schedule_unset', 'audit.external', 'chain.go'] as const;
type RoomCode = (typeof ROOM_CODES)[number];
const roomCode = (code: string | undefined): RoomCode | null =>
  (ROOM_CODES as readonly string[]).find((c) => c === code) as RoomCode | null;

const when = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

type Outcome = { ok: true } | { ok: false; failure: Extract<ApiResult<unknown>, { ok: false }> };

/**
 * The drop room, /campaigns/drops (RC-campaigns-05, J-campaigns-20 #4-#6): my waitlist rank and wave, the season and my
 * points, each limited drop with its claim control, and the TGE panel. Every control is shown; one that cannot run
 * refuses by name. After any claim answer, or none, the room reads the stored state again: a claim is never repeated
 * under a new key (the key is the drop and the account).
 */
export function DropRoom() {
  const api = useApi();
  const { t } = dropRoomCopy.useCopy();
  const waitlist = useResource((signal) => api.call(IDENTITY_WAITLIST_MINE, undefined, { signal }), 'drops-waitlist');
  const room = useResource((signal) => api.call(CAMPAIGNS_DROPS_ROOM, undefined, { signal }), 'drops-room');
  // Kept here, not in the row: the room reads its state again after every claim, which remounts the rows.
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({});

  return (
    <CatalogueTemplate
      title={copyText('moreroutes.drop.room')}
      description={copyText('moreroutes.drop.room.description')}
      state={{ kind: 'ready' }}
      items={
        <div data-testid="drop-room">
          <Section title={t('waitlistTitle')}>
            <div data-testid="drop-waitlist">
              {waitlist.resource.status === 'loading' ? (
                <Waiting label={t('waitlistLoading')} />
              ) : waitlist.resource.status === 'failed' ? (
                waitlist.resource.failure.code === 'waitlist.email_unverified' ? (
                  <p role="status">{t('waitlistUnverified')}</p>
                ) : (
                  <FailureNote result={waitlist.resource.failure} retry={waitlist.reload} />
                )
              ) : waitlist.resource.data === null ? (
                <EmptyNote title={t('waitlistNone')}>{t('waitlistNoneBody')}</EmptyNote>
              ) : (
                <KeyValue
                  rows={[
                    {
                      label: t('rank'),
                      value: (
                        <span data-testid="drop-rank">
                          {waitlist.resource.data.rank === null
                            ? '—'
                            : t('rankValue', {
                                rank: String(waitlist.resource.data.rank),
                                waiting: String(waitlist.resource.data.waiting),
                              })}
                        </span>
                      ),
                    },
                    {
                      label: t('wave'),
                      value: (
                        <span data-testid="drop-wave">
                          {waitlist.resource.data.release
                            ? t('waveReleased', { wave: String(waitlist.resource.data.release.waveNumber) })
                            : t('waveWaiting')}
                        </span>
                      ),
                    },
                    { label: t('friends'), value: <span data-testid="drop-referred">{waitlist.resource.data.referredCount}</span> },
                  ]}
                />
              )}
            </div>
          </Section>
          {room.resource.status === 'loading' ? (
            <Section title={t('seasonTitle')}>
              <Waiting label={t('seasonLoading')} />
            </Section>
          ) : room.resource.status === 'failed' ? (
            <Section title={t('seasonTitle')}>
              <FailureNote result={room.resource.failure} retry={room.reload} />
            </Section>
          ) : (
            <>
              <Season season={room.resource.data.season} />
              <Drops
                drops={room.resource.data.drops}
                outcomes={outcomes}
                settle={(dropId, outcome) => {
                  setOutcomes((all) => ({ ...all, [dropId]: outcome }));
                  room.reload();
                }}
              />
              <Tge tge={room.resource.data.tge} />
            </>
          )}
        </div>
      }
    />
  );
}

function Season({ season }: { season: ProcedureOutput<typeof CAMPAIGNS_DROPS_ROOM>['season'] }) {
  const { t } = dropRoomCopy.useCopy();
  return (
    <Section title={t('seasonTitle')}>
      <div data-testid="drop-season">
        {season === null ? (
          <FirstState
            icon={<Sparkles size={24} />}
            title={t('seasonNone')}
            body={t('seasonNoneBody')}
            points={[t('firstPointPoints'), t('firstPointDrops'), t('firstPointMoney')]}
            action={{ label: t('firstAction'), href: '/campaigns' }}
          />
        ) : (
          <KeyValue
            rows={[
              { label: t('seasonName'), value: <span data-testid="drop-season-name">{season.name}</span> },
              { label: t('seasonWindow'), value: t('seasonWindowValue', { start: when(season.startsAt), end: when(season.endsAt) }) },
              { label: t('seasonState'), value: t(season.state) },
              season.pointsBlocker
                ? {
                    label: t('points'),
                    value: (
                      <span data-testid="drop-season-points" data-state="not_running" data-code={season.pointsBlocker}>
                        {t('pointsNotRunning')} <code lang="zxx">{season.pointsBlocker}</code>
                      </span>
                    ),
                    note: t('pointsBlocked'),
                  }
                : {
                    label: t('points'),
                    value: <span data-testid="drop-season-points">{season.points}</span>,
                    note: t('pointsNote', { count: String(season.taskCampaigns) }),
                  },
            ]}
          />
        )}
      </div>
    </Section>
  );
}

type Settle = (dropId: string, outcome: Outcome) => void;

function Drops({ drops, outcomes, settle }: { drops: readonly DropView[]; outcomes: Readonly<Record<string, Outcome>>; settle: Settle }) {
  const { t } = dropRoomCopy.useCopy();
  return (
    <Section title={t('dropsTitle')}>
      {drops.length === 0 ? (
        <EmptyNote title={t('dropsNone')} />
      ) : (
        <ScrollTable label={t('dropsLabel')} headers={[t('dropName'), t('dropValue'), t('dropLeft'), t('dropState'), t('dropAction')]}>
          {drops.map((drop) => (
            <DropRow key={drop.id} drop={drop} outcome={outcomes[drop.id] ?? null} settle={settle} />
          ))}
        </ScrollTable>
      )}
      <p className="lt-hint">{t('entitlement')}</p>
    </Section>
  );
}

function DropRow({ drop, outcome, settle }: { drop: DropView; outcome: Outcome | null; settle: Settle }) {
  const api = useApi();
  const { t } = dropRoomCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const claim = async () => {
    setBusy(true);
    const result = await api.call(CAMPAIGNS_DROPS_CLAIM, { dropId: drop.id });
    setBusy(false);
    settle(drop.id, result.ok ? { ok: true } : { ok: false, failure: result });
  };
  return (
    <tr data-testid="drop-row" data-drop-id={drop.id}>
      <th scope="row">{drop.title}</th>
      <td data-align="end" data-testid="drop-value">
        {drop.value ? t('valueAmount', { amount: drop.value.amount, asset: drop.value.asset }) : t('valueNone')}
      </td>
      <td data-align="end" data-testid="drop-left">
        {t('dropLeftValue', { remaining: String(drop.remaining), count: String(drop.count) })}
      </td>
      <td data-testid="drop-state">{t(drop.state)}</td>
      <td>
        {drop.mine ? (
          <span data-testid="drop-claimed">
            {t('claimed')} · {when(drop.mine.claimedAt)}
            {drop.mine.reward ? <RewardLine reward={drop.mine.reward} /> : null}
          </span>
        ) : (
          <Button tone="primary" onClick={() => void claim()} disabled={busy} aria-label={t('claim', { title: drop.title })}>
            {busy ? t('claiming') : t('dropAction')}
          </Button>
        )}
        {outcome && !outcome.ok && stillTrue(outcome.failure.code, drop) ? (
          <Refusal failure={outcome.failure} testId="drop-refusal" />
        ) : null}
      </td>
    </tr>
  );
}

/** States in which a claimed drop's reward will not be paid. */
const NOT_PAID: readonly DropReward['state'][] = ['failed', 'forfeited', 'withheld', 'cancelled'];

/** A claimed drop's reward: owed until its payment is booked, then the wallet and the chain transaction that paid it. */
function RewardLine({ reward }: { reward: DropReward }) {
  const { t } = dropRoomCopy.useCopy();
  const amount = { amount: reward.amount, asset: reward.asset };
  return (
    <span data-testid="drop-reward" data-state={reward.state} data-tx={reward.chainTx ?? undefined} data-pay-to={reward.payTo ?? undefined}>
      {' · '}
      {reward.chainTx && reward.payTo
        ? t('rewardPaid', { ...amount, wallet: reward.payTo })
        : NOT_PAID.includes(reward.state)
          ? t('rewardNotPaid', { state: reward.state })
          : reward.payTo
            ? t('rewardOwed', amount)
            : t('rewardNoWallet', amount)}
    </span>
  );
}

/** A refusal stays under its row only while the stored state, read again after the claim, still agrees with it. */
function stillTrue(code: string | undefined, drop: DropView): boolean {
  if (drop.mine) return false;
  if (code === 'drop.sold_out') return drop.state === 'sold_out';
  if (code === 'drop.not_open') return drop.state === 'not_open' || drop.state === 'closed';
  return true;
}

function Tge({ tge }: { tge: TgeView }) {
  const { t } = dropRoomCopy.useCopy();
  return (
    <Section title={t('tgeTitle')}>
      <div data-testid="drop-tge">
        <KeyValue
          rows={[
            {
              label: t('tgeSchedule'),
              value: <span data-testid="tge-schedule">{tge.schedule ? when(tge.schedule.claimOpensAt) : t('tgeScheduleUnset')}</span>,
            },
          ]}
        />
        {tge.networks.map((n) => (
          <TgeClaim key={n.network} network={n.network} label={n.network === 'testnet' ? t('testnetLabel') : t('mainnetLabel')} />
        ))}
        <p className="lt-hint">{t('tgeStanding')}</p>
      </div>
    </Section>
  );
}

function TgeClaim({ network, label }: { network: TgeNetwork; label: string }) {
  const api = useApi();
  const { t } = dropRoomCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const claim = async () => {
    setBusy(true);
    const result = await api.call(CAMPAIGNS_TGE_CLAIM, { network });
    setBusy(false);
    setOutcome(result.ok ? { ok: true } : { ok: false, failure: result });
  };
  return (
    <div data-testid={`tge-${network}`} className="lt-actions">
      <strong data-testid={`tge-${network}-label`}>{label}</strong>
      <Button tone="secondary" onClick={() => void claim()} disabled={busy}>
        {t('tgeClaim', { network: label })}
      </Button>
      {outcome && !outcome.ok ? <Refusal failure={outcome.failure} testId={`tge-${network}-refusal`} /> : null}
    </div>
  );
}

function Refusal({ failure, testId }: { failure: Extract<ApiResult<unknown>, { ok: false }>; testId: string }) {
  const { t } = dropRoomCopy.useCopy();
  const code = roomCode(failure.code);
  if (!code) return <FailureNote result={failure} />;
  return (
    <p role="status" className="lt-hint" data-testid={testId} data-code={code}>
      {t(code)}
    </p>
  );
}
