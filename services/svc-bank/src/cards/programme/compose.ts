import type { BankRoot } from '../../bank-root.js';
import type { CardService } from '../card-service.js';
import { CardProgrammeOps } from './programme-ops.js';

/** The card programme desk's services (J-bank-26). An area of svc-bank (`area-chain.ts`). */
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

export function composeCardProgrammeArea(
  root: BankRoot,
  made: { readonly cards: CardService },
  options: CardProgrammeServiceOptions,
): CardProgrammeServices {
  return {
    cardProgrammeOps: new CardProgrammeOps(root.sql, {
      cards: made.cards,
      directory: root.directory,
      identity: root.recipients,
      sanctions: options.cardProgramme?.sanctions ?? (() => undefined),
      simulatorAllowed: options.cardProgramme?.simulatorAllowed ?? false,
      exportSecret: root.receiptSecret,
    }),
  };
}
