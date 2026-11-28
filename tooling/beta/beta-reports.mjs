#!/usr/bin/env node
/**
 * A beta tester's trouble reaches a builder (#11218): each STUCK invited tester, and each help request a tester opens
 * from /support, becomes one `bug` + `beta` issue on this repo, which the pull hands out first.
 *
 *   node tooling/beta/beta-reports.mjs pass [--root <dir>] [--dry]   on the beta stack (beta-host.mjs runs it every 5 min)
 *
 * What an issue names: the account id, the stage the tester reached, their last call and the venue's refusal words; a
 * help request's id, category and the tester's stage. Never an email or a viewer token, and never the tester's own words:
 * this repo is public and its issues are read by agents, so the request's text stays on the box
 * (`beta-host.mjs testers` prints it). The agents' own walks (beta-invited.mjs agentsInvite) are never reported.
 *
 * One issue per tester's stuck and per help request: reports.json in the beta's folder records each key's issue. A tester
 * seen stuck again (a new stage or a new kind of trouble, beta-testers.mjs stuckSince) gets a comment on their issue, not
 * a second one. Before a new issue the key's marker is searched for on the repo, so a pass that died after creating one
 * adopts it instead of filing it again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const REPORT_REPO = 'INTAFACED/intafaced';
export const REPORT_LABELS = Object.freeze(['bug', 'beta']);
const STAGE_WORDS = { signedUp: 'signed up', wallet: 'wallet made', funded: 'funded', desk: 'desk reached', firstOrder: 'first order' };
/** A marker in each issue's body: the key it reports, searched for before a new one is filed. */
export const marker = (key) => `<!-- beta-report: ${key} -->`;
/** Venue words are outside text: one line, quoted as code, never longer than this. */
const WORDS_MAX = 200;
const quoted = (text) =>
  `\`${String(text ?? '(no words)')
    .replace(/[`\r\n]+/g, ' ')
    .slice(0, WORDS_MAX)}\``;
const stageOf = (row) => (row.lastStage ? STAGE_WORDS[row.lastStage] : 'none yet');

function stuckFacts(row) {
  const lines = [
    `- Account: \`${row.accountId}\``,
    `- Stage reached: ${stageOf(row)}`,
    `- Why STUCK: ${row.stuck}`,
    `- Last call: ${row.lastAction ? `${row.lastAction.call} answered ${row.lastAction.status} at ${row.lastAction.at}` : 'none'}`,
  ];
  for (const f of row.refusals ?? [])
    lines.push(`- Venue refused ${f.path} ${f.status}${f.code ? ` ${f.code}` : ''} x${f.count}, last ${f.at}: ${quoted(f.text)}`);
  for (const e of row.errors ?? []) lines.push(`- Error ${e.call} ${e.status}${e.code ? ` ${e.code}` : ''} x${e.count}, last ${e.at}`);
  return lines.join('\n');
}

const READ_ON_BOX = "Read the tester's whole record on the box: `node tooling/beta/beta-host.mjs testers`.";

/**
 * What a pass does, from the testers' view (beta-testers.mjs readView rows) and what was filed before. Pure. Returns the
 * actions in order: `{ kind: 'open', key, title, body }` or `{ kind: 'comment', key, issue, body }`, and the
 * record of who is stuck now (`stuckSince` per stuck key, cleared when a tester is no longer stuck).
 */
export function planReports({ rows, filed = {} }) {
  const actions = [];
  const now = {};
  for (const row of rows) {
    if (row.agents) continue;
    const key = `stuck:${row.accountId}`;
    if (row.stuck) {
      now[key] = row.stuckSince;
      const had = filed[key];
      if (!had?.issue)
        actions.push({
          kind: 'open',
          key,
          title: `beta: tester ${row.accountId.slice(0, 8)} is stuck at "${stageOf(row)}"`,
          body: `A beta tester is STUCK (tooling/beta/beta-testers.mjs).\n\n${stuckFacts(row)}\n\n${READ_ON_BOX}\n\n${marker(key)}\n`,
        });
      else if (had.stuckSince !== row.stuckSince)
        actions.push({ kind: 'comment', key, issue: had.issue, body: `Seen STUCK again.\n\n${stuckFacts(row)}\n` });
    } else now[key] = null;
    for (const h of row.help ?? []) {
      const helpKey = `help:${h.id}`;
      if (filed[helpKey]?.issue) continue;
      actions.push({
        kind: 'open',
        key: helpKey,
        title: `beta: tester ${row.accountId.slice(0, 8)} asked for help (${h.category})`,
        body: [
          'A beta tester opened a help request from /support.',
          '',
          `- Account: \`${row.accountId}\``,
          `- Request: \`${h.id}\`, category ${h.category}, opened ${h.at}, now ${h.status}`,
          `- Stage reached: ${stageOf(row)}${row.stuck ? ` (STUCK: ${row.stuck})` : ''}`,
          `- Last call: ${row.lastAction ? `${row.lastAction.call} answered ${row.lastAction.status} at ${row.lastAction.at}` : 'none'}`,
          '',
          `The tester's own words stay on the box (this repo is public). ${READ_ON_BOX}`,
          '',
          marker(helpKey),
          '',
        ].join('\n'),
      });
    }
  }
  return { actions, now };
}

/** gh as the box is signed in: open an issue (its number), find a marker's issue (its number or null), comment. */
export function ghDeps(sh = (args, input) => spawnSync('gh', args, { input, encoding: 'utf8', timeout: 60_000 })) {
  const run = (args, input) => {
    const r = sh(args, input);
    if (r.status !== 0)
      throw new Error(
        `gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr || r.error?.message || '')
          .trim()
          .slice(0, 300)}`,
      );
    return String(r.stdout ?? '');
  };
  return {
    find(key) {
      const out = run([
        'issue',
        'list',
        '-R',
        REPORT_REPO,
        '--state',
        'all',
        '--label',
        'beta',
        '--search',
        `"beta-report: ${key}" in:body`,
        '--json',
        'number,body',
      ]);
      return JSON.parse(out || '[]').find((i) => String(i.body).includes(marker(key)))?.number ?? null;
    },
    open({ title, body }) {
      const out = run(
        ['issue', 'create', '-R', REPORT_REPO, ...REPORT_LABELS.flatMap((l) => ['--label', l]), '--title', title, '--body-file', '-'],
        body,
      );
      const n = Number(out.trim().match(/\/issues\/(\d+)\s*$/)?.[1]);
      if (!Number.isInteger(n)) throw new Error(`gh issue create named no issue: ${out.trim().slice(0, 200)}`);
      return n;
    },
    comment({ issue, body }) {
      run(['issue', 'comment', String(issue), '-R', REPORT_REPO, '--body-file', '-'], body);
    },
  };
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writePrivate = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const reportsPath = (root) => path.join(root, 'reports.json');

/**
 * One pass: plan, then carry out each action, saving the record after each, so a failed call loses nothing done before
 * it. Returns the log lines.
 */
export function runReports({ rows, file, deps }) {
  const doc = readJson(file, null) ?? { kind: 'intafaced-beta-reports', filed: {} };
  const { actions, now } = planReports({ rows, filed: doc.filed });
  const lines = [];
  const save = () => writePrivate(file, doc);
  for (const a of actions) {
    if (a.kind === 'open') {
      const issue = deps.find(a.key) ?? deps.open(a);
      doc.filed[a.key] = { issue, stuckSince: now[a.key] ?? null };
      lines.push(`reports: ${a.key} is issue #${issue}`);
    } else {
      deps.comment(a);
      doc.filed[a.key] = { ...doc.filed[a.key], stuckSince: now[a.key] };
      lines.push(`reports: ${a.key} seen stuck again, commented on #${a.issue}`);
    }
    save();
  }
  // A tester no longer stuck is recorded so, and their next STUCK is a new comment.
  for (const [key, since] of Object.entries(now))
    if (doc.filed[key]?.issue && since === null && doc.filed[key].stuckSince !== null)
      doc.filed[key] = { ...doc.filed[key], stuckSince: null };
  save();
  return lines;
}

async function main(argv) {
  if (argv[0] !== 'pass') throw new Error('usage: beta-reports.mjs pass [--root <dir>] [--dry]');
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(os.homedir(), '.intafaced', 'beta');
  const { readView } = await import('./beta-testers.mjs');
  const { rows, helpUnread } = await readView({ root });
  if (helpUnread) console.log(`reports: help requests not read: ${helpUnread}`);
  if (argv.includes('--dry'))
    return void console.log(JSON.stringify(planReports({ rows, filed: readJson(reportsPath(root), {})?.filed }), null, 2));
  for (const line of runReports({ rows, file: reportsPath(root), deps: ghDeps() })) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`beta-reports: ${err.message}`);
    process.exit(1);
  });
}
