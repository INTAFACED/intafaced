import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';

const drizzle = new URL('../drizzle/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, drizzle), 'utf8');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map(read);
const downFile = '0014_p2p_escrow_lock_attempts.down.sql';
const upFile = '0014_p2p_escrow_lock_attempts.sql';
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const TRADE = '00000000-0000-4000-8000-0000000000a6';
const OFFER = '00000000-0000-4000-8000-0000000000f0';
const run = promisify(execFile);
const runner = fileURLToPath(new URL('../scripts/migrate.ts', import.meta.url));
const compiledRunner = join(dirname(runner), '.migration-down-runner.mjs');

/**
 * Strip the runner once. Three `--import tsx` boots each recompile this CLI
 * (cold `node --import tsx` was 173–234ms before any query, 2026-10-18). The
 * compiled file sits next to `migrate.ts` so `import.meta.url` still resolves
 * `../drizzle`.
 */
function compileRunner(): void {
  const tsxPackage = createRequire(fileURLToPath(import.meta.url)).resolve('tsx/package.json');
  const { transformSync } = createRequire(tsxPackage)('esbuild') as {
    transformSync: (source: string, options: { loader: 'ts'; format: 'esm'; target: 'node20' }) => { code: string };
  };
  const { code } = transformSync(readFileSync(runner, 'utf8'), { loader: 'ts', format: 'esm', target: 'node20' });
  writeFileSync(compiledRunner, code);
}

describe('native transactional P2P counter down', () => {
  it('excludes an actual service claim before the guard and retains its history through DDL rollback', async () => {
    const db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    let release!: () => void;
    try {
      await db.sql`INSERT INTO p2p.offers(id,maker_id,side,asset,fiat_currency,price_type,price,min_amt,max_amt,total_amt,remaining_amt,methods) VALUES(${OFFER},${SELLER},'sell','USDT','USD','fixed','1','10','500','500','400','["sepa"]')`;
      await db.sql`INSERT INTO p2p.p2p_trades(id,offer_id,taker_id,maker_id,seller_id,buyer_id,asset,fiat_currency,amount,price,fiat_amount,method,fee_bps,status,deadline_at) VALUES(${TRADE},${OFFER},${BUYER},${SELLER},${SELLER},${BUYER},'USDT','USD','100','1','100','sepa',100,'created',now()+interval '1 hour')`;
      await expect(db.sql.unsafe('LOCK TABLE p2p.p2p_trades IN ACCESS EXCLUSIVE MODE')).rejects.toThrow(/transaction blocks/);
      const source = read(downFile);
      const split = source.indexOf('DROP TRIGGER');
      expect(split).toBeGreaterThan(0);
      let signal!: () => void;
      const guarded = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const down = db.sql
        .begin(async (tx) => {
          await tx.unsafe(source.slice(0, split));
          signal();
          await gate;
          await tx.unsafe(source.slice(split));
          throw new Error('fixture rollback after complete counter DDL');
        })
        .catch((error) => error as Error);
      await guarded;
      const service = new P2pService(db.sql, new MemoryLedger(), new MemoryEventBus('svc-p2p'), {
        instruments: new InstrumentService(db.sql),
        feeBps: 100,
      });
      const claim = (service as unknown as { claimEscrowLockAttempt(id: string): Promise<string | null> }).claimEscrowLockAttempt(TRADE);
      let claimSettled = false;
      void claim.then(
        () => (claimSettled = true),
        () => (claimSettled = true),
      );
      try {
        // Wait for the condition, not a fixed 1s: under CI load the claim can take longer than that just to reach the
        // database. A claim that finished without ever blocking is the real failure, so it ends the wait at once.
        let blocked = false;
        for (let i = 0; i < 2000 && !blocked && !claimSettled; i++) {
          const [row] = await db.sql<
            { blocked: number }[]
          >`SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%p2p_trades%'`;
          blocked = Boolean(row?.blocked);
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
      }
      expect(await down).toMatchObject({ message: 'fixture rollback after complete counter DDL' });
      expect(await claim).toBe('1');
      expect((await db.sql`SELECT escrow_lock_attempts::text AS attempts FROM p2p.p2p_trades WHERE id=${TRADE}`)[0]?.attempts).toBe('1');
      await expect(
        db.sql.begin(async (tx) => {
          await tx.unsafe(read(downFile));
        }),
      ).rejects.toThrow(/refusing to remove unresolved/);
    } finally {
      release?.();
      await db.drop();
    }
  });

  it('runs the production down runner atomically with tracking, restoring DDL on tracking failure', async () => {
    compileRunner();
    let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    try {
      db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations: [] });
      const invoke = (args: string[]) =>
        run(process.execPath, [compiledRunner, ...args], {
          env: { ...process.env, DATABASE_URL: db!.url },
          timeout: 5000,
          killSignal: 'SIGKILL',
        });
      await invoke([]);
      expect(await db.sql`SELECT name FROM p2p.__migrations WHERE name=${upFile}`).toHaveLength(1);
      await db.sql.unsafe(
        `CREATE FUNCTION p2p.fixture_fail_tracking_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.name='${upFile}' THEN RAISE EXCEPTION 'fixture migration tracking delete failed'; END IF; RETURN OLD; END $$`,
      );
      await db.sql.unsafe(
        'CREATE TRIGGER fixture_fail_tracking_delete BEFORE DELETE ON p2p.__migrations FOR EACH ROW EXECUTE FUNCTION p2p.fixture_fail_tracking_delete()',
      );
      await expect(invoke(['--down'])).rejects.toThrow(/fixture migration tracking delete failed/);
      expect(
        await db.sql`SELECT column_name FROM information_schema.columns WHERE table_schema='p2p' AND table_name='p2p_trades' AND column_name='escrow_lock_attempts'`,
      ).toHaveLength(1);
      expect(await db.sql`SELECT name FROM p2p.__migrations WHERE name=${upFile}`).toHaveLength(1);
      expect(await db.sql`SELECT tgname FROM pg_trigger WHERE tgname='p2p_trades_lock_attempts_monotonic_trg'`).toHaveLength(1);
      await db.sql.unsafe('DROP TRIGGER fixture_fail_tracking_delete ON p2p.__migrations');
      await db.sql.unsafe('DROP FUNCTION p2p.fixture_fail_tracking_delete()');
      await invoke(['--down']);
      expect(await db.sql`SELECT name FROM p2p.__migrations`).toHaveLength(0);
      expect((await db.sql`SELECT to_regclass('p2p.p2p_trades') AS trades`)[0]?.trades).toBeNull();
    } finally {
      await db?.drop();
      try {
        unlinkSync(compiledRunner);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }, 15000);
});
