// Before a push (.githooks/pre-push): one line when CI is still running on the head this push replaces. In 48 hours 62
// pushes went out before their previous head had any verdict, each one restarting CI (project-state#3754). A notice,
// never a refusal: no gh, no network, a slow answer or any error prints nothing, and the hook always goes on.
//   node tooling/scripts/pre-push-ci-running.mjs <the remote's sha> ...
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WAIT_MS = 3000;

/** The number of check runs not yet completed on `sha` (gh fills {owner}/{repo} from this checkout's remote), or null. */
const unfinished = (sha) =>
  new Promise((done) => {
    execFile(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`,
        '--jq',
        '[.check_runs[] | select(.status != "completed")] | length',
      ],
      { timeout: WAIT_MS, encoding: 'utf8' },
      (e, out) => done(e || !/^\d+\s*$/.test(out) ? null : Number(out)),
    );
  });

/** The notice lines for the remote's previous heads (a new branch's all-zero sha has none). */
export async function notices(shas, read = unfinished) {
  const heads = [...new Set(shas.filter((s) => /^[0-9a-f]{40}$/.test(s) && !/^0+$/.test(s)))];
  const counts = await Promise.all(heads.map((s) => read(s).catch(() => null)));
  return heads.flatMap((s, i) =>
    counts[i] > 0
      ? [
          `pre-push: notice: CI is still running on ${s.slice(0, 9)}, the head this push replaces (${counts[i]} checks unfinished). This push restarts it; its verdict may name more to fix in the same push.`,
        ]
      : [],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const line of await notices(process.argv.slice(2)).catch(() => [])) console.log(line);
}
