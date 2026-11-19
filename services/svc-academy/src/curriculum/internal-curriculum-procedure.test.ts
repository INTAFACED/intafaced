/**
 * svc-academy's record (`ACADEMY_INTERNAL_CURRICULUM`): every sample reaches its verdict through the door svc-academy
 * serves, the reply parses by the record, and every refusal the door sends is one the record names, with the status the
 * record gives it.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { ACADEMY_INTERNAL_CURRICULUM } from '@intafaced/contracts/academy-procedures';
import { registerInternalCurriculumRoute } from './internal-curriculum.js';

const SECRET = 'academy-curriculum-record-test-secret-32ch';
const STATUS: Record<string, number> = { UNAUTHORIZED: 401 };
const REFUSALS: Readonly<Record<string, string>> = ACADEMY_INTERNAL_CURRICULUM.refusals;

async function door() {
  const app = Fastify({ logger: false });
  registerInternalCurriculumRoute(app, SECRET);
  await app.ready();
  return app;
}

describe('ACADEMY_INTERNAL_CURRICULUM samples and refusals', () => {
  it('every accepted sample is answered with a reply the record parses', async () => {
    const app = await door();
    for (const sample of ACADEMY_INTERNAL_CURRICULUM.samples) {
      expect(sample.verdict).toBe('accept');
      const res = await app.inject({
        method: ACADEMY_INTERNAL_CURRICULUM.method,
        url: ACADEMY_INTERNAL_CURRICULUM.path,
        headers: serviceAuthHeadersForBody(ACADEMY_INTERNAL_CURRICULUM.access.callers[0], SECRET, ''),
      });
      expect(res.statusCode).toBe(200);
      const body = ACADEMY_INTERNAL_CURRICULUM.output.parse(res.json());
      expect(body).toEqual(res.json());
      expect(body.items.length).toBeGreaterThan(0);
    }
    await app.close();
  });

  it('each refusal the door sends is named by the record with its status', async () => {
    const app = await door();
    const answers = [
      await app.inject({ method: 'GET', url: ACADEMY_INTERNAL_CURRICULUM.path }),
      await app.inject({
        method: 'GET',
        url: ACADEMY_INTERNAL_CURRICULUM.path,
        headers: serviceAuthHeadersForBody('svc-trade', SECRET, ''),
      }),
    ];
    const seen = new Set(
      answers.map((res) => {
        const code = (res.json() as { code: string }).code;
        expect(res.statusCode).toBe(STATUS[REFUSALS[code] ?? 'missing']);
        return code;
      }),
    );
    expect([...seen].sort()).toEqual(Object.keys(ACADEMY_INTERNAL_CURRICULUM.refusals).sort());
    await app.close();
  });
});
