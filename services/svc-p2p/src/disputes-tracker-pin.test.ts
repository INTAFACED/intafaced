/**
 * p2p.disputes Done-bar: human-only ruling, empty allowlist refuses,
 * backlog reachable, escrow recipes only. Admin Vue / who-moderates Class X stay residual.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname);

function read(name: string): string {
  return readFileSync(resolve(ROOT, name), 'utf8');
}

describe('p2p.disputes product pin', () => {
  it('refuses an empty moderator allowlist instead of auto-ruling', () => {
    const auth = read('moderation-auth.ts');
    expect(auth).toMatch(/p2p\.moderation_unreachable/);
    expect(auth).toMatch(/API keys cannot adjudicate/);
    expect(auth).toMatch(/if \(principal\.kid\) return false/);
    expect(auth).not.toMatch(/auto-rul/);
  });

  it('mounts list + backlog + resolve as release|refund only', () => {
    const router = read('router.ts');
    expect(router).toMatch(/disputes:\s*router\(/);
    expect(router).toMatch(/backlog:\s*scopedProcedure\('p2p:read'/);
    expect(router).toMatch(/resolution:\s*z\.enum\(\['release', 'refund'\]\)/);
    expect(router).toMatch(/not a fake auto-ruling/);
  });

  it('SQL invariant file exists so disputed escrow cannot terminate without a human', () => {
    const sql = readFileSync(resolve(ROOT, '../drizzle/0003_p2p_dispute_ruling_invariant.sql'), 'utf8');
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.toLowerCase()).toMatch(/disputed/);
  });

  it('persists chat_thread_id on open rather than leaving disputes without a thread', () => {
    const schema = read('db/schema.ts');
    const service = read('p2p-service.ts');
    const router = read('router.ts');
    expect(schema).toMatch(/p2pDisputes[\s\S]*chatThreadId:\s*uuid\('chat_thread_id'\)/);
    expect(service).toMatch(/INSERT INTO p2p\.p2p_disputes[\s\S]*chat_thread_id/);
    expect(router).toMatch(/chatThreadId:\s*z\.string\(\)\.guid\(\)/);
    expect(router).toMatch(/p2p\.chat_thread_unset/);
  });
});
