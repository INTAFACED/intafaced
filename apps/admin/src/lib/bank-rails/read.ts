import 'server-only';
import { type FounderCallContext, partFrom, type Part, founderRecordRead } from '@/lib/desk';
import { parseSalaryRails, type SalaryRails } from './model';
import { BANK_OPS_SALARY_RAILS } from '@intafaced/contracts/bank-ops-procedures';

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
  const salary = await founderRecordRead(ctx, BANK_OPS_SALARY_RAILS, undefined, parseSalaryRails);
  return { asOf: new Date().toISOString(), salary: partFrom(salary, (d) => d.partner, labels) };
}
