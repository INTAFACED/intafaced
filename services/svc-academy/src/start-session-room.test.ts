/**
 * A start whose conditional update matches no row was not started by this call.
 * That call must not come back as success, and a stream room opened for the
 * attempt must not stay open.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { AcademyService } from './academy-service.js';
import { AcademyError } from './errors.js';
import type { HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import type { StreamProvider } from './stream/provider.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';

const stakes: StakeSource = { stakeOf: async () => 0n };
const hostRights: HostRightsSource = {
  perksOf: async () => {
    throw new Error('start does not consult host rights');
  },
};

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
