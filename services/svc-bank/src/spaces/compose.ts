import type { BankRoot } from '../bank-root.js';
import { cardProgrammeOutput, noCardIssuer } from '../cards/issuer.js';
import type { CardServiceOptions } from '../cards/card-service.js';
import { SpaceService } from './space-service.js';
import { BillsPotService } from './bills-pot.js';
import { SharedPotService } from './shared-pots.js';

/** The person's spaces, bills pots and shared pots. An area of svc-bank (`area-chain.ts`). */
export interface SpacesServices {
  readonly spaces: SpaceService;
  /** The person's bills pot per asset, and whether a standing order from it may top it up from the main account. */
  readonly billsPots: BillsPotService;
  readonly sharedPots: SharedPotService;
}

export interface SpacesServiceOptions {
  /** Owner-published number of live named spaces per account (`BANK_SPACE_LIMIT`). No default: blank refuses a create. */
  spaceLimit?: string | undefined;
  /** Owner-set hours an early pot unlock waits (`BANK_SPACE_UNLOCK_WAIT_HOURS`). No default: blank refuses the ask. */
  spaceUnlockWaitHours?: string | undefined;
  /** Owner-set minutes a shared pot invite lasts (`BANK_SHARED_POT_INVITE_MINUTES`). No default: blank refuses sharing. */
  sharedPotInviteMinutes?: string | undefined;
  /** Owner-set people one pot may be shared with (`BANK_SHARED_POT_PEOPLE_CAP`). No default: blank refuses sharing. */
  sharedPotPeopleCap?: string | undefined;
  /** The card issuer (the cards area's option): a shared pot reads which card programme this deployment has. */
  cards?: Pick<CardServiceOptions, 'issuer'>;
}

export function composeSpacesArea(root: BankRoot, _made: object, options: SpacesServiceOptions): SpacesServices {
  const spaces = new SpaceService(root.sql, root.ledger, root.recipients, {
    spaceLimit: () => options.spaceLimit,
    unlockWaitHours: () => options.spaceUnlockWaitHours,
    custody: root.custody,
  });
  return {
    spaces,
    billsPots: new BillsPotService(root.sql, spaces),
    sharedPots: new SharedPotService(
      root.sql,
      spaces,
      root.directory,
      {
        inviteMinutes: () => options.sharedPotInviteMinutes,
        peopleCap: () => options.sharedPotPeopleCap,
        // The same programme the card service reports: its issuer's, else none.
        cardProgramme: () => cardProgrammeOutput((options.cards?.issuer ?? noCardIssuer).programme),
      },
      root.directoryLookups,
    ),
  };
}
