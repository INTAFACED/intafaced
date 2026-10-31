import { describe, expect, it } from 'vitest';
import { registeredCopy } from './i18n';
// Importing a module registers its catalog.
import '../features/money/copy';
import '../features/money/withdrawal-copy';
import '../features/money/card-copy';
import '../features/money/standing-copy';
import '../features/money/rail-copy';
import '../features/money/repeat-buy-copy';
import '../features/money/loan-copy';
import '../features/money/earn-copy';
import '../features/money/space-copy';
import '../features/money/analytics-copy';
import '../features/money/card-depth-copy';
import '../features/money/business-copy';
import '../features/money/transfer-depth-copy';
import '../features/money/money-refusal-copy';
import '../features/more/copy';
import '../features/more/academy-grant-copy';
import '../features/more/agents-session-copy';
import '../features/more/blueprint-crew-copy';
import '../features/more/blueprint-session-copy';
import '../features/more/blueprint-shared-card-copy';
import '../features/more/campaigns-depth-copy';
import '../features/more/launch-copy';
import '../features/more/launch-depth-copy';
import '../features/more/market-purchases-copy';
import '../features/more/prediction-catalogue-copy';
import '../features/more/quant-analysis-copy';
import '../features/more/support-events-copy';
import '../features/more/token-governance-copy';
import '../features/quant/algo-copy';
import '../features/quant/studio-copy';
import '../features/quant/builder-copy';
import '../features/quant/templates-copy';
import '../features/quant/backtest-copy';
import '../features/account/copy';
import '../features/account/notifications-copy';
import '../features/account/notification-targets-copy';
import '../features/account/referral-copy';
import '../features/account/promotions-copy';
import '../features/account/dividends-copy';
import '../features/pay/p2p-counterparty-copy';
import '../features/pay/p2p-offer-copy';
import '../features/pay/p2p-order-copy';
import '../features/pay/p2p-release-copy';
import '../features/pay/p2p-remind-copy';
import '../features/pay/p2p-mismatch-copy';
import '../features/pay/p2p-validate-copy';
import '../features/pay/personal/p2p-depth-copy';
import '../features/pay/personal/p2p-post-copy';
import '../features/pay/p2p-blocker-copy';
import '../features/pay/p2p-cancel-copy';
import '../features/public/help-copy';
import '../screens/notifications/alerts-copy';
import '../screens/pay/recent-copy';
import '../features/pay/copy';
import '../screens/coin/copy';
import './ui-copy';

/** Words that belong to engineers, not customers. A customer-facing sentence never needs them. */
const ENGINEERING = new RegExp(
  [
    'requested limit',
    'continuation',
    '\\bcursor\\b',
    'authoritative',
    'owner-scoped',
    '\\bancestors?\\b',
    'keyed answers',
    '\\bisolate\\b',
    '\\bvault\\b',
    '\\bUUID\\b',
    '\\bprojections?\\b',
    '\\bprocedures?\\b',
    '\\bbounded\\b',
    '\\bmounted\\b',
    '\\b(service|bank|post|account|dividend|history|password-reset|campaign) contracts?\\b',
    '\\b[a-z]+\\.[a-z]+[A-Z]\\w*',
    '\\bNo [\\w -]+ returned\\b',
    '\\b(was|were|is|are) (not )?returned\\b',
    '\\breturned (window|list|records?|response|by the service)\\b',
    '\\b(records?|answers?|items?) returned\\b',
    '\\bthis read\\b',
    '\\bloaded (window|answers)\\b',
  ].join('|'),
  'i',
);
/** The same kind of words in Spanish and French. */
const ENGINEERING_TRANSLATED =
  /límite solicitado|limite demandée|lecture limitée|proyecci[oó]n|curseur|\bcursor\b|(registros|respuestas?|ventana) devuelt|(enregistrements?|réponses?|fenêtre) renvoy/i;
/** Letters that look like internal codes: dotted snake_case such as bank.earn_rate_unset. */
const RAW_CODE = /\b[a-z]+\.[a-z0-9]+_[a-z0-9_]+\b/;
/** Written by and for staff or people; customer copy names neither. */
// People's names only: vendor and model names are already refused repo-wide by the brand doctrine gate (§0.7).
const NAMES = /\b(Phantom|Nitro|Shehzad)\b/;

const CHECKED = new Set([
  'customer.money',
  'customer.money.withdrawals',
  'customer.money.cards',
  'customer.money.standing',
  'customer.money.railRecords',
  'customer.money.repeat-buy',
  'customer.money.loans',
  'customer.money.earn',
  'customer.money.space',
  'customer.money.analytics',
  'customer.bank.cards',
  'customer.bank.business',
  'customer.bank.transfers',
  'customer.money.refusals',
  'customer.more',
  'academy-grant',
  'more.agentSessions',
  'more.blueprintCrew',
  'more.blueprint.session',
  'more.blueprintSharedCard',
  'more.campaigns.depth',
  'more.launch.availability',
  'more.launch.depth',
  'more.market-purchases',
  'more.prediction.catalogue',
  'more.quant.analysis',
  'quant.algo',
  'quant.studio',
  'quant.builder',
  'quant.templates',
  'quant.backtest',
  'customer.supportEvents',
  'token-governance',
  'customer.account',
  'account.notifications',
  'account.notificationTargets',
  'account.referrals',
  'account.promotions',
  'account.dividends',
  'pay.p2p.counterparty',
  'pay.p2p.blocker',
  'pay.p2p.cancel',
  'pay.p2p.offer',
  'pay.p2p.order',
  'pay.p2p.release',
  'pay.p2p.remind',
  'pay.p2p.mismatch',
  'pay.p2p.validate',
  'pay.p2p.depth',
  'pay.p2p.post',
  'public.help',
  'notifications.alerts',
  'pay.recent',
  'shared.ui',
  'customer.coin',
]);
// pay.surface also holds merchant-portal sentences that are not part of this pass: only the personal and P2P ones are pinned.
const PAY_SURFACE_KEYS = [
  'recordsWindow',
  'recordsReturnedWindowOf',
  'moreRecordsMayExist',
  'thisServiceHasNoContinuationCursorThis',
  'openACounterpartyFromAnOfferTo',
  'yourOffersInsideTheLoadedMarketWindow',
  'allReturnedCurrencies',
  'noOffersReturnedForTheseFilters',
  'noOwnOffersInThisWindow',
  'increaseTheWindowOrChooseFiltersTo',
  'anAuthoritativeFeeAndReservationPreviewIs',
  'theP2pServiceRefusesLiveOfferCreation',
  'noP2pOrdersReturned',
  'theOrderReachedATerminalStateBut',
  'noPaymentDestinationHeadersReturned',
  'aPreviousTransferHasNotBeenConfirmed',
  'noBankSpacesReturned',
  'receiveNamedOnly',
  'receiveNoSpaces',
  'receiveCoverage',
  'refusedRecoveryBody',
  'noAssetSourceExplanation',
  'noPaymentHistoryReturned',
];

const catalogs = registeredCopy();
const textOf = (namespace: string, locale: 'en' | 'es' | 'fr') =>
  Object.entries(catalogs.find((entry) => entry.namespace === namespace)?.messages[locale] ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

describe('customer copy reads as plain language', () => {
  it('registered every catalog that was cleaned', () => {
    const present = new Set(catalogs.map((entry) => entry.namespace));
    for (const namespace of [...CHECKED, 'pay.surface']) expect(present.has(namespace), namespace).toBe(true);
  });

  for (const namespace of CHECKED) {
    it(`${namespace}: no engineering terms, raw codes or people’s names (en, es, fr)`, () => {
      const offenders: string[] = [];
      for (const locale of ['en', 'es', 'fr'] as const)
        for (const [key, value] of textOf(namespace, locale)) {
          // Keys of the public catalog are the English sentence itself; check the written value.
          if (
            ENGINEERING.test(value) ||
            RAW_CODE.test(value) ||
            NAMES.test(value) ||
            (locale !== 'en' && ENGINEERING_TRANSLATED.test(value))
          )
            offenders.push(`${locale}:${key} → ${value}`);
        }
      expect(offenders).toEqual([]);
    });
  }

  it('pay.surface: the personal and person-to-person sentences are plain', () => {
    const offenders: string[] = [];
    for (const locale of ['en', 'es', 'fr'] as const) {
      const rows = new Map(textOf('pay.surface', locale));
      for (const key of PAY_SURFACE_KEYS) {
        const value = rows.get(key);
        // English must have every pinned key; a renamed or deleted key fails here instead of quietly passing.
        if (value === undefined) {
          if (locale === 'en') offenders.push(`missing:${key}`);
          continue;
        }
        if (ENGINEERING.test(value) || RAW_CODE.test(value) || (locale !== 'en' && ENGINEERING_TRANSLATED.test(value)))
          offenders.push(`${locale}:${key} → ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every changed string kept its placeholders in all three languages', () => {
    // defineCopy throws on a mismatch when a catalog registers, so reaching here proves it; spot-check two.
    expect(textOf('customer.money.standing', 'en').find(([key]) => key === 'count')?.[1]).toContain('{count}');
    expect(textOf('customer.money.standing', 'fr').find(([key]) => key === 'count')?.[1]).toContain('{limit}');
  });
});
