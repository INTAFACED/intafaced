/**
 * Ramp health over a required window. failureRate is the unreduced ratio
 * `failures/total`, or null when the window has no attempts. A rail whose
 * provider is not configured is `unset` and is not a healthy rail.
 * No provider heartbeat exists, so lastProbeAt is null with `no_heartbeat`.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { rampRails, type RampRail } from '../ramps/rails.js';

export interface RampHealthRail {
  id: string;
  provider: string;
  lastSuccess: string | null;
  lastFailure: string | null;
  openCount: number;
  failureCount: number;
  totalCount: number;
  failureRate: string | null;
  lastProbeAt: null;
  reason: 'no_heartbeat';
}

export interface RampHealth {
  asOf: string;
  rails: RampHealthRail[];
}

export function assertWindowHours(windowHours: number | undefined): number {
  if (windowHours === undefined || !Number.isInteger(windowHours) || windowHours < 1 || windowHours > 720) {
    throw new BankError('Ramp health needs windowHours from 1 to 720 (bank.ramp_health_window_unset)', 'bank.ramp_health_window_unset');
  }
  return windowHours;
}

interface RampRow {
  rail: string;
  status: string;
  created_at: Date;
  settled_at: Date | null;
}

export async function readRampHealth(bank: BankServices, windowHours: number, now = new Date()): Promise<RampHealth> {
  const rails = rampRails(bank.ramps.programmeInfo());
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const rows = await bank.ramps.attemptsSince(since);
  return { asOf: now.toISOString(), rails: rails.map((rail) => summarise(rail, rows, now)) };
}

function summarise(rail: RampRail, rows: RampRow[], now: Date): RampHealthRail {
  const mine = rows.filter((row) => row.rail === rail.id && row.created_at.getTime() <= now.getTime());
  const failures = mine.filter((row) => row.status === 'rejected');
  const successes = mine.filter((row) => row.status === 'settled');
  const last = (list: RampRow[], at: (row: RampRow) => Date | null): string | null => {
    let best: Date | null = null;
    for (const row of list) {
      const stamp = at(row);
      if (stamp && (best === null || stamp.getTime() > best.getTime())) best = stamp;
    }
    return best ? best.toISOString() : null;
  };
  return {
    id: rail.id,
    provider: rail.provider,
    lastSuccess: last(successes, (row) => row.settled_at),
    lastFailure: last(failures, (row) => row.created_at),
    openCount: mine.filter((row) => row.status === 'pending' || row.status === 'awaiting_payment' || row.status === 'submitted').length,
    failureCount: failures.length,
    totalCount: mine.length,
    failureRate: mine.length === 0 ? null : `${failures.length}/${mine.length}`,
    lastProbeAt: null,
    reason: 'no_heartbeat',
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function rampHealthProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({ windowHours: z.number().int().optional() }))
    .output(
      z.object({
        asOf: z.string(),
        rails: z.array(
          z.object({
            id: z.string(),
            provider: z.string(),
            lastSuccess: z.string().nullable(),
            lastFailure: z.string().nullable(),
            openCount: z.number().int().nonnegative(),
            failureCount: z.number().int().nonnegative(),
            totalCount: z.number().int().nonnegative(),
            failureRate: z
              .string()
              .regex(/^\d+\/\d+$/)
              .nullable(),
            lastProbeAt: z.null(),
            reason: z.literal('no_heartbeat'),
          }),
        ),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        const windowHours = assertWindowHours(input.windowHours);
        return readRampHealth(bank, windowHours);
      }),
    );
}
