import 'server-only';
import { describeUnconfigured, readConsoleStatus } from '@/lib/console-status';
import type { AdminSessionConfig, FounderSession } from '@/lib/founder-session';
import type { RunAnswer } from './reconciliation-run';

/**
 * The console's two hops to svc-edge's reconciliation control doors (OPS-reconciliation-01).
 *
 * The list goes as the signed-in founder (their own token: svc-ledger lets a compliance or treasury reader list). Define,
 * update and run go on the treasury transport (`ADMIN_TREASURY_TOKEN`), as the posting freeze does, because founder sessions
 * never carry `admin:treasury`. A console without that credential sends nothing and says which setting is missing.
 */

const PATH = '/admin/ledger/reconciliation/controls' as const;
const READ_TIMEOUT_MS = 6_000;
/** Above the edge's own 15 s upstream budget for a run, so the console never gives up before the edge does. */
const WRITE_TIMEOUT_MS = 20_000;

export type TreasuryAnswer = RunAnswer;

export type ControlDoor = 'define' | 'update' | 'run';

const DOOR_PATH: Readonly<Record<ControlDoor, `/admin/ledger/${string}`>> = { define: PATH, update: `${PATH}/update`, run: `${PATH}/run` };

/**
 * The edge address and treasury token, or why this console has none. `readConsoleStatus` decides what configured means (a
 * trimmed, non-empty token and an edge address), the same answer the posting freeze uses.
 */
export function treasuryTransport(): { readonly edgeUrl: string; readonly token: string } | { readonly reason: string } {
  const status = readConsoleStatus();
  if (!status.treasury.configured || !status.edgeUrl) return { reason: describeUnconfigured(status.treasury) };
  return { edgeUrl: status.edgeUrl, token: (process.env[status.treasury.tokenVar] ?? '').trim() };
}

/** Why this console cannot reach the treasury doors, or null when it holds the transport. */
export function treasuryParked(): string | null {
  const transport = treasuryTransport();
  return 'reason' in transport ? transport.reason : null;
}

export async function listControlsAsFounder(
  session: FounderSession,
  config: AdminSessionConfig,
): Promise<{ readonly status: number; readonly body: unknown } | null> {
  try {
    const res = await fetch(`${config.edgeUrl}${PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/**
 * One control's evaluations, newest first (OPS-reconciliation-02), read as the signed-in founder like the list: svc-ledger lets
 * a compliance or treasury reader see them, and a retired control keeps every one. Null when svc-edge did not answer.
 */
export async function listRunsAsFounder(
  session: FounderSession,
  config: AdminSessionConfig,
  body: { readonly controlId: string; readonly limit?: number },
): Promise<{ readonly status: number; readonly body: unknown } | null> {
  try {
    const res = await fetch(`${config.edgeUrl}${PATH}/runs`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

export async function sendTreasuryControl(door: ControlDoor, body: unknown): Promise<TreasuryAnswer> {
  return postTreasury(DOOR_PATH[door], body);
}

/**
 * One POST to a named svc-edge treasury door (`/admin/ledger/...`). Also used by the account metadata writes
 * (J-ops-console-03 #6, #7). Never throws: an unconfigured console sends nothing and says why.
 */
export async function postTreasury(path: `/admin/ledger/${string}`, body: unknown): Promise<TreasuryAnswer> {
  const transport = treasuryTransport();
  if ('reason' in transport) return { reached: false, sent: false, detail: transport.reason };
  try {
    const res = await fetch(`${transport.edgeUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return { reached: true, status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { reached: false, sent: true, detail: 'The connection ended before svc-edge answered.' };
  }
}
