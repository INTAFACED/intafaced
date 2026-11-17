import type { Sql } from 'postgres';
import type { BusinessDirectoryPort } from '../../business/business-directory.js';
import type { RecipientStatePort } from '../../recipient-state.js';
import type { CardService } from '../card-service.js';
import { CardProgrammeOps } from './programme-ops.js';

/**
 * The card programme desk's services (J-bank-26), made in one place of their own, as `business/compose.ts` does for the
 * business bank: `bank-service.ts` spreads these and does not change for them (project-state #2656).
 */
export interface CardProgrammeServices {
  /** J-bank-26: support and finance run the card programme: settings, rules, cardholders, the log, roles, bulk issue. */
  readonly cardProgrammeOps: CardProgrammeOps;
}

export interface CardProgrammeServiceOptions {
  /**
   * The card programme desk (J-bank-26): the owner's cardholder sanctions list (`BANK_CARDHOLDER_SANCTIONS`, read at each
   * check; unset refuses `bank.cardholder_screening_unset`) and whether this is a dev or test stack, where alone the card
   * event simulator runs.
   */
  cardProgramme?: { sanctions?: () => string | undefined; simulatorAllowed?: boolean };
}

export interface CardProgrammeComposeContext {
  readonly sql: Sql;
  readonly cards: CardService;
  readonly directory: BusinessDirectoryPort;
  readonly identity: RecipientStatePort | undefined;
  readonly exportSecret: string | undefined;
}

export function composeCardProgrammeServices(
  ctx: CardProgrammeComposeContext,
  options: CardProgrammeServiceOptions,
): CardProgrammeServices {
  return {
    cardProgrammeOps: new CardProgrammeOps(ctx.sql, {
      cards: ctx.cards,
      directory: ctx.directory,
      identity: ctx.identity,
      sanctions: options.cardProgramme?.sanctions ?? (() => undefined),
      simulatorAllowed: options.cardProgramme?.simulatorAllowed ?? false,
      exportSecret: ctx.exportSecret,
    }),
  };
}
