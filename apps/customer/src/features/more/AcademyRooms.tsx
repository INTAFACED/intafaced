import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema } from '../../shared/money';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, useAction } from './common';
import { SessionMedia } from './SessionMedia';
const uuid = z.string().uuid(),
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
  scene: z.record(z.unknown()),
  sceneFingerprint: z.string().min(1),
});
export function AcademyRooms({ action }: { action: ReturnType<typeof useAction> }) {
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
        <Panel title="Learning rooms">
          <Read resource={rooms.resource} retry={rooms.reload} empty="No learning rooms are open">
            {(rows) => (
              <>
                <div className="more-rooms">
                  {rows.map((r) => (
                    <article className="more-room-link" key={r.id}>
                      <strong>{r.name}</strong>
                      <p>
                        {r.kind} · {r.access} · capacity {r.capacity}
                      </p>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSelected(r.id);
                          setSceneId('');
                        }}
                      >
                        Open {r.name}
                      </Button>
                    </article>
                  ))}
                </div>
                <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
              </>
            )}
          </Read>
        </Panel>
        <Panel title="Room and sessions">
          <Read resource={detail.resource} retry={detail.reload} empty="Choose a room">
            {(data) =>
              data ? (
                <>
                  <h2>{data.room.name}</h2>
                  <Details
                    items={[
                      ['Access', data.room.access],
                      ['Stake threshold', `${data.room.minStake} · configured token units`],
                      ['Capacity', data.room.capacity],
                      ['Host', data.room.hostId],
                    ]}
                  />
                  {data.sessions.map((s) => (
                    <article key={s.id} className="more-session">
                      <h3>{s.title}</h3>
                      <p>
                        {s.status} · starts {s.startsAt}
                      </p>
                      <div className="actions">
                        <Button
                          disabled={action.disabled || s.status !== 'live'}
                          onClick={() =>
                            action.stage({
                              title: 'Review room seat',
                              confirm: 'Join session',
                              success: 'Seat confirmed',
                              content: (
                                <p>Join {s.title}. The service enforces room capacity, invitations and stake access for your account.</p>
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
                          Join
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={action.disabled}
                          onClick={() =>
                            action.stage({
                              title: 'Leave session',
                              confirm: 'Leave session',
                              success: 'Seat released',
                              content: <p>Leave {s.title}.</p>,
                              run: () => api.mutate('academy', 'leave', { sessionId: s.id }, z.object({ ok: z.literal(true) })),
                              done: () => {
                                setSeat('');
                                detail.reload();
                              },
                            })
                          }
                        >
                          Leave
                        </Button>
                        <Button variant="secondary" onClick={() => setSceneId(s.id)}>
                          Open scene
                        </Button>
                        {s.hostId === userId && (
                          <>
                            <Button
                              variant="secondary"
                              disabled={action.disabled || s.status !== 'scheduled'}
                              onClick={() =>
                                action.stage({
                                  title: 'Start hosted session',
                                  confirm: 'Start session',
                                  success: 'Session started',
                                  content: <p>Start {s.title} for its participants.</p>,
                                  run: () => api.mutate('academy', 'startSession', { sessionId: s.id }, session),
                                  done: detail.reload,
                                })
                              }
                            >
                              Start
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={action.disabled || s.status !== 'live'}
                              onClick={() =>
                                action.stage({
                                  title: 'End hosted session',
                                  confirm: 'End session',
                                  success: 'Session ended',
                                  content: <p>End {s.title} for all participants.</p>,
                                  run: () => api.mutate('academy', 'endSession', { sessionId: s.id }, session),
                                  done: detail.reload,
                                })
                              }
                            >
                              End
                            </Button>
                          </>
                        )}
                      </div>
                      <p className="muted">
                        {s.streamProvider === 'livekit'
                          ? 'Audio/video uses the service-granted LiveKit connection.'
                          : s.streamProvider
                            ? `No client adapter is published for provider ${s.streamProvider}.`
                            : 'No audio/video provider is connected. The session scene remains readable.'}
                      </p>
                      {s.streamProvider === 'livekit' && <SessionMedia sessionId={s.id} sessionStatus={s.status} />}
                    </article>
                  ))}
                  {seat && <p role="status">Your confirmed seat: {seat}</p>}
                  {data.sessions.length === 0 && <p>No sessions are scheduled.</p>}
                  {data.room.hostId === userId && (
                    <>
                      <h3>Host tools</h3>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          action.stage({
                            title: 'Review session schedule',
                            confirm: 'Schedule session',
                            success: 'Session scheduled',
                            content: (
                              <Details
                                items={[
                                  ['Title', title],
                                  ['Starts', starts],
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
                        <Field label="Session title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
                        <Field label="Session starts at" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
                        <Button type="submit" disabled={action.disabled || !title.trim() || !starts}>
                          Review schedule
                        </Button>
                      </form>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          action.stage({
                            title: 'Review room invitation',
                            confirm: 'Send invitation',
                            success: 'Invitation recorded',
                            content: (
                              <Details
                                items={[
                                  ['Account', invite],
                                  ['Expires', expires || 'No expiry supplied'],
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
                        <Field label="Invite account ID" value={invite} onChange={(e) => setInvite(e.target.value)} />
                        <Field
                          label="Invitation expires (optional)"
                          type="datetime-local"
                          value={expires}
                          onChange={(e) => setExpires(e.target.value)}
                        />
                        <Button type="submit" disabled={action.disabled || !uuid.safeParse(invite).success}>
                          Review invitation
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
      <Panel title="Host a room">
        <p className="muted">Hosting rights come from your identity rank. The service checks them before creating a room.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: 'Review new room',
              confirm: 'Create room',
              success: 'Room created',
              content: (
                <Details
                  items={[
                    ['Name', name],
                    ['Slug', slug],
                    ['Kind', kind],
                    ['Access', access],
                    ['Capacity', capacity],
                    ['Stake threshold', stake || 'No threshold supplied'],
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
          <Field label="Room name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Field label="Room slug" value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={64} />
          <Select
            label="Room kind"
            value={kind}
            onChange={setKind}
            options={['general', 'futures', 'options', 'meme_war_room', 'forex', 'defi_lab', 'merchant_clinic']}
          />
          <Select label="Room access" value={access} onChange={setAccess} options={['free', 'staked', 'invite']} />
          <Field label="Room capacity" value={capacity} onChange={(e) => setCapacity(e.target.value)} inputMode="numeric" />
          {access === 'staked' && (
            <Field
              label="Minimum stake (configured token units)"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              hint="Access threshold only; creating a room does not stake or debit funds."
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
            Review room
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
function Scene({ id, action }: { id: string; action: ReturnType<typeof useAction> }) {
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
    <Panel title="Session scene">
      <Read resource={data.resource} retry={data.reload}>
        {(d) => (
          <>
            <p>
              {d.session.title} · {d.occupancy} occupied seats
            </p>
            <svg
              viewBox={`0 0 ${d.session.scene.stage?.width ?? 640} ${d.session.scene.stage?.height ?? 360}`}
              style={{ width: '100%', height: 300, border: '1px solid var(--color-border)' }}
              role="img"
              aria-label="Session scene with participant positions"
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
                <p className="muted">Choose a location or use the coordinates, then review a host-position change.</p>
                <Field
                  label="Host X coordinate"
                  type="number"
                  value={point?.x ?? ''}
                  onChange={(e) => setPoint({ x: Number(e.target.value), y: point?.y ?? 0 })}
                />
                <Field
                  label="Host Y coordinate"
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
                      title: 'Review session scene',
                      confirm: 'Save scene',
                      success: 'Scene saved',
                      content: (
                        <p>
                          Move your host position to ({point.x}, {point.y}). Other scene objects remain present. A stale scene fingerprint
                          is refused.
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
                  Review host position
                </Button>
              </>
            )}
            <p className="muted">This is the published 2D scene. A VR client is not connected.</p>
          </>
        )}
      </Read>
    </Panel>
  );
}
