/**
 * svc-ws's record (`WS_SBE_CONSUMERS`): every sample reaches its verdict through the door svc-ws serves, the reply parses
 * by the record, and every refusal the door sends is one the record names, with the status the record gives it.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { WS_SBE_CONSUMERS } from '@intafaced/contracts/ws-procedures';
import { SbeConsumers, registerSbeStatusDoor } from './sbe-consumers.js';

const KEY = 'a-ws-sample-read-key-that-is-long-enough';
const STATUS: Record<string, number> = { SERVICE_UNAVAILABLE: 503, UNAUTHORIZED: 401, FORBIDDEN: 403 };

function door(secret: string | undefined) {
  const app = Fastify({ logger: false });
  const consumers = new SbeConsumers(() => new Date('2026-11-19T00:00:00.000Z'));
  consumers.add('BTC-USD').sent('9');
  registerSbeStatusDoor(app, { consumers, secret, codecLinked: () => true });
  return app;
}

describe('WS_SBE_CONSUMERS samples and refusals', () => {
  it('every accepted sample is answered with a reply the record parses', async () => {
    const app = door(KEY);
    for (const sample of WS_SBE_CONSUMERS.samples) {
      expect(sample.verdict).toBe('accept');
      const res = await app.inject({
        method: WS_SBE_CONSUMERS.method,
        url: WS_SBE_CONSUMERS.path,
        headers: serviceAuthHeadersForBody(WS_SBE_CONSUMERS.access.callers[0], KEY, ''),
      });
      expect(res.statusCode).toBe(200);
      expect(WS_SBE_CONSUMERS.output.parse(res.json())).toEqual(res.json());
    }
    await app.close();
  });

  it('each refusal the door sends is named by the record with its status', async () => {
    const keyed = door(KEY);
    const blank = door(undefined);
    const answers = [
      await blank.inject({ method: 'GET', url: WS_SBE_CONSUMERS.path }),
      await keyed.inject({ method: 'GET', url: WS_SBE_CONSUMERS.path }),
      await keyed.inject({ method: 'GET', url: WS_SBE_CONSUMERS.path, headers: serviceAuthHeadersForBody('svc-trade', KEY, '') }),
    ];
    const seen = answers.map((res) => {
      const code = (res.json() as { error: { code: string } }).error.code;
      expect(res.statusCode).toBe(STATUS[WS_SBE_CONSUMERS.refusals[code] ?? 'missing']);
      return code;
    });
    expect(seen.sort()).toEqual(Object.keys(WS_SBE_CONSUMERS.refusals).sort());
    await keyed.close();
    await blank.close();
  });
});
