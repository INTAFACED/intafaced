/**
 * A start whose conditional update matches no row was not started by this call.
 * That call must not come back as success, and a stream room opened for the
 * attempt must not stay open.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_PERKS } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Sql } from 'postgres';
import { AcademyService } from './academy-service.js';
import { AcademyError } from './errors.js';
import type { HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import { LiveKitStreamProvider, NullStreamProvider, type StreamProvider } from './stream/provider.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';
const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrations = [readFileSync(join(here, '..', 'drizzle', '0000_academy_init.sql'), 'utf8')];

const stakes: StakeSource = { stakeOf: async () => 0n };
const hostRights: HostRightsSource = {
  perksOf: async () => {
    throw new Error('start does not consult host rights');
  },
};
const hostCanOpen: HostRightsSource = {
  perksOf: async () => ({ ...BASE_PERKS, lobbyHostRights: true }),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sessionRow(status: 'scheduled' | 'live', streamRoom: string | null) {
  return {
    id: SESSION_ID,
    room_id: ROOM_ID,
    title: 'Open desk',
    host_id: HOST_ID,
    status,
    starts_at: new Date('2026-10-07T00:00:00.000Z'),
    ends_at: null,
    stream_provider: streamRoom ? 'livekit' : null,
    stream_room: streamRoom,
    scene: { version: 1 },
  };
}

/** First read is scheduled. The conditional update matches nothing. A later read is the session another start already took live. */
function sqlWhereUpdateMisses(): Sql {
  let reads = 0;
  const tag = (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('UPDATE') && text.includes('academy.sessions')) return Promise.resolve([]);
    if (text.includes('SELECT') && text.includes('academy.sessions')) {
      reads += 1;
      return Promise.resolve([reads === 1 ? sessionRow('scheduled', null) : sessionRow('live', 'winner-room')]);
    }
    return Promise.resolve([]);
  };
  return tag as unknown as Sql;
}

/** The conditional update matches and returns the stream room this call wrote. */
function sqlWhereUpdateStores(): Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('UPDATE') && text.includes('academy.sessions')) {
      const streamRoom = values.find((v) => v === 'attempt-room');
      const provider = values.find((v) => v === 'livekit');
      return Promise.resolve([
        {
          ...sessionRow('live', typeof streamRoom === 'string' ? streamRoom : null),
          stream_provider: typeof provider === 'string' ? provider : null,
        },
      ]);
    }
    if (text.includes('SELECT') && text.includes('academy.sessions')) return Promise.resolve([sessionRow('scheduled', null)]);
    return Promise.resolve([]);
  };
  return tag as unknown as Sql;
}

describe('startSession when the conditional update matches no row', () => {
  it('refuses the call and does not leave the attempt room open', async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const stream: StreamProvider = {
      id: 'livekit',
      openRoom: async () => {
        opened.push('attempt-room');
        return 'attempt-room';
      },
      closeRoom: async (streamRoom) => {
        closed.push(streamRoom);
      },
      credential: async () => ({
        url: 'wss://stream.example',
        token: 't',
        expiresAt: new Date('2026-10-07T01:00:00.000Z'),
      }),
    };
    const academy = new AcademyService(sqlWhereUpdateMisses(), stakes, hostRights, stream, {});

    await expect(academy.startSession({ sessionId: SESSION_ID, hostId: HOST_ID })).rejects.toBeInstanceOf(AcademyError);
    expect(opened.filter((id) => !closed.includes(id))).toEqual([]);
  });

  it('does not succeed and does not close the room already stored on the session', async () => {
    const closed: string[] = [];
    const stream: StreamProvider = {
      id: 'livekit',
      openRoom: async () => 'winner-room',
      closeRoom: async (streamRoom) => {
        closed.push(streamRoom);
      },
      credential: async () => ({
        url: 'wss://stream.example',
        token: 't',
        expiresAt: new Date('2026-10-07T01:00:00.000Z'),
      }),
    };
    const academy = new AcademyService(sqlWhereUpdateMisses(), stakes, hostRights, stream, {});

    await expect(academy.startSession({ sessionId: SESSION_ID, hostId: HOST_ID })).rejects.toBeInstanceOf(AcademyError);
    expect(closed).toEqual([]);
  });
});

describe('startSession when the conditional update matches', () => {
  it('opens the stream room and stores it on the session this call started', async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const stream: StreamProvider = {
      id: 'livekit',
      openRoom: async () => {
        opened.push('attempt-room');
        return 'attempt-room';
      },
      closeRoom: async (streamRoom) => {
        closed.push(streamRoom);
      },
      credential: async () => ({
        url: 'wss://stream.example',
        token: 't',
        expiresAt: new Date('2026-10-07T01:00:00.000Z'),
      }),
    };
    const academy = new AcademyService(sqlWhereUpdateStores(), stakes, hostRights, stream, {});

    const started = await academy.startSession({ sessionId: SESSION_ID, hostId: HOST_ID });

    expect(started.status).toBe('live');
    expect(started.streamRoom).toBe('attempt-room');
    expect(started.streamProvider).toBe('livekit');
    expect(opened).toEqual(['attempt-room']);
    expect(closed).toEqual([]);
  });
});

describe('startSession room lifetime with PostgreSQL', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'academy', url: TEST_URL, migrations });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function scheduledSession(slug: string, stream: StreamProvider) {
    const academy = new AcademyService(db.sql, stakes, hostCanOpen, stream, {});
    const rooms = await db.sql<Array<{ id: string }>>`
      INSERT INTO academy.rooms (slug, name, kind, access, min_stake, capacity, host_id)
      VALUES (${slug}, 'Session race', 'general', 'free', 0, 10, ${HOST_ID})
      RETURNING id
    `;
    const session = await academy.scheduleSession({
      roomId: rooms[0]!.id,
      hostId: HOST_ID,
      title: 'Session race',
      startsAt: new Date('2026-10-11T00:00:00.000Z'),
    });
    return { academy, session };
  }

  it('closes a delayed room recreation while the end deletion acknowledgement is paused', async () => {
    const bothOpenCallsStarted = deferred<void>();
    const roomCreated = deferred<void>();
    const firstRoomDeleted = deferred<void>();
    const acknowledgeFirstClose = deferred<void>();
    const allowRoomOpen = deferred<string>();
    const activeRooms = new Set<string>();
    const closed: string[] = [];
    let openCalls = 0;
    const stream: StreamProvider = {
      id: 'livekit',
      openRoom: async () => {
        openCalls += 1;
        if (openCalls === 2) bothOpenCallsStarted.resolve();
        if (openCalls === 1) {
          await bothOpenCallsStarted.promise;
          activeRooms.add('same-session-room');
          return 'same-session-room';
        }
        roomCreated.resolve();
        const room = await allowRoomOpen.promise;
        activeRooms.add(room);
        return room;
      },
      closeRoom: async (room) => {
        closed.push(room);
        activeRooms.delete(room);
        if (closed.length === 1) {
          firstRoomDeleted.resolve();
          await acknowledgeFirstClose.promise;
        }
      },
      credential: async () => ({
        url: 'wss://stream.example',
        token: 't',
        expiresAt: new Date('2026-10-07T01:00:00.000Z'),
      }),
    };
    const { academy, session } = await scheduledSession('delayed-start-end-race', stream);

    const starting = [
      academy.startSession({ sessionId: session.id, hostId: HOST_ID }),
      academy.startSession({ sessionId: session.id, hostId: HOST_ID }),
    ];
    await bothOpenCallsStarted.promise;
    await roomCreated.promise;
    await Promise.any(starting);
    const ending = academy.endSession({ sessionId: session.id, hostId: HOST_ID });
    await firstRoomDeleted.promise;
    allowRoomOpen.resolve('same-session-room');
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled(starting);
    } finally {
      acknowledgeFirstClose.resolve();
      await ending;
    }
    expect((await ending).status).toBe('ended');

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await academy.session(session.id)).status).toBe('ended');
    expect(closed).toEqual(['same-session-room', 'same-session-room']);
    expect(activeRooms.size).toBe(0);
  });

  it.each(['ended', 'cancelled', 'missing'] as const)(
    'refuses a paused join after its locked session becomes %s',
    async (terminalStatus) => {
      const guestId = '44444444-4444-4444-8444-444444444444';
      const stakeStarted = deferred<void>();
      const finishStake = deferred<bigint>();
      const delayedStakes: StakeSource = {
        stakeOf: async () => {
          stakeStarted.resolve();
          return finishStake.promise;
        },
      };
      const stream = new NullStreamProvider();
      const scheduled = await scheduledSession(`paused-join-${terminalStatus}`, stream);
      const academy = new AcademyService(db.sql, delayedStakes, hostCanOpen, stream, {});
      await db.sql`UPDATE academy.rooms SET access = 'staked', min_stake = 1 WHERE id = ${scheduled.session.roomId}`;
      await academy.startSession({ sessionId: scheduled.session.id, hostId: HOST_ID });
      await db.sql`INSERT INTO academy.session_attendees (session_id, user_id) VALUES (${scheduled.session.id}, ${guestId})`;
      const joining = academy.join({ sessionId: scheduled.session.id, userId: guestId });
      await stakeStarted.promise;
      try {
        if (terminalStatus === 'ended') await academy.endSession({ sessionId: scheduled.session.id, hostId: HOST_ID });
        else if (terminalStatus === 'cancelled') {
          await db.sql`UPDATE academy.sessions SET status = 'cancelled' WHERE id = ${scheduled.session.id}`;
          await db.sql`UPDATE academy.session_attendees SET left_at = now() WHERE session_id = ${scheduled.session.id}`;
        } else await db.sql`DELETE FROM academy.sessions WHERE id = ${scheduled.session.id}`;
      } finally {
        finishStake.resolve(parseAmount('1'));
      }
      await expect(joining).rejects.toMatchObject({ code: 'academy.session_not_live' });
      expect(await academy.occupancy(scheduled.session.id)).toBe(0);
      if (terminalStatus !== 'missing') expect((await academy.session(scheduled.session.id)).status).toBe(terminalStatus);
    },
  );

  it.each([
    { deleted: false, retryAcknowledged: true },
    { deleted: true, retryAcknowledged: true },
    { deleted: true, retryAcknowledged: false },
  ])('end retains recoverable terminal state after provider close failure: %j', async ({ deleted, retryAcknowledged }) => {
    const activeRooms = new Set<string>();
    let closeCalls = 0;
    const stream = new LiveKitStreamProvider({
      url: 'wss://stream.example',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      fetch: async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { name?: string; room?: string };
        if (payload.name) {
          activeRooms.add(payload.name);
          return new Response(JSON.stringify({ name: payload.name }), { status: 200 });
        }
        const room = payload.room!;
        closeCalls += 1;
        if (closeCalls === 1) {
          if (deleted) activeRooms.delete(room);
          throw new Error(deleted ? 'delete acknowledgement lost' : 'delete transport failed');
        }
        if (!retryAcknowledged) return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
        activeRooms.delete(room);
        return new Response('{}', { status: 200 });
      },
    });
    const { academy, session } = await scheduledSession(`retry-close-${deleted}-${retryAcknowledged}`, stream);
    const started = await academy.startSession({ sessionId: session.id, hostId: HOST_ID });
    await db.sql`INSERT INTO academy.session_attendees (session_id, user_id) VALUES (${session.id}, ${HOST_ID})`;
    const endedAt = new Date('2026-10-11T01:00:00.000Z');
    await expect(academy.endSession({ sessionId: session.id, hostId: HOST_ID, now: endedAt })).rejects.toThrow(/delete/);
    const terminal = await academy.session(session.id);
    expect(terminal.status).toBe('ended');
    expect(terminal.endsAt).toEqual(endedAt);
    expect(terminal.streamRoom).toBe(started.streamRoom);
    expect(await academy.occupancy(session.id)).toBe(0);
    await expect(academy.startSession({ sessionId: session.id, hostId: HOST_ID })).rejects.toMatchObject({
      code: 'academy.session_not_live',
    });
    const retry = academy.endSession({ sessionId: session.id, hostId: HOST_ID, now: new Date('2026-10-11T02:00:00.000Z') });
    if (retryAcknowledged) await retry;
    else await expect(retry).rejects.toMatchObject({ code: 'academy.stream_unavailable' });
    const retried = await academy.session(session.id);
    expect(retried.status).toBe('ended');
    expect(retried.endsAt).toEqual(endedAt);
    expect(activeRooms.size).toBe(0);
    expect(closeCalls).toBe(2);
    await expect(academy.endSession({ sessionId: session.id, hostId: SESSION_ID })).rejects.toMatchObject({ code: 'academy.not_host' });
    expect(closeCalls).toBe(2);
  });

  it('keeps the shared provider room open for the start that won the live update', async () => {
    const twoOpensStarted = deferred<void>();
    const allowRoomOpen = deferred<string>();
    const activeRooms = new Set<string>();
    const closed: string[] = [];
    let openCalls = 0;
    const stream: StreamProvider = {
      id: 'livekit',
      openRoom: async () => {
        openCalls += 1;
        if (openCalls === 2) twoOpensStarted.resolve();
        const room = await allowRoomOpen.promise;
        activeRooms.add(room);
        return room;
      },
      closeRoom: async (room) => {
        closed.push(room);
        activeRooms.delete(room);
      },
      credential: async () => ({
        url: 'wss://stream.example',
        token: 't',
        expiresAt: new Date('2026-10-07T01:00:00.000Z'),
      }),
    };
    const { academy, session } = await scheduledSession('shared-room-start-race', stream);

    const starts = [
      academy.startSession({ sessionId: session.id, hostId: HOST_ID }),
      academy.startSession({ sessionId: session.id, hostId: HOST_ID }),
    ];
    await twoOpensStarted.promise;
    allowRoomOpen.resolve('shared-session-room');
    const results = await Promise.allSettled(starts);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await academy.session(session.id)).status).toBe('live');
    expect((await academy.session(session.id)).streamRoom).toBe('shared-session-room');
    expect(closed).toEqual([]);
    expect(activeRooms).toEqual(new Set(['shared-session-room']));
  });
});
