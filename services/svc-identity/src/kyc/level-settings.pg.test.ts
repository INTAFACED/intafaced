/**
 * Per-level requirements and review times against Postgres (I-kyc-compliance-05, J-identity-20 #7): a change waits for a
 * second person; the proposer cannot approve it; an approved change is in force, minutes exact; a restore goes back to the
 * owner's published values; one change waits per level; only the proposer withdraws.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { KycLevelSettingsDesk, KycLevelSettingsError } from './level-settings.js';
import { parseKycRequirementsByLevel, parseKycReviewHoursByLevel } from './levels.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const db: TestDb = await createTestDb({
  service: 'identity',
  url: identityTestUrl(),
  migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
});
afterAll(async () => {
  await db.drop();
});

const desk = new KycLevelSettingsDesk(db.sql, {
  requirements: parseKycRequirementsByLevel('{"basic":["legal_name","date_of_birth"]}'),
  reviewHours: parseKycReviewHoursByLevel('basic=24'),
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof KycLevelSettingsError ? err.code : String(err);
  }
}

describe('KYC level settings', () => {
  it('a change waits for a different person, then is in force; a restore goes back to the published values', async () => {
    const start = await desk.effective();
    expect(start.reviewMinutes.get('basic')).toBe(1440);
    expect(start.reviewMinutes.has('institutional')).toBe(false);
    const change = await desk.propose('compliance-a', { level: 'institutional', restore: false, requirements: null, reviewMinutes: 1 });
    expect(change.state).toBe('waiting');
    expect((await desk.effective()).reviewMinutes.has('institutional')).toBe(false);
    expect(await code(desk.propose('compliance-b', { level: 'institutional', restore: false, requirements: null, reviewMinutes: 5 }))).toBe(
      'kyc.level_change_waiting',
    );
    expect(await code(desk.approve(change.id, 'compliance-a'))).toBe('kyc.same_reviewer');
    expect((await desk.approve(change.id, 'founder-b')).state).toBe('applied');
    const now = await desk.effective();
    expect(now.reviewMinutes.get('institutional')).toBe(1);
    // One minute is not whole hours, so the ladder's hours read none and its minutes are exact.
    expect(now.reviewHours.has('institutional')).toBe(false);
    expect(await code(desk.approve(change.id, 'founder-b'))).toBe('kyc.level_change_state');
    const view = await desk.read();
    expect(view.levels.find((l) => l.level === 'institutional')).toMatchObject({ reviewMinutes: 1, edited: true });
    const back = await desk.propose('compliance-a', { level: 'institutional', restore: true, requirements: null, reviewMinutes: null });
    await desk.approve(back.id, 'founder-b');
    expect((await desk.effective()).reviewMinutes.has('institutional')).toBe(false);
    expect((await desk.read()).levels.find((l) => l.level === 'institutional')?.edited).toBe(false);
  });

  it('refuses a requirement the platform does not know, and only the proposer withdraws', async () => {
    expect(await code(desk.propose('a', { level: 'full', restore: false, requirements: ['not_a_requirement'], reviewMinutes: null }))).toBe(
      'kyc.requirement_unknown',
    );
    const change = await desk.propose('a', { level: 'full', restore: false, requirements: ['legal_name'], reviewMinutes: 120 });
    expect(await code(desk.withdraw(change.id, 'b'))).toBe('kyc.level_change_state');
    expect((await desk.withdraw(change.id, 'a')).state).toBe('withdrawn');
    expect((await desk.effective()).requirements.has('full')).toBe(false);
  });
});
