#!/usr/bin/env node
/**
 * LOCAL TEST LISTING — lists the extra LOCAL TEST pairs on the LOCAL test stack only.
 *
 *   pnpm local:market:list          list the pairs (and the base assets they need) that are not listed yet, then open them
 *   pnpm local:market:list plan     print what it would add; changes nothing, needs no stack
 *   pnpm local:market:list status   read-only: which pairs are listed on this stack
 *   --no-gates                      list only; skip the LOCAL TEST lifecycle and book-opening step afterwards
 *
 * Why it exists: the production listing path is a row in the instrument catalogue
 * (packages/contracts/src/instruments.ts) plus the same row in svc-trade's seed migration, and a
 * `ledger.assets` row for every asset ("adding an asset is a data change, never a code change",
 * svc-ledger migration 0004). `TradeService.listMarket` exists but no route or operator surface mounts it. Adding
 * seventeen pairs to the production catalogue would be a product decision and a production migration, so on the
 * local test stack only this script applies the same two rows to the local test database, with the same columns
 * as the seed, idempotently (ON CONFLICT DO NOTHING: a market an operator has since halted stays halted).
 * Planes are `fiat` only: svc-protocol has no book for these, and the seed's own rule is not to advertise one.
 *
 * Then, because a listed market is still closed (no lifecycle publication, no book in matching), it runs
 * `local-test-gates.mjs apply`, the documented LOCAL TEST stand-in for the owner's publication and the
 * two-person book opening.
 *
 * Containment (failure it prevents: writing a listing into a database that is not the local test one): refuses
 * unless the state directory and LOCAL-TEST-STACK.json marker exist, the marker names database
 * 127.0.0.1:<its own Postgres port>, and Postgres answers on that port. It writes only as the stack's own
 * `svc_ledger` and `svc_trade` roles, and only the two tables above. Nothing here touches a balance.
 *
 * Docs: docs/LOCAL-TEST-STACK.md ("Living test market")
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GuardError, assertLocalTarget } from './local-test-market.mjs';
import { LOCAL_PAIRS, LOCAL_TEST_LABEL, localOnlyAssets, localOnlyPairs } from './local-test-pairs.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const PG_BIN = '/opt/homebrew/bin';
const DB_NAME = 'intafaced_local_test';

const IDENT = /^[A-Z0-9]{2,12}$/;
const SYMBOL = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const NAME = /^[A-Za-z0-9 .()-]{1,40}$/;
const need = (re, v, what) => {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`refusing: ${what} "${String(v)}" has an unexpected shape`);
  return v;
};

/** SQL for svc-ledger: one `ledger.assets` row per base asset (kind crypto). Idempotent. Returns the ids it added. */
export function assetsSql(assets = localOnlyAssets()) {
  if (assets.length === 0) return null;
  const rows = assets.map(
    (a) =>
      `('${need(IDENT, a.id, 'asset id')}', 'crypto', ${Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 18 ? a.decimals : 8})`,
  );
  return `INSERT INTO "ledger"."assets" ("id", "kind", "decimals") VALUES\n  ${rows.join(',\n  ')}\nON CONFLICT ("id") DO NOTHING\nRETURNING "id";`;
}

/** SQL for svc-trade: one `trade.markets` row per pair, the columns and values of the seed migration. Idempotent. */
export function marketsSql(pairs = localOnlyPairs()) {
  if (pairs.length === 0) return null;
  const rows = pairs.map((p) => {
    const lot = need(DECIMAL, p.lot, 'lot');
    return (
      `('${need(SYMBOL, p.symbol, 'symbol')}', '${need(IDENT, p.base, 'base')}', '${need(IDENT, p.quote, 'quote')}', '${need(NAME, p.name, 'name')}', ` +
      `'crypto', 'spot', 'unit', 1, NULL, ${need(DECIMAL, p.tick, 'tick')}, ${lot}, ${lot}, ${need(DECIMAL, p.minNotional, 'min notional')}, ` +
      `'crypto-24x7', ARRAY['fiat']::text[], 'active', 10, 20, now())`
    );
  });
  return (
    `INSERT INTO "trade"."markets" (\n  "symbol", "base_asset", "quote_asset", "display_name", "asset_class", "kind",\n  "quote_unit", "unit_size", "pip_size", "tick_size", "lot_size", "min_qty",\n` +
    `  "min_notional", "schedule", "planes", "status", "maker_bps", "taker_bps", "listed_at"\n) VALUES\n  ${rows.join(',\n  ')}\nON CONFLICT ("symbol") DO NOTHING\nRETURNING "symbol";`
  );
}

/** Throws GuardError unless this is the local test stack and its own Postgres. Returns what the psql calls need. */
export function assertLocalDatabase({ home } = {}) {
  const base = assertLocalTarget({ ...(home ? { home } : {}), urls: [] });
  const { marker, paths: p } = base;
  const db = marker.database;
  const pgPort = marker.ports?.postgres;
  if (!db || db.host !== '127.0.0.1' || String(db.port) !== String(pgPort) || db.name !== DB_NAME)
    throw new GuardError(`refusing: the marker does not name database ${DB_NAME} on 127.0.0.1 at the stack's own Postgres port`);
  assertLocalTarget({ ...(home ? { home } : {}), urls: [`http://127.0.0.1:${pgPort}`] });
  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(p.secrets, 'utf8'));
  } catch {
    throw new GuardError('refusing: the stack secrets file is unreadable');
  }
  if (!secrets.pgService) throw new GuardError('refusing: the stack secrets file has no service database password');
  return { port: pgPort, password: secrets.pgService, paths: p };
}

function psql(conn, role, sql) {
  if (!fs.existsSync(`${PG_BIN}/psql`)) throw new Error(`psql not found at ${PG_BIN}`);
  const r = spawnSync(`${PG_BIN}/psql`, ['-X', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: sql,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      PGHOST: '127.0.0.1',
      PGPORT: String(conn.port),
      PGUSER: role,
      PGPASSWORD: conn.password,
      PGDATABASE: DB_NAME,
    },
  });
  if (r.status !== 0) throw new Error(`psql as ${role} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout.split('\n').filter(Boolean);
}

export function describePairs() {
  const added = localOnlyPairs();
  return [
    `${LOCAL_TEST_LABEL}`,
    `would list ${added.length} pairs (${added.map((p) => p.symbol).join(', ')})`,
    `and register ${localOnlyAssets().length} base assets in the local ledger (${localOnlyAssets()
      .map((a) => a.id)
      .join(', ')})`,
    `the other ${LOCAL_PAIRS.length - added.length} pairs in the table are already in the production catalogue`,
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith('--')) ?? 'apply';
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  for (const f of flags) if (f !== '--no-gates') throw new Error(`unknown option ${f}`);
  if (!['apply', 'plan', 'status'].includes(cmd)) {
    process.stderr.write(`local-test-listing: unknown command "${cmd}". Use: apply | plan | status\n`);
    process.exit(2);
  }
  if (cmd === 'plan') {
    console.log(describePairs());
    console.log(`\n-- svc-ledger --\n${assetsSql()}\n\n-- svc-trade --\n${marketsSql()}`);
    return;
  }
  let conn;
  try {
    conn = assertLocalDatabase();
  } catch (err) {
    if (err instanceof GuardError) {
      process.stderr.write(`\nlocal-test-listing: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  if (cmd === 'status') {
    const listed = new Set(psql(conn, 'svc_trade', 'SELECT symbol FROM trade.markets;'));
    const assets = new Set(psql(conn, 'svc_ledger', 'SELECT id FROM ledger.assets;'));
    const rows = localOnlyPairs();
    const have = rows.filter((p) => listed.has(p.symbol) && assets.has(p.base));
    console.log(`LOCAL TEST pairs listed on this stack: ${have.length} of ${rows.length}`);
    for (const p of rows.filter((x) => !have.includes(x)))
      console.log(`  missing ${p.symbol}${assets.has(p.base) ? '' : ` (asset ${p.base} not in the ledger)`}`);
    return;
  }
  // The ledger asset first: a market whose asset has no row fails at the first ledger post.
  const addedAssets = psql(conn, 'svc_ledger', assetsSql());
  const addedMarkets = psql(conn, 'svc_trade', marketsSql());
  console.log(`${LOCAL_TEST_LABEL}`);
  console.log(`registered ${addedAssets.length} new assets in the local ledger${addedAssets.length ? `: ${addedAssets.join(', ')}` : ''}`);
  console.log(
    `listed ${addedMarkets.length} new pairs on the local stack${addedMarkets.length ? `: ${addedMarkets.join(', ')}` : ' (all were already listed)'}`,
  );
  if (flags.has('--no-gates')) return console.log('skipped the LOCAL TEST stand-ins; run: node tooling/scripts/local-test-gates.mjs apply');
  console.log('\nopening them (LOCAL TEST lifecycle publication and book opening): node tooling/scripts/local-test-gates.mjs apply');
  const r = spawnSync(process.execPath, [path.join(path.dirname(SCRIPT), 'local-test-gates.mjs'), 'apply'], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
