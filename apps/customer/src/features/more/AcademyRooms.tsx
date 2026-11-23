import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import {
  ACADEMY_CREATE_ROOM,
  ACADEMY_END_SESSION,
  ACADEMY_JOIN,
  ACADEMY_LEAVE,
  ACADEMY_ROOMS,
  ACADEMY_ROOM,
  ACADEMY_SESSION,
  ACADEMY_START_SESSION,
  ACADEMY_ROOM_KINDS,
  academySessionSchema,
} from '@intafaced/contracts/academy-learner-procedures';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { decimalSchema } from '../../shared/money';
import { Button } from '@intafaced/ui/lit';
import { SelectField, TextField } from '@intafaced/ui/lit/templates';
import type { ActionControls } from './common';
import { KitDetails } from './volt-action';
import { KitLimit, KitRead, Section } from './volt-parts';
import { SessionMedia } from './SessionMedia';
import { RoomNotes } from './AcademyRoomNotes';
import { ROOM_KINDS, RoomCalendar, RoomKindFilter, RoomPinnedLessons } from './AcademyRoomPage';
// `scheduleSession`, `invite` and `updateScene` have no record: the door coerces their dates and takes any scene object,
// which no exported schema reaches the same verdicts on (`packages/contracts/src/academy-learner-procedures.test.ts`).
export function AcademyRooms({ action }: { action: ActionControls }) {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState(''),
    [limit, setLimit] = useState(50),
    [kindFilter, setKindFilter] = useState(''),
    [slug, setSlug] = useState(''),
    [name, setName] = useState(''),
    [kind, setKind] = useState('general'),
    [access, setAccess] = useState('free'),
    [capacity, setCapacity] = useState(''),
    [stake, setStake] = useState(''),
    [title, setTitle] = useState(''),
    [starts, setStarts] = useState(''),
    [invite, setInvite] = useState(''),
    [expires, setExpires] = useState(''),
    [sceneId, setSceneId] = useState(''),
    [seat, setSeat] = useState('');
  const rooms = useResource(
      (signal) =>
        api.call(ACADEMY_ROOMS, { limit, ...(kindFilter ? { kind: kindFilter as (typeof ACADEMY_ROOM_KINDS)[number] } : {}) }, { signal }),
      `rooms:${userId}:${limit}:${kindFilter}`,
    ),
    detail = useResource(
      (signal) =>
        selected ? api.call(ACADEMY_ROOM, { roomId: selected, limit }, { signal }) : Promise.resolve({ ok: true as const, data: null }),
      `room:${userId}:${selected}:${limit}`,
    );
  return (
    <div className="lt-stack">
      <div className="lt-stack">
        <Section title={copyText('academyrooms.learning.rooms')} className="lt-stack">
          <RoomKindFilter value={kindFilter} onChange={setKindFilter} />
          <KitRead resource={rooms.resource} retry={rooms.reload} empty={copyText('academyrooms.no.learning.rooms.are.open')}>
            {(rows) => (
              <>
                <div className="lt-stack">
                  {rows.map((r) => (
                    <article className="lt-stack" data-testid="academy-room-card" key={r.id}>
                      <strong>{r.name}</strong>
                      <p>
                        {r.kind} · {r.access}
                        <Text k="academyrooms.capacity" />
                        {r.capacity}
                      </p>
                      <Button
                        tone="secondary"
                        onClick={() => {
                          setSelected(r.id);
                          setSceneId('');
                        }}
                      >
                        <Text k="academyrooms.open" />
                        {r.name}
                      </Button>
                    </article>
                  ))}
                </div>
                <KitLimit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
              </>
            )}
          </KitRead>
        </Section>
        <Section title={copyText('academyrooms.room.and.sessions')} className="lt-stack">
          <KitRead resource={detail.resource} retry={detail.reload} empty={copyText('academyrooms.choose.a.room')}>
            {(data) =>
              data ? (
                <>
                  <h2>{data.room.name}</h2>
                  <KitDetails
                    items={[
                      [copyText('academyrooms.access'), data.room.access],
                      [
                        copyText('academyrooms.stake.threshold'),
                        copyText('academyrooms.configured.token.units', { amount: data.room.minStake }),
                      ],
                      [copyText('academyrooms.capacity.2'), data.room.capacity],
                      [copyText('academyrooms.host'), data.room.hostId],
                    ]}
                  />
                  <RoomNotes room={data.room} sessions={data.sessions} userId={userId} />
                  <RoomPinnedLessons
                    roomId={data.room.id}
                    lessons={data.pinnedLessons}
                    isHost={data.room.hostId === userId}
                    action={action}
                    done={detail.reload}
                  />
                  <RoomCalendar sessions={data.sessions} />
                  {data.sessions.map((s) => (
                    <article key={s.id} className="lt-stack">
                      <h3>{s.title}</h3>
                      <p>
                        {s.status}
                        <Text k="academyrooms.starts" />
                        {s.startsAt}
                      </p>
                      <div className="lt-actions">
                        <Button
                          tone="primary"
                          disabled={action.disabled || s.status !== 'live'}
                          onClick={() =>
                            action.stage({
                              title: copyText('academyrooms.review.room.seat'),
                              confirm: copyText('academyrooms.join.session'),
                              success: copyText('academyrooms.seat.confirmed'),
                              content: (
                                <p>
                                  <Text k="academyrooms.join" />
                                  {s.title}
                                  <Text k="academyrooms.the.service.enforces.room.capacity.invitations.and" />
                                </p>
                              ),
                              run: async () => {
                                const result = await api.call(ACADEMY_JOIN, { sessionId: s.id });
                                if (result.ok) setSeat(`${s.id}: ${result.data.role}`);
                                return result;
                              },
                              done: detail.reload,
                            })
                          }
                        >
                          <Text k="academyrooms.join.2" />
                        </Button>
                        <Button
                          tone="secondary"
                          disabled={action.disabled}
                          onClick={() =>
                            action.stage({
                              title: copyText('academyrooms.leave.session'),
                              confirm: copyText('academyrooms.leave.session'),
                              success: copyText('academyrooms.seat.released'),
                              content: (
                                <p>
                                  <Text k="academyrooms.leave" />
                                  {s.title}.
                                </p>
                              ),
                              run: () => api.call(ACADEMY_LEAVE, { sessionId: s.id }),
                              done: () => {
                                setSeat('');
                                detail.reload();
                              },
                            })
                          }
                        >
                          <Text k="academyrooms.leave.2" />
                        </Button>
                        <Button tone="secondary" onClick={() => setSceneId(s.id)}>
                          <Text k="academyrooms.open.scene" />
                        </Button>
                        {s.hostId === userId && (
                          <>
                            <Button
                              tone="secondary"
                              disabled={action.disabled || s.status !== 'scheduled'}
                              onClick={() =>
                                action.stage({
                                  title: copyText('academyrooms.start.hosted.session'),
                                  confirm: copyText('academyrooms.start.session'),
                                  success: copyText('academyrooms.session.started'),
                                  content: (
                                    <p>
                                      <Text k="academyrooms.start" />
                                      {s.title}
                                      <Text k="academyrooms.for.its.participants" />
                                    </p>
                                  ),
                                  run: () => api.call(ACADEMY_START_SESSION, { sessionId: s.id }),
                                  done: detail.reload,
                                })
                              }
                            >
                              <Text k="academyrooms.start.2" />
                            </Button>
                            <Button
                              tone="secondary"
                              disabled={action.disabled || s.status !== 'live'}
                              onClick={() =>
                                action.stage({
                                  title: copyText('academyrooms.end.hosted.session'),
                                  confirm: copyText('academyrooms.end.session'),
                                  success: copyText('academyrooms.session.ended'),
                                  content: (
                                    <p>
                                      <Text k="academyrooms.end" />
                                      {s.title}
                                      <Text k="academyrooms.for.all.participants" />
                                    </p>
                                  ),
                                  run: () => api.call(ACADEMY_END_SESSION, { sessionId: s.id }),
                                  done: detail.reload,
                                })
                              }
                            >
                              <Text k="academyrooms.end.2" />
                            </Button>
                          </>
                        )}
                      </div>
                      <p className="lt-hint">
                        {s.streamProvider === 'livekit'
                          ? copyText('academyrooms.audio.video.uses.the.service.granted.livekit')
                          : s.streamProvider
                            ? copyText('academyrooms.no.client.adapter.is.published.for.provider', { value1: s.streamProvider })
                            : copyText('academyrooms.no.audio.video.provider.is.connected.the')}
                      </p>
                      {s.streamProvider === 'livekit' && <SessionMedia sessionId={s.id} sessionStatus={s.status} />}
                    </article>
                  ))}
                  {seat && (
                    <p role="status">
                      <Text k="academyrooms.your.confirmed.seat" />
                      {seat}
                    </p>
                  )}
                  {data.sessions.length === 0 && (
                    <p>
                      <Text k="academyrooms.no.sessions.are.scheduled" />
                    </p>
                  )}
                  {data.room.hostId === userId && (
                    <>
                      <h3>
                        <Text k="academyrooms.host.tools" />
                      </h3>
                      <form
                        className="lt-stack"
                        onSubmit={(e) => {
                          e.preventDefault();
                          action.stage({
                            title: copyText('academyrooms.review.session.schedule'),
                            confirm: copyText('academyrooms.schedule.session'),
                            success: copyText('academyrooms.session.scheduled'),
                            content: (
                              <KitDetails
                                items={[
                                  [copyText('academyrooms.title'), title],
                                  [copyText('academyrooms.starts.2'), starts],
                                ]}
                              />
                            ),
                            run: () =>
                              api.mutate(
                                'academy',
                                'scheduleSession',
                                {
                                  roomId: selected,
                                  title: title.trim(),
                                  startsAt: new Date(starts).toISOString(),
                                },
                                academySessionSchema,
                              ),
                            done: detail.reload,
                          });
                        }}
                      >
                        <TextField label={copyText('academyrooms.session.title')} value={title} onChange={setTitle} maxLength={160} />
                        <TextField
                          label={copyText('academyrooms.session.starts.at')}
                          type="datetime-local"
                          value={starts}
                          onChange={setStarts}
                        />
                        <Button tone="primary" type="submit" disabled={action.disabled || !title.trim() || !starts}>
                          <Text k="academyrooms.review.schedule" />
                        </Button>
                      </form>
                      <form
                        className="lt-stack"
                        onSubmit={(e) => {
                          e.preventDefault();
                          action.stage({
                            title: copyText('academyrooms.review.room.invitation'),
                            confirm: copyText('academyrooms.send.invitation'),
                            success: copyText('academyrooms.invitation.recorded'),
                            content: (
                              <KitDetails
                                items={[
                                  [copyText('academyrooms.account'), invite],
                                  [copyText('academyrooms.expires'), expires || copyText('academyrooms.no.expiry.supplied')],
                                ]}
                              />
                            ),
                            run: () =>
                              api.mutate(
                                'academy',
                                'invite',
                                {
                                  roomId: selected,
                                  userId: invite,
                                  ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
                                },
                                z.object({ ok: z.literal(true) }),
                              ),
                          });
                        }}
                      >
                        <TextField label={copyText('academyrooms.invite.account.id')} value={invite} onChange={setInvite} />
                        <TextField
                          label={copyText('academyrooms.invitation.expires.optional')}
                          type="datetime-local"
                          value={expires}
                          onChange={setExpires}
                        />
                        <Button tone="primary" type="submit" disabled={action.disabled || !z.guid().safeParse(invite).success}>
                          <Text k="academyrooms.review.invitation" />
                        </Button>
                      </form>
                    </>
                  )}
                </>
              ) : null
            }
          </KitRead>
        </Section>
        {sceneId && <Scene id={sceneId} action={action} />}
      </div>
      <Section title={copyText('academyrooms.host.a.room')} className="lt-stack">
        <p className="lt-hint">
          <Text k="academyrooms.hosting.rights.come.from.your.identity.rank" />
        </p>
        <form
          className="lt-stack"
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: copyText('academyrooms.review.new.room'),
              confirm: copyText('academyrooms.create.room'),
              success: copyText('academyrooms.room.created'),
              content: (
                <KitDetails
                  items={[
                    [copyText('academyrooms.name'), name],
                    [copyText('academyrooms.slug'), slug],
                    [copyText('academyrooms.kind'), kind],
                    [copyText('academyrooms.access'), access],
                    [copyText('academyrooms.capacity.2'), capacity],
                    [copyText('academyrooms.stake.threshold'), stake || copyText('academyrooms.no.threshold.supplied')],
                  ]}
                />
              ),
              run: () =>
                api.call(ACADEMY_CREATE_ROOM, {
                  slug,
                  name: name.trim(),
                  kind: kind as (typeof ACADEMY_ROOM_KINDS)[number],
                  access: access as 'free' | 'staked' | 'invite',
                  capacity: Number(capacity),
                  ...(stake ? { minStake: stake } : {}),
                }),
              done: rooms.reload,
            });
          }}
        >
          <TextField label={copyText('academyrooms.room.name')} value={name} onChange={setName} maxLength={120} />
          <TextField label={copyText('academyrooms.room.slug')} value={slug} onChange={setSlug} maxLength={64} />
          <SelectField label={copyText('academyrooms.room.kind')} value={kind} onChange={setKind} options={ROOM_KINDS} />
          <SelectField
            label={copyText('academyrooms.room.access')}
            value={access}
            onChange={setAccess}
            options={['free', 'staked', 'invite']}
          />
          <TextField label={copyText('academyrooms.room.capacity')} value={capacity} onChange={setCapacity} inputMode="numeric" />
          {access === 'staked' && (
            <TextField
              label={copyText('academyrooms.minimum.stake.configured.token.units')}
              value={stake}
              onChange={setStake}
              inputMode="decimal"
              hint={copyText('academyrooms.access.threshold.only.creating.a.room.does')}
            />
          )}
          <Button
            tone="primary"
            type="submit"
            disabled={
              action.disabled ||
              !name.trim() ||
              !/^[a-z0-9-]{3,64}$/.test(slug) ||
              !/^[1-9]\d*$/.test(capacity) ||
              !Number.isSafeInteger(Number(capacity)) ||
              (access === 'staked' && !decimalSchema.safeParse(stake).success)
            }
          >
            <Text k="academyrooms.review.room" />
          </Button>
        </form>
      </Section>
    </div>
  );
}
function Scene({ id, action }: { id: string; action: ActionControls }) {
  const api = useApi(),
    { userId } = useSession();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const data = useResource((signal) => api.call(ACADEMY_SESSION, { sessionId: id }, { signal }), `scene:${userId}:${id}`);
  return (
    <Section title={copyText('academyrooms.session.scene')} className="lt-stack">
      <KitRead resource={data.resource} retry={data.reload}>
        {(d) => (
          <>
            <p>
              {d.session.title} · {d.occupancy}
              <Text k="academyrooms.occupied.seats" />
            </p>
            <svg
              viewBox={`0 0 ${d.session.scene.stage?.width ?? 640} ${d.session.scene.stage?.height ?? 360}`}
              width="100%"
              height={300}
              role="img"
              aria-label={copyText('academyrooms.session.scene.with.participant.positions')}
              onClick={(event) => {
                if (d.session.hostId !== userId) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setPoint({
                  x: Math.round(((event.clientX - rect.left) / rect.width) * (d.session.scene.stage?.width ?? 640)),
                  y: Math.round(((event.clientY - rect.top) / rect.height) * (d.session.scene.stage?.height ?? 360)),
                });
              }}
            >
              {d.session.scene.avatars?.map((a) => (
                <g key={a.id}>
                  <circle cx={a.position.x} cy={a.position.y} r={10} fill="var(--lit-accent)" />
                  <text x={a.position.x + 14} y={a.position.y} fill="currentColor">
                    {a.labelKey ?? a.id}
                  </text>
                </g>
              ))}
              {d.session.scene.props?.map((p) => (
                <g key={p.id}>
                  <rect x={p.position.x} y={p.position.y} width={20} height={20} fill="var(--lit-line-strong)" />
                  <text x={p.position.x + 24} y={p.position.y} fill="currentColor">
                    {p.kind}
                  </text>
                </g>
              ))}
            </svg>
            {d.session.hostId === userId && (
              <>
                <p className="lt-hint">
                  <Text k="academyrooms.choose.a.location.or.use.the.coordinates" />
                </p>
                <TextField
                  label={copyText('academyrooms.host.x.coordinate')}
                  type="number"
                  value={String(point?.x ?? '')}
                  onChange={(value) => setPoint({ x: Number(value), y: point?.y ?? 0 })}
                />
                <TextField
                  label={copyText('academyrooms.host.y.coordinate')}
                  type="number"
                  value={String(point?.y ?? '')}
                  onChange={(value) => setPoint({ x: point?.x ?? 0, y: Number(value) })}
                />
                <Button
                  tone="primary"
                  disabled={action.disabled || !point}
                  onClick={() => {
                    if (!point) return;
                    const next = {
                      ...d.session.scene,
                      avatars: [
                        ...(d.session.scene.avatars ?? []).filter((a) => a.id !== 'host'),
                        { id: 'host', participantId: userId!, position: point },
                      ],
                    };
                    action.stage({
                      title: copyText('academyrooms.review.session.scene'),
                      confirm: copyText('academyrooms.save.scene'),
                      success: copyText('academyrooms.scene.saved'),
                      content: (
                        <p>
                          <Text k="academyrooms.move.your.host.position.to" />
                          {point.x}, {point.y}
                          <Text k="academyrooms.other.scene.objects.remain.present.a.stale" />
                        </p>
                      ),
                      run: () =>
                        api.mutate(
                          'academy',
                          'updateScene',
                          { sessionId: id, scene: next, expectedFingerprint: d.session.sceneFingerprint },
                          academySessionSchema,
                        ),
                      done: () => {
                        setPoint(null);
                        data.reload();
                      },
                    });
                  }}
                >
                  <Text k="academyrooms.review.host.position" />
                </Button>
              </>
            )}
            <p className="lt-hint">
              <Text k="academyrooms.this.is.the.published.2d.scene.a" />
            </p>
          </>
        )}
      </KitRead>
    </Section>
  );
}
