import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcedureRecord } from './procedure.js';

/**
 * Every refusal a record lists is produced by some test through the mounted route. A vitest `globalSetup` for a service
 * whose router is mounted from records (`procedure-mount.ts`): the run notes each refusal sent, and at its end every
 * listed `<record> <code>` must have been sent, or be in the service's ceiling file of refusals not yet produced.
 *
 * The ceiling holds what was unproduced when the check began, so existing gaps stay buildable and a new listed refusal
 * with no test fails. A ceiling entry that a run produced is printed: delete it from the file. (Not a failure: a run
 * without Postgres skips tests a full run has.) Only a whole run checks: with `PROCEDURE_REFUSALS_CHECK=1`, which the
 * service's `test` script sets, and never on a `--shard` piece; a run of one file does not.
 *
 * Tests only: imported by no service at run time.
 */
export function refusalCoverage(records: readonly ProcedureRecord[], ceilingFile: string) {
  let dir: string | undefined;
  return {
    setup() {
      // A CI piece runs a share of the files (`--shard=k/m`): only a whole run can show a refusal is never produced.
      if (process.env.PROCEDURE_REFUSALS_CHECK !== '1' || process.argv.some((arg) => arg.startsWith('--shard'))) return;
      dir = mkdtempSync(join(tmpdir(), 'refusals-'));
      process.env.PROCEDURE_REFUSALS_SEEN = dir;
    },
    teardown() {
      const seenDir = dir;
      if (seenDir === undefined) return;
      const seen = new Set(
        readdirSync(seenDir).flatMap((file) =>
          readFileSync(join(seenDir, file), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.split('\t').slice(0, 2).join(' ')),
        ),
      );
      rmSync(seenDir, { recursive: true, force: true });
      const ceilingJson: { unproduced: string[] } = JSON.parse(readFileSync(ceilingFile, 'utf8'));
      const ceiling = new Set(ceilingJson.unproduced);
      const listed = records.flatMap((r) => Object.keys(r.refusals).map((code) => `${r.name} ${code}`));
      const missing = listed.filter((pair) => !seen.has(pair) && !ceiling.has(pair));
      const nowProduced = [...ceiling].filter((pair) => seen.has(pair));
      const stale = [...ceiling].filter((pair) => !listed.includes(pair));
      if (nowProduced.length > 0)
        process.stderr.write(`now produced by a test, delete from ${ceilingFile}:\n  ${nowProduced.join('\n  ')}\n`);
      if (missing.length > 0 || stale.length > 0) {
        // vitest reports an error thrown from a teardown but still exits 0, so the run is failed here.
        process.exitCode = 1;
        process.stderr.write(
          `${[
            ...(missing.length > 0
              ? [`listed refusals no test produces through the mounted route (add a test that does):\n  ${missing.join('\n  ')}`]
              : []),
            ...(stale.length > 0 ? [`${ceilingFile} names refusals no record lists (delete them):\n  ${stale.join('\n  ')}`] : []),
          ].join('\n')}\n`,
        );
      }
    },
  };
}
