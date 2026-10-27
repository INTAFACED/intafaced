import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema } from '../../shared/money';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, type ActionControls } from './common';
import { SessionMedia } from './SessionMedia';
import { RoomNotes } from './AcademyRoomNotes';
const uuid = z.string().guid(),
  room = z.object({
    id: uuid,
    slug: z.string(),
    name: z.string(),
    kind: z.string(),
    access: z.enum(['free', 'staked', 'invite']),
    minStake: decimalSchema,
    capacity: z.number().int().positive(),
    hostId: uuid,
  });
const session = z.object({
  id: uuid,
  roomId: uuid,
  title: z.string(),
  hostId: uuid,
  status: z.enum(['scheduled', 'live', 'ended', 'cancelled']),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  streamProvider: z.string().nullable(),
  scene: z.record(z.string(), z.unknown()),
  sceneFingerprint: z.string().min(1),
});
export function AcademyRooms({ action }: { action: ActionControls }) {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState(''),
    [limit, setLimit] = useState(50),
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
  const rooms = useResource((signal) => api.query('academy', 'rooms', { limit }, z.array(room), { signal }), `rooms:${userId}:${limit}`),
    detail = useResource(
      (signal) =>
        selected
          ? api.query('academy', 'room', { roomId: selected, limit }, z.object({ room, sessions: z.array(session) }), { signal })
          : Promise.resolve({ ok: true as const, data: null }),
      `room:${userId}:${selected}:${limit}`,
    );
  return (
    <div className="more-columns">
      <div>
        <Panel title={copyText('academyrooms.learning.rooms')}>
          <Read resource={rooms.resource} retry={rooms.reload} empty={copyText('academyrooms.no.learning.rooms.are.open')}>
            {(rows) => (
              <>
                <div className="more-rooms">
                  {rows.map((r) => (
                    <article data-testid="more-room-link" className="more-room-link" key={r.id}>
                      <strong>{r.name}</strong>
                      <p>
                        {r.kind} · {r.access}
                        <Text k="academyrooms.capacity" />
                        {r.capacity}
                      </p>
                      <Button
                        variant="secondary"
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
                <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
              </>
            )}
          </Read>
        </Panel>
        <Panel title={copyText('academyrooms.room.and.sessions')}>
          <Read resource={detail.resource} retry={detail.reload} empty={copyText('academyrooms.choose.a.room')}>
            {(data) =>
              data ? (
                <>
                  <h2>{data.room.name}</h2>
                  <Details
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
                  {data.sessions.map((s) => (
                    <article key={s.id} className="more-session">
                      <h3>{s.title}</h3>
                      <p>
                        {s.status}
                        <Text k="academyrooms.starts" />
                        {s.startsAt}
                      </p>
                      <div className="actions">
                        <Button
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
                                const result = await api.mutate(
                                  'academy',
                                  'join',
                                  { sessionId: s.id },
                                  z.object({ role: z.enum(['host', 'speaker', 'attendee']) }),
                                );
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
                          variant="secondary"
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
                              run: () => api.mutate('academy', 'leave', { sessionId: s.id }, z.object({ ok: z.literal(true) })),
                              done: () => {
                                setSeat('');
                                detail.reload();
                              },
                            })
                          }
                        >
                          <Text k="academyrooms.leave.2" />
                        </Button>
                        <Button variant="secondary" onClick={() => setSceneId(s.id)}>
                          <Text k="academyrooms.open.scene" />
                        </Button>
                        {s.hostId === userId && (
                          <>
                            <Button
                              variant="secondary"
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
                                  run: () => api.mutate('academy', 'startSession', { sessionId: s.id }, session),
                                  done: detail.reload,
                                })
                              }
                            >
                              <Text k="academyrooms.start.2" />
                            </Button>
                            <Button
                              variant="secondary"
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
                                  run: () => api.mutate('academy', 'endSession', { sessionId: s.id }, session),
                                  done: detail.reload,
                                })
                              }
                            >
                              <Text k="academyrooms.end.2" />
                            </Button>
                          </>
                        )}
                      </div>
                      <p className="muted">
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
                        onSubmit={(e) => {
                          e.preventDefault();
                          action.stage({
                            title: copyText('academyrooms.review.session.schedule'),
                            confirm: copyText('academyrooms.schedule.session'),
                            success: copyText('academyrooms.session.scheduled'),
                            content: (
                              <Details
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
                                { roomId: selected, title: title.trim(), startsAt: new Date(starts).toISOString() },
                                session,
                              ),
                            done: detail.reload,
                          });
                        }}
                      >
                        <Field
                          label={copyText('academyrooms.session.title')}
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          maxLength={160}
                        />
                        <Field
                          label={copyText('academyrooms.session.starts.at')}
                          type="datetime-local"
                          value={starts}
                          onChange={(e) => setStarts(e.target.value)}
                        />
                        <Button type="submit" disabled={action.disabled || !title.trim() || !starts}>
                          <Text k="academyrooms.review.schedule" />
                        </Button>
                      </form>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          action.stage({
                            title: copyText('academyrooms.review.room.invitation'),
                            confirm: copyText('academyrooms.send.invitation'),
                            success: copyText('academyrooms.invitation.recorded'),
                            content: (
                              <Details
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
                                { roomId: selected, userId: invite, ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}) },
                                z.object({ ok: z.literal(true) }),
                              ),
                          });
                        }}
                      >
                        <Field
                          label={copyText('academyrooms.invite.account.id')}
                          value={invite}
                          onChange={(e) => setInvite(e.target.value)}
                        />
                        <Field
                          label={copyText('academyrooms.invitation.expires.optional')}
                          type="datetime-local"
                          value={expires}
                          onChange={(e) => setExpires(e.target.value)}
                        />
                        <Button type="submit" disabled={action.disabled || !uuid.safeParse(invite).success}>
                          <Text k="academyrooms.review.invitation" />
                        </Button>
                      </form>
                    </>
                  )}
                </>
              ) : null
            }
          </Read>
        </Panel>
        {sceneId && <Scene id={sceneId} action={action} />}
      </div>
      <Panel title={copyText('academyrooms.host.a.room')}>
        <p className="muted">
          <Text k="academyrooms.hosting.rights.come.from.your.identity.rank" />
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: copyText('academyrooms.review.new.room'),
              confirm: copyText('academyrooms.create.room'),
              success: copyText('academyrooms.room.created'),
              content: (
                <Details
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
                api.mutate(
                  'academy',
                  'createRoom',
                  { slug, name: name.trim(), kind, access, capacity: Number(capacity), ...(stake ? { minStake: stake } : {}) },
                  room,
                ),
              done: rooms.reload,
            });
          }}
        >
          <Field label={copyText('academyrooms.room.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Field label={copyText('academyrooms.room.slug')} value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={64} />
          <Select
            label={copyText('academyrooms.room.kind')}
            value={kind}
            onChange={setKind}
            options={['general', 'futures', 'options', 'meme_war_room', 'forex', 'defi_lab', 'merchant_clinic']}
          />
          <Select label={copyText('academyrooms.room.access')} value={access} onChange={setAccess} options={['free', 'staked', 'invite']} />
          <Field
            label={copyText('academyrooms.room.capacity')}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            inputMode="numeric"
          />
          {access === 'staked' && (
            <Field
              label={copyText('academyrooms.minimum.stake.configured.token.units')}
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              hint={copyText('academyrooms.access.threshold.only.creating.a.room.does')}
            />
          )}
          <Button
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
      </Panel>
    </div>
  );
}
const vec = z.object({ x: z.number().finite(), y: z.number().finite() }),
  scene = z
    .object({
      version: z.literal(1),
      stage: z
        .object({ width: z.number().positive().max(10000), height: z.number().positive().max(10000), backgroundKey: z.string().optional() })
        .optional(),
      avatars: z
        .array(
          z.object({
            id: z.string(),
            participantId: z.string(),
            position: vec,
            facing: z.number().optional(),
            labelKey: z.string().optional(),
          }),
        )
        .max(200)
        .optional(),
      props: z
        .array(z.object({ id: z.string(), kind: z.string(), position: vec, rotation: z.number().optional() }))
        .max(500)
        .optional(),
    })
    .strict();
function Scene({ id, action }: { id: string; action: ActionControls }) {
  const api = useApi(),
    { userId } = useSession();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const data = useResource(
    (signal) =>
      api.query(
        'academy',
        'session',
        { sessionId: id },
        z.object({ session: session.extend({ scene }), occupancy: z.number().int().nonnegative() }),
        { signal },
      ),
    `scene:${userId}:${id}`,
  );
  return (
    <Panel title={copyText('academyrooms.session.scene')}>
      <Read resource={data.resource} retry={data.reload}>
        {(d) => (
          <>
            <p>
              {d.session.title} · {d.occupancy}
              <Text k="academyrooms.occupied.seats" />
            </p>
            <svg
              viewBox={`0 0 ${d.session.scene.stage?.width ?? 640} ${d.session.scene.stage?.height ?? 360}`}
              style={{ width: '100%', height: 300, border: '1px solid var(--color-border)' }}
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
                  <circle cx={a.position.x} cy={a.position.y} r={10} fill="var(--color-accent)" />
                  <text x={a.position.x + 14} y={a.position.y} fill="var(--color-text)">
                    {a.labelKey ?? a.id}
                  </text>
                </g>
              ))}
              {d.session.scene.props?.map((p) => (
                <g key={p.id}>
                  <rect x={p.position.x} y={p.position.y} width={20} height={20} fill="var(--color-muted)" />
                  <text x={p.position.x + 24} y={p.position.y} fill="var(--color-text)">
                    {p.kind}
                  </text>
                </g>
              ))}
            </svg>
            {d.session.hostId === userId && (
              <>
                <p className="muted">
                  <Text k="academyrooms.choose.a.location.or.use.the.coordinates" />
                </p>
                <Field
                  label={copyText('academyrooms.host.x.coordinate')}
                  type="number"
                  value={point?.x ?? ''}
                  onChange={(e) => setPoint({ x: Number(e.target.value), y: point?.y ?? 0 })}
                />
                <Field
                  label={copyText('academyrooms.host.y.coordinate')}
                  type="number"
                  value={point?.y ?? ''}
                  onChange={(e) => setPoint({ x: point?.x ?? 0, y: Number(e.target.value) })}
                />
                <Button
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
                          session,
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
            <p className="muted">
              <Text k="academyrooms.this.is.the.published.2d.scene.a" />
            </p>
          </>
        )}
      </Read>
    </Panel>
  );
}
