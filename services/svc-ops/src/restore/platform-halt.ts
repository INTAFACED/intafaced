import { z } from 'zod';
import { OPS_RESTORE_HALT_UNREADABLE, OPS_RESTORE_PLATFORM_NOT_HALTED } from '../codes.js';

/**
 * Whether the platform is halted for the joint restore's check (J-ops-console-08 #7, lead ruling 2026-10-31). Bank, pay
 * and identity answer their live row counts, not a position as of the cut-off, so the joint check compares them with the
 * stamps only while nothing can write: the posting freeze (svc-ledger's, AGENTS.md money 6) must be on. Read from the
 * ledger's own `/health`, the one place it reports `postingEnabled` without an operator token; svc-ops reads no ledger table.
 *
 * Anything but a ledger saying `postingEnabled: false` is "not halted": posting on, no URL, a refusal, a timeout or a body
 * this does not read. None is taken as halted.
 */
export type PlatformHalt =
  { halted: true } | { halted: false; code: typeof OPS_RESTORE_PLATFORM_NOT_HALTED | typeof OPS_RESTORE_HALT_UNREADABLE; message: string };

export interface PlatformHaltReader {
  read(): Promise<PlatformHalt>;
}

const TIMEOUT_MS = 5000;

/** Only svc-ledger's health answer carries `postingEnabled`; its service name is a deploy setting, so it is not matched. */
const healthSchema = z.object({ postingEnabled: z.boolean() });

export function createLedgerFreezeReader(options: { ledgerUrl: string | undefined; fetcher?: typeof fetch }): PlatformHaltReader {
  const unreadable = (message: string): PlatformHalt => ({ halted: false, code: OPS_RESTORE_HALT_UNREADABLE, message });
  return {
    async read() {
      let base: string;
      try {
        const url = new URL(options.ledgerUrl ?? '');
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          return unreadable('svc-ledger is not wired here, so whether posting is frozen was not read.');
        }
        base = url.href.replace(/\/$/, '');
      } catch {
        return unreadable('svc-ledger is not wired here, so whether posting is frozen was not read.');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await (options.fetcher ?? fetch)(`${base}/health`, { redirect: 'error', signal: controller.signal });
        if (!response.ok) return unreadable(`svc-ledger refused its health read (${response.status}).`);
        const parsed = healthSchema.safeParse(await response.json());
        if (!parsed.success) {
          return unreadable('svc-ledger answered its health read in a shape this service does not read.');
        }
        return parsed.data.postingEnabled
          ? {
              halted: false,
              code: OPS_RESTORE_PLATFORM_NOT_HALTED,
              message: 'The posting freeze is off, so the services can still write and their counts are not compared.',
            }
          : { halted: true };
      } catch {
        return unreadable('svc-ledger did not answer its health read.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
