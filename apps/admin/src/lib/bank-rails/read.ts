import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { parseSalaryRails, type SalaryRails } from './model';

export interface RailsDesk {
  readonly asOf: string;
  /** null inside `ok`: no payroll network is wired, so there is no data (never zero). */
  readonly salary: Part<SalaryRails | null>;
}

const labels = {
  service: 'svc-bank',
  forbiddenMessage: 'svc-bank did not accept this founder session for bank rail reads. It needs the operator permission admin:read.',
} as const;

export async function readRailsDesk(ctx: FounderCallContext): Promise<RailsDesk> {
  const salary = await founderCall(ctx, 'bank', 'ops.salaryRails', 'GET', undefined, parseSalaryRails);
  return { asOf: new Date().toISOString(), salary: partFrom(salary, (d) => d.partner, labels) };
}
