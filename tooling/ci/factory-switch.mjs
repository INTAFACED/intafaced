#!/usr/bin/env node
/**
 * The factory switch (owner decision 2026-11-07): the one-line file `FACTORY` on the branch `factory-switch`. A merge-seal
 * step in ci.yml runs the default branch's copy of this file on every pull request and merge queue commit. Only `run`
 * passes. `pause`, a missing branch or file, an unreadable answer or any other text fails the seal, whoever opened the
 * pull request. Flipping the switch is a push to that branch, never a pull request, so a pause never blocks the change
 * that lifts it. Builders read it with:
 *   gh api -H 'Accept: application/vnd.github.raw' 'repos/INTAFACED/intafaced/contents/FACTORY?ref=factory-switch'
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SWITCH_BRANCH = 'factory-switch';
export const SWITCH_FILE = 'FACTORY';

/** The switch's verdict from the file's text: only `run` (surrounding whitespace allowed) lets a merge through. */
export function judgeSwitch(text) {
  const state = typeof text === 'string' ? text.trim() : '';
  if (state === 'run') return { pass: true, state };
  // Quoted and cut short, so the file's text can't add lines (or workflow commands) to the log.
  return { pass: false, state, why: `${SWITCH_FILE} on branch ${SWITCH_BRANCH} says ${JSON.stringify(state.slice(0, 40))}, not "run"` };
}

/** Reads the file's raw text through the contents API; any non-200 answer throws, so the seal fails closed. */
export async function readSwitch({ repo, token, fetchImpl = fetch }) {
  const path = `/repos/${repo}/contents/${SWITCH_FILE}?ref=${SWITCH_BRANCH}`;
  const res = await fetchImpl(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw' },
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const { REPO, GH_TOKEN } = process.env;
  if (!REPO || !GH_TOKEN) throw new Error('factory-switch needs REPO and GH_TOKEN');
  const verdict = judgeSwitch(await readSwitch({ repo: REPO, token: GH_TOKEN }));
  if (!verdict.pass) {
    console.error(`::error title=Factory paused::${verdict.why}, so nothing merges (owner decision 2026-11-07).`);
    process.exit(1);
  }
  console.log('FACTORY=run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::error title=Factory switch unreadable::${e.message}; the seal fails closed, so nothing merges`);
    process.exit(1);
  });
