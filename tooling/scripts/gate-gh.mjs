/**
 * gate-gh.mjs: the one way the merge-gate tools talk to `gh`.
 *
 * Used by merge-gate.mjs, main-auto-revert.mjs and gate-file-guard.mjs. Two rules live here so no caller can forget them:
 *
 *   1. A 403 or 429 from GitHub is a STOP (AGENTS.md "Ship" rule 2). It throws GitHubRefusalError, which no caller
 *      catches and retries. There is no retry loop anywhere in these tools.
 *   2. Arguments go to `gh` as an array, never through a shell, so PR titles and commit subjects (untrusted text) cannot
 *      become commands.
 *
 * Tests inject a fake `spawn`, so no test touches the network.
 */
import { spawnSync } from 'node:child_process';
import { isGitHubRefusal } from './github-refusal.mjs';

export class GitHubRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubRefusalError';
  }
}

/**
 * @param {{ cwd?: string, spawn?: typeof spawnSync, bin?: string }} [opts]
 * @returns {(args: string[], o?: { input?: string, allowFail?: boolean }) => { status: number, stdout: string, stderr: string }}
 */
export function makeGh({ cwd, spawn = spawnSync, bin = 'gh' } = {}) {
  return function gh(args, { input, allowFail = false } = {}) {
    const r = spawn(bin, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = { status: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    if (out.status === 0) return out;
    if (isGitHubRefusal({ stderr: out.stderr || undefined, stdout: out.stdout || undefined })) {
      throw new GitHubRefusalError(
        `GitHub refused \`${bin} ${args.slice(0, 3).join(' ')}\`: ${(out.stderr || out.stdout).trim().slice(0, 300)}`,
      );
    }
    if (allowFail) return out;
    throw new Error(`\`${bin} ${args.slice(0, 4).join(' ')}\` failed (${out.status}): ${(out.stderr || out.stdout).trim().slice(0, 500)}`);
  };
}

/** Run gh and parse JSON stdout. */
export function ghJson(gh, args, opts) {
  const { stdout } = gh(args, opts);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}
