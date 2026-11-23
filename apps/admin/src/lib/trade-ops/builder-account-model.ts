import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import type { TRADE_BUILDER_ACCOUNT_MODE } from '@intafaced/contracts/trade-builder-mode-procedures';

/** The builder account view as svc-trade's record answers it (J-ops-console-28). */
export type BuilderAccountView = ProcedureOutput<typeof TRADE_BUILDER_ACCOUNT_MODE>;
export type BuilderAccountVenue = BuilderAccountView['venues'][number];
export type BuilderAccountAlert = BuilderAccountView['alerts'][number];

/** What each verdict means for our builder fees, in the console's words. */
export const VERDICT_TEXT: Record<BuilderAccountVenue['verdict'], string> = {
  required_mode: 'Collected: in the required mode',
  not_collected: 'Builder fees not collected in this mode',
  not_published: 'The venue does not publish a required mode',
  unknown: 'unknown',
};

export const utcSecond = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;
