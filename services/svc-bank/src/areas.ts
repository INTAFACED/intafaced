import { AreaChain } from './area-chain.js';
import type { BankRoot } from './bank-root.js';
import { composeAccountDetailsArea } from './account-details/compose.js';
import { composeAccountHomeArea } from './account-home/compose.js';
import { composeActivityArea } from './activity/compose.js';
import { composeAnalyticsArea } from './analytics/compose.js';
import { composeAssetsArea } from './assets/compose.js';
import { composeAutoInvestArea } from './auto-invest/compose.js';
import { composeBusinessArea } from './business/compose.js';
import { composeCalendarArea } from './calendar/compose.js';
import { composeCardsArea } from './cards/compose.js';
import { composeCardProgrammeArea } from './cards/programme/compose.js';
import { composeCashOutArea } from './cash-out/compose.js';
import { composeDepositsArea } from './deposits/compose.js';
import { composeDeveloperApiArea } from './developer-api/compose.js';
import { composeDirectDebitsArea } from './direct-debits/compose.js';
import { composeDormancyArea } from './dormancy/compose.js';
import { composeEarnArea } from './earn/compose.js';
import { composeSpendFiguresArea } from './insufficient-funds.js';
import { composeLinkedAccountsArea } from './linked-accounts/compose.js';
import { composeLoansArea } from './loans/compose.js';
import { composeOnboardingArea } from './onboarding/compose.js';
import { composeOpsArea } from './ops/compose.js';
import { composePartnerArea } from './partner/compose.js';
import { composePayYourselfArea } from './pay-yourself/compose.js';
import { composePersonalPayArea } from './personal-pay/compose.js';
import { composePlansArea } from './plans/compose.js';
import { composePortfolioArea } from './portfolio/compose.js';
import { composeRailSendsArea } from './rail-sends/compose.js';
import { composeRampsArea } from './ramps/compose.js';
import { composeRecoveryArea } from './recovery/compose.js';
import { composeRulesArea } from './rules/compose.js';
import { composeSafetyArea } from './safety/compose.js';
import { composeSalaryArea } from './salary/compose.js';
import { composeSorterArea } from './sorter/compose.js';
import { composeSpacesArea } from './spaces/compose.js';
import { composeStatementsArea } from './statements/compose.js';
import { composeTransfersArea } from './transfers/compose.js';

/**
 * Every area of svc-bank, in the order they are made: the one place a bank area is declared (project-state #2826).
 *
 * A new area is a `compose<Area>Area(root, made, options)` in its own folder's `compose.ts` and one line here, after
 * the areas whose services it reads. Its services and options join `BankServices` and `BankServiceOptions` from this
 * list; `bank-service.ts` does not change for it. A new service of an existing area is a line in that area's own file.
 */
export const BANK_AREAS = AreaChain.over<BankRoot>()
  .add(composePartnerArea)
  .add(composeOnboardingArea)
  .add(composeSafetyArea)
  .add(composeSpacesArea)
  .add(composeSorterArea)
  .add(composeTransfersArea)
  .add(composeOpsArea)
  .add(composeEarnArea)
  .add(composeAnalyticsArea)
  .add(composePortfolioArea)
  .add(composeActivityArea)
  .add(composeStatementsArea)
  .add(composeAccountDetailsArea)
  .add(composeLoansArea)
  .add(composeAutoInvestArea)
  .add(composeCardsArea)
  .add(composeCardProgrammeArea)
  .add(composeAccountHomeArea)
  .add(composePlansArea)
  .add(composeDormancyArea)
  .add(composeRampsArea)
  .add(composeLinkedAccountsArea)
  .add(composeCashOutArea)
  .add(composeDepositsArea)
  .add(composeAssetsArea)
  .add(composeRailSendsArea)
  .add(composePersonalPayArea)
  .add(composeDirectDebitsArea)
  .add(composeRecoveryArea)
  .add(composeBusinessArea)
  .add(composeDeveloperApiArea)
  .add(composeSalaryArea)
  .add(composePayYourselfArea)
  .add(composeCalendarArea)
  .add(composeRulesArea)
  .add(composeSpendFiguresArea);

/** Every area's services, as `BANK_AREAS` makes them. */
export type BankAreaServices = ReturnType<typeof BANK_AREAS.compose>;
/** Every area's own options, as `BANK_AREAS` reads them. */
export type BankAreaOptions = Parameters<typeof BANK_AREAS.compose>[1];
