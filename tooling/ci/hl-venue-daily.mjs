#!/usr/bin/env node
// The venue files the daily Hyperliquid run takes (.github/workflows/hl-venue-daily.yml): every
// `apps/customer/tests/real-app/*-venue.pw.mjs` that opts in by calling `hyperliquidForThisFile(test, '<recording>')`
// exactly once, with its recording's name written out. That run sets HL_VENUE_LIVE=1 and HL_TESTNET_TRADER_KEY, so an
// opted-in file runs on the live test network and writes packages/venue-hyperliquid/recordings/<recording>.json; every
// other run replays that recording. No file opts in yet, so the run finds none and does nothing.
// `node tooling/ci/hl-venue-daily.mjs files` prints their names, space-separated (Playwright's JOURNEY_FILES), and nothing
// when no file opts in. A call it can't read fails the run by the file's name, so a file is never left out quietly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REAL_APP = path.join(REPO, 'apps', 'customer', 'tests', 'real-app');

const CALL = /\bhyperliquidForThisFile\s*\(/g;
const NAMED = /\bhyperliquidForThisFile\s*\(\s*test\s*,\s*(['"])([A-Za-z0-9][A-Za-z0-9._-]*)\1\s*\)/g;

/** A venue file's opt-in: its recording's name, null when it does not opt in. Throws on a call it can't read. */
export function optIn(name, text) {
  const calls = text.match(CALL)?.length ?? 0;
  if (calls === 0) return null;
  const named = [...text.matchAll(NAMED)].map((m) => m[2]);
  if (calls !== 1 || named.length !== 1)
    throw new Error(`${name}: call hyperliquidForThisFile(test, '<recording>') exactly once, with the recording's name written out`);
  return named[0];
}

/** The opted-in venue files of `dir`, by name, sorted. */
export function optedInFiles(dir = REAL_APP, read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('-venue.pw.mjs'))
    .sort()
    .filter((f) => optIn(f, read(f)) !== null);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== 'files') {
    console.error('usage: node tooling/ci/hl-venue-daily.mjs files');
    process.exit(2);
  }
  process.stdout.write(optedInFiles().join(' '));
}
