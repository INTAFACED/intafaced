/**
 * How heavy work runs (owner decision A, 28 Nov 2026, project-state#4160), read from stack-slots.json, the one place
 * that holds it: CI runs the journeys; a builder runs only the tests beside its change; a full local stack runs only in
 * one of the shared slots, queued, to prove a visible change; the beta keeps its own slot. Theo's rule, which this
 * copies: "CI owns the full suite", and a real-client pass for a visible change only (pingdotgg/t3code AGENTS.md).
 *
 * `startGate` is what local-test-stack.mjs asks before an agent's start claims a slot. A person's start, CI's and the
 * beta's are never gated, and a checkout that already holds a slot keeps it (a start under the old rule finishes under
 * it). Failure it prevents: every builder proved on a stack of its own (5 to 8 GB each), and on 28 Nov the box's memory
 * killer stopped 31 processes in under two hours, most of them builders' stack services (project-state#4160).
 */
import fs from 'node:fs';

export const RULE = JSON.parse(fs.readFileSync(new URL('./stack-slots.json', import.meta.url), 'utf8'));
export { SHARED_SLOTS } from './local-test-facts.mjs';
import { SHARED_SLOTS } from './local-test-facts.mjs';
export const BETA_SLOT = RULE.beta;
export const STACK_GIB = RULE.stackGiB;
export const QUEUE_MINUTES = RULE.queueMinutes;

/**
 * The changed files a person sees in the app: an app's own files outside its tests, and the shared UI and copy packages.
 * A service, contract or test change is proven by the journeys on CI.
 */
export const VISIBLE = [/^apps\/(customer|admin|invitation|mobile)\/(?!tests\/)/, /^packages\/(ui|i18n)\//];
export const visibleFiles = (files) => files.filter((f) => VISIBLE.some((re) => re.test(f)));

/** Started by an agent: Claude Code's Bash tool (CLAUDECODE) or any T3 thread (T3CODE_THREAD_ID). */
export const agentStart = (env) => env.CLAUDECODE === '1' || Boolean(env.T3CODE_THREAD_ID);

/**
 * Null when this start may claim a slot (queued for a shared one), else why not, starting "refusing:".
 * `files`: what this checkout changes against origin/main (committed and not), or null when it could not be read.
 */
export function startGate({ env, platform, files, holdsClaim }) {
  if (!agentStart(env) || env.CI === 'true' || holdsClaim) return null;
  const ci = 'CI proves it: the Real-app journeys run on your PR’s exact head (owner decision A, project-state#4160)';
  if (platform === 'darwin') return `refusing: an agent starts no local stack on the Mac; ${ci}`;
  if (env.LOCAL_STACK_SLOT !== undefined && !SHARED_SLOTS.includes(Number(env.LOCAL_STACK_SLOT)))
    return `refusing: slot ${env.LOCAL_STACK_SLOT} is not a shared slot (${SHARED_SLOTS.join(', ')}); ${ci}`;
  if (files === null) return `refusing: what this checkout changes could not be read against origin/main; ${ci}`;
  if (!visibleFiles(files).length)
    return `refusing: this change touches nothing a person sees (no app or UI file), so it needs no local stack; ${ci}`;
  return null;
}

/** The queue for a shared slot, first come first served: whose turn it is among the waiting starts' tickets. */
export function queueTurn(tickets, me, alive) {
  const live = tickets.filter((t) => t.pid === me.pid || alive(t.pid)).sort((a, b) => a.at - b.at || a.pid - b.pid);
  const ahead = live.findIndex((t) => t.pid === me.pid);
  return { ahead: ahead < 0 ? live.length : ahead, dead: tickets.filter((t) => !live.includes(t)) };
}
