import { useState } from 'react';
import { z } from 'zod';
import { dropClaimResultSchema, dropRoomSchema, type DropView, type TgeNetwork, type TgeView } from '@intafaced/contracts/campaigns-drops';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { StatRow } from './depth-kit';
import { dropRoomCopy } from './drop-room-copy';

/** identity `waitlist.mine`: the signed-in account's own place, or null when its email never joined. */
const waitlistMineSchema = z
  .object({
    position: z.number().int().positive(),
    referredCount: z.number().int().min(0),
    rank: z.number().int().positive().nullable(),
    waiting: z.number().int().min(0),
    release: z.object({ waveNumber: z.number().int().positive(), releasedAt: z.string() }).nullable(),
  })
  .nullable();

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
  const waitlist = useResource(
    (signal) => api.query('identity', 'waitlist.mine', undefined, waitlistMineSchema, { signal }),
    'drops-waitlist',
  );
  const room = useResource((signal) => api.query('campaigns', 'drops.room', undefined, dropRoomSchema, { signal }), 'drops-room');
  // Kept here, not in the row: the room reads its state again after every claim, which remounts the rows.
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({});

  return (
    <div className="more-grid" data-testid="drop-room">
      <Panel title={t('waitlistTitle')}>
        <div data-testid="drop-waitlist">
          {waitlist.resource.status === 'loading' ? (
            <Loading label={t('waitlistLoading')} />
          ) : waitlist.resource.status === 'failed' ? (
            waitlist.resource.failure.code === 'waitlist.email_unverified' ? (
              <p role="status">{t('waitlistUnverified')}</p>
            ) : (
              <Failure result={waitlist.resource.failure} retry={waitlist.reload} />
            )
          ) : waitlist.resource.data === null ? (
            <EmptyState title={t('waitlistNone')} />
          ) : (
            <StatRow
              items={[
                {
                  label: t('rank'),
                  value: (
                    <span data-testid="drop-rank">
                      {waitlist.resource.data.rank === null
                        ? '—'
                        : t('rankValue', { rank: String(waitlist.resource.data.rank), waiting: String(waitlist.resource.data.waiting) })}
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
      </Panel>
      {room.resource.status === 'loading' ? (
        <Panel title={t('seasonTitle')}>
          <Loading label={t('seasonLoading')} />
        </Panel>
      ) : room.resource.status === 'failed' ? (
        <Panel title={t('seasonTitle')}>
          <Failure result={room.resource.failure} retry={room.reload} />
        </Panel>
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
  );
}

function Season({ season }: { season: z.infer<typeof dropRoomSchema>['season'] }) {
  const { t } = dropRoomCopy.useCopy();
  return (
    <Panel title={t('seasonTitle')}>
      <div data-testid="drop-season">
        {season === null ? (
          <EmptyState title={t('seasonNone')} />
        ) : (
          <StatRow
            items={[
              { label: t('seasonName'), value: <span data-testid="drop-season-name">{season.name}</span> },
              { label: t('seasonWindow'), value: t('seasonWindowValue', { start: when(season.startsAt), end: when(season.endsAt) }) },
              { label: t('seasonState'), value: t(season.state) },
              {
                label: t('points'),
                value: <span data-testid="drop-season-points">{season.points}</span>,
                note: t('pointsNote', { count: String(season.taskCampaigns) }),
              },
            ]}
          />
        )}
      </div>
    </Panel>
  );
}

type Settle = (dropId: string, outcome: Outcome) => void;

function Drops({ drops, outcomes, settle }: { drops: readonly DropView[]; outcomes: Readonly<Record<string, Outcome>>; settle: Settle }) {
  const { t } = dropRoomCopy.useCopy();
  return (
    <Panel title={t('dropsTitle')}>
      {drops.length === 0 ? (
        <EmptyState title={t('dropsNone')} />
      ) : (
        <DataTable label={t('dropsLabel')} headers={[t('dropName'), t('dropLeft'), t('dropState'), t('dropAction')]}>
          {drops.map((drop) => (
            <DropRow key={drop.id} drop={drop} outcome={outcomes[drop.id] ?? null} settle={settle} />
          ))}
        </DataTable>
      )}
      <p className="muted">{t('entitlement')}</p>
    </Panel>
  );
}

function DropRow({ drop, outcome, settle }: { drop: DropView; outcome: Outcome | null; settle: Settle }) {
  const api = useApi();
  const { t } = dropRoomCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const claim = async () => {
    setBusy(true);
    const result = await api.mutate('campaigns', 'drops.claim', { dropId: drop.id }, dropClaimResultSchema);
    setBusy(false);
    settle(drop.id, result.ok ? { ok: true } : { ok: false, failure: result });
  };
  return (
    <tr data-testid="drop-row" data-drop-id={drop.id}>
      <th scope="row">{drop.title}</th>
      <td className="numeric" data-testid="drop-left">
        {t('dropLeftValue', { remaining: String(drop.remaining), count: String(drop.count) })}
      </td>
      <td data-testid="drop-state">{t(drop.state)}</td>
      <td>
        {drop.mine ? (
          <span data-testid="drop-claimed">
            {t('claimed')} · {when(drop.mine.claimedAt)}
          </span>
        ) : (
          <Button onClick={() => void claim()} disabled={busy} aria-label={t('claim', { title: drop.title })}>
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
    <Panel title={t('tgeTitle')}>
      <div data-testid="drop-tge">
        <StatRow
          items={[
            {
              label: t('tgeSchedule'),
              value: <span data-testid="tge-schedule">{tge.schedule ? when(tge.schedule.claimOpensAt) : t('tgeScheduleUnset')}</span>,
            },
          ]}
        />
        {tge.networks.map((n) => (
          <TgeClaim key={n.network} network={n.network} label={n.network === 'testnet' ? t('testnetLabel') : t('mainnetLabel')} />
        ))}
        <p className="muted">{t('tgeStanding')}</p>
      </div>
    </Panel>
  );
}

function TgeClaim({ network, label }: { network: TgeNetwork; label: string }) {
  const api = useApi();
  const { t } = dropRoomCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const claim = async () => {
    setBusy(true);
    const result = await api.mutate('campaigns', 'tge.claim', { network }, z.never());
    setBusy(false);
    setOutcome(result.ok ? { ok: true } : { ok: false, failure: result });
  };
  return (
    <div className="depth-disabled" data-testid={`tge-${network}`}>
      <span className="badge" data-testid={`tge-${network}-label`}>
        {label}
      </span>
      <Button variant="secondary" onClick={() => void claim()} disabled={busy}>
        {t('tgeClaim', { network: label })}
      </Button>
      {outcome && !outcome.ok ? <Refusal failure={outcome.failure} testId={`tge-${network}-refusal`} /> : null}
    </div>
  );
}

function Refusal({ failure, testId }: { failure: Extract<ApiResult<unknown>, { ok: false }>; testId: string }) {
  const { t } = dropRoomCopy.useCopy();
  const code = roomCode(failure.code);
  if (!code) return <Failure result={failure} />;
  return (
    <p role="status" className="muted" data-testid={testId} data-code={code}>
      {t(code)}
    </p>
  );
}
