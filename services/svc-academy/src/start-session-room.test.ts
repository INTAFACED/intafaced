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
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Sql } from 'postgres';
import { AcademyService } from './academy-service.js';
import { AcademyError } from './errors.js';
import type { HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import type { StreamProvider } from './stream/provider.js';

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

  it('closes a room opened after the session ended while openRoom was delayed', async () => {
    const bothOpenCallsStarted = deferred<void>();
    const roomCreated = deferred<void>();
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
    const ended = await academy.endSession({ sessionId: session.id, hostId: HOST_ID });
    expect(ended.status).toBe('ended');

    allowRoomOpen.resolve('same-session-room');
    const results = await Promise.allSettled(starting);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await academy.session(session.id)).status).toBe('ended');
    expect(closed).toEqual(['same-session-room', 'same-session-room']);
    expect(activeRooms.size).toBe(0);
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
