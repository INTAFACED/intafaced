import { createHash } from 'node:crypto';
import { formatAmount, mulBps, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { NOTHING_REPORTED, type CardPartnerTerms } from './partner-terms.js';

/**
 * THE CARD ISSUER PORT (§8.1 `bank.cards`) — and the line this file is drawn on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS MISSING IN THE WORLD, AND WHAT IS MISSING IN THE CODE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `bank.cards` is two halves and they fail for completely different reasons.
 *
 * The LEDGER half — an authorisation arrives, a balance is checked, the funds
 * are held or the authorisation is declined, a capture takes the value out and
 * cashback pays some of it back — needs nothing from anybody. It is arithmetic
 * over accounts this platform already owns, and it is built: `card-service.ts`.
 *
 * The LIVE RAIL half needs a card-scheme sponsor and an issuing BIN. Those are
 * a licence and a contract, not a module. No amount of engineering time
 * produces one, which is the test for a §13 socket: `socket.live-issuer`.
 *
 * This interface is the seam between them. Everything above it is finished;
 * everything below it is a commercial relationship. Splitting them is the only
 * way the board can say something true about either — a single row collapsing
 * both reads as "nothing works", which is false, or "cards work", which is
 * worse.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT AN IMPLEMENTATION OF THIS PORT IS *NOT* ALLOWED TO DO
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Move value. Not one unit. An issuer decides whether a card exists and carries
 * our decision back to the network; the ledger decides where money goes, and it
 * does so through `packages/ledger-client` recipes (§0.6). An adapter that
 * posted anything would be a second book with a partner's name on it.
 *
 * `card-service.ts` enforces that by construction: no `LedgerClient` is passed
 * to an adapter, ever.
 */

/** What the programme calls itself, and whether it is real. */
export interface CardProgramme {
  /** Stable identifier — also the ledger RAIL label, so the boundary account is greppable. */
  readonly id: string;
  /**
   * TRUE MEANS NO CARD EXISTS ANYWHERE.
   *
   * Carried on the port rather than inferred from the id, and surfaced through
   * the router on every card, because "is this a real card" is the one question
   * a user, an operator and an auditor all ask first and none of them should
   * have to read a composition root to answer it.
   */
  readonly simulated: boolean;
  /** Human label. Never a scheme or partner name (§0.7). */
  readonly displayName: string;
}

export interface IssuedCardHandle {
  /** The issuer's own identifier for the card. */
  readonly issuerRef: string;
  /**
   * The last four digits a user recognises their card by.
   *
   * On a simulated programme these are derived from the card id, so they are
   * stable and reproducible and correspond to no card number that has ever been
   * issued by anybody. There is no PAN here and there is nowhere to put one:
   * card numbers are issuer-held data and this service never sees, stores or
   * transmits one.
   */
  readonly panTail: string;
}

export type AuthorizationOutcome =
  { readonly decision: 'approved'; readonly amount: Amount } | { readonly decision: 'declined'; readonly reason: string };

/**
 * The port.
 *
 * Three methods, and the shape of them is the shape of a real issuing
 * integration: create a card, answer an authorisation inside the network's
 * window, and change a card's state. What a live implementation adds is
 * transport, credentials, signature verification and a latency budget — not a
 * different set of decisions.
 */
export interface CardIssuerAdapter {
  readonly programme: CardProgramme;
  /**
   * When set, CardService refuses issue/authorise before a row or hold.
   * `card-sim` under live posture sets `bank.card_sim_not_live`. The unconfigured
   * default throws the same code from its methods without this field, so
   * authorise on a missing card stays `bank.card_not_found`.
   */
  readonly mutationRefuse?: 'bank.card_sim_not_live';

  /** Register a card with the issuer. Returns the issuer's handle on it. */
  issue(input: { cardId: string; userId: string; assetId: string }): Promise<IssuedCardHandle>;

  /**
   * Carry our decision back to the issuer.
   *
   * Called AFTER the ledger has been asked and answered, because the decision
   * has to be true before it is delivered. On a live rail this is the call with
   * a hard deadline — a scheme expects an answer in single-digit seconds and
   * treats silence as a decline — which is why the balance check and the hold
   * happen first and this is the last thing in the path.
   */
  respondToAuthorization(input: {
    cardId: string;
    issuerRef: string;
    authorizationRef: string;
    outcome: AuthorizationOutcome;
  }): Promise<void>;

  /**
   * What the card partner reports about the four unknowns (`partner-terms.ts`): custody mode, the assets it spends from,
   * loss liability, reserve and funder. A `null` in any is "not known". It never moves value and never throws for an
   * unknown; it throws only where there is no partner to ask (`bank.no_card_issuer`) or the simulator stands in a live
   * deployment (`bank.card_sim_not_live`). Optional: an adapter without it reports nothing, so every answer reads "not known".
   */
  partnerTerms?(): CardPartnerTerms;

  /**
   * What the partner reports this cardholder can spend, per asset, as decimal strings (J-bank-29 #2). `null` is "not
   * known". Reads only. Optional: an adapter without it reports no balances, and each reads "not known".
   */
  cardholderBalances?(input: { userId: string }): Promise<Readonly<Record<string, string>> | null>;

  /**
   * Send the partner one programme funding instruction (J-bank-26 #6): fund or defund an amount of the funding stablecoin,
   * or set auto reload (top up `amount` when the programme falls below `threshold`). `requestId` is the business key the
   * partner deduplicates on, so a retry after a crash is the same instruction. The partner moves the money under its own
   * licence; nothing posts to our ledger. Optional: an adapter without it offers none of the three.
   */
  programmeFunding?(input: {
    requestId: string;
    kind: 'fund' | 'defund' | 'auto_reload';
    assetId: string;
    amount: string;
    threshold: string | null;
  }): Promise<{ partnerRef: string }>;

  /**
   * Ask the partner to credit its cardholder provisionally while a dispute is open (J-bank-27 #3). The credit is the
   * partner's, under its licence: the partner answers with its reference and the amount it credited, and the cardholder's
   * available, as the partner reports it, rises by that amount. `requestId` is the business key the partner deduplicates
   * on, so a retry after a crash is the same credit. Nothing posts to our ledger. Optional: an adapter without it takes no
   * provisional credit (`bank.card_dispute_partner_unset`).
   */
  provisionalCredit?(input: { requestId: string; userId: string; assetId: string; amount: string }): Promise<{
    partnerRef: string;
    amount: string;
  }>;

  /**
   * Tell the partner how a dispute was decided (J-bank-27 #4): its provisional credit becomes final, or the partner
   * reverses it. Deduplicated on `requestId`. Optional, as `provisionalCredit`.
   */
  settleProvisionalCredit?(input: { requestId: string; creditRequestId: string; settlement: 'final' | 'reversed' }): Promise<{
    partnerRef: string;
  }>;

  /** Freeze, unfreeze or close the card at the issuer. */
  setStatus(input: { cardId: string; issuerRef: string; status: 'active' | 'frozen' | 'closed' }): Promise<void>;

  /**
   * Return the PAN, expiry and CVV. Optional because `card-sim` has none.
   *
   * CardService calls this only for a non-simulated programme and never writes
   * the result. Absent means `bank.card_pan_issuer_unset` (`socket.live-issuer`).
   */
  revealCredentials?(input: { cardId: string; issuerRef: string }): Promise<{ pan: string; expiry: string; cvv: string }>;

  /** View the PIN. Same rule as `revealCredentials`: not stored, not on card-sim. */
  revealPin?(input: { cardId: string; issuerRef: string }): Promise<{ pin: string }>;

  /** Set the PIN at the issuer. The PIN is not stored here. */
  setPin?(input: { cardId: string; issuerRef: string; pin: string }): Promise<void>;

  /**
   * Opaque push-provisioning payload for Apple Pay or Google Pay.
   * CardService does not store the payload. Absent means `bank.card_wallet_issuer_unset`.
   */
  provisionWallet?(input: { cardId: string; issuerRef: string; wallet: 'apple' | 'google'; nonce: string }): Promise<{ payload: string }>;
}

/**
 * `card-sim` — A SIMULATOR. THERE IS NO CARD.
 *
 * ── What this IS ─────────────────────────────────────────────────────────────
 *
 * An in-process stand-in that lets the whole ledger half of `bank.cards` be
 * exercised end to end: issue a card, authorise against a real ledger balance,
 * decline when the money is not there, capture, reverse, pay cashback out of a
 * pot that was really funded. Every one of those postings is a real transaction
 * in the real book. That is what makes this worth building rather than mocking
 * in a test file — the money path is production code and only the counterparty
 * is simulated.
 *
 * ── What this is NOT, stated rather than implied ─────────────────────────────
 *
 *   · NOT a card. Nothing here can be presented at a terminal, added to a
 *     wallet, or used online. `panTail` is four digits derived from a uuid.
 *   · NOT a connection to a card scheme, an issuer, a processor or a bank. It
 *     makes no network call of any kind and has no credentials to make one with.
 *   · NOT a settlement rail. `railBoundary('card-sim', asset)` is where value
 *     goes when a capture clears, and nothing is on the other side of it. The
 *     boundary account is the honest record that value left OUR book; it is not
 *     a claim that anybody received it.
 *   · NOT a decision engine. There is no fraud scoring, no velocity check, no
 *     3-D Secure, no MCC policy beyond the per-authorisation ceiling, and no
 *     network-level decline reason. A live rail brings all of those and they
 *     will belong to the adapter, not to `card-service.ts`.
 *   · NOT a licence. The reason there is no live implementation of this
 *     interface is not that nobody has written one — it is `socket.live-issuer`,
 *     a sponsor bank and an issuing BIN, which is a contract.
 *
 * Anything a surface renders from a card issued here must carry `simulated`
 * through, and the router does.
 */
/**
 * THE PUBLIC PROGRAMME SURFACE.
 *
 * `simulated` is a required boolean, not an inferred id and not an omitted
 * default. A mapper that dropped the field would let a screen treat a
 * simulator (or an unconfigured programme) as live. This copies the three
 * fields explicitly so a later spread cannot lose the flag.
 */
export function cardProgrammeOutput(programme: CardProgramme): CardProgramme {
  if (typeof programme.simulated !== 'boolean') {
    throw new TypeError('Card programme must declare whether it is simulated');
  }
  return { id: programme.id, simulated: programme.simulated, displayName: programme.displayName };
}

export function cardSim(options: { displayName?: string; partner?: CardPartnerTerms } = {}): CardIssuerAdapter {
  // The TEST partner's answers (`BANK_CARD_SIM_PARTNER_JSON`), copied so a caller's object cannot change them later.
  const partner: CardPartnerTerms = { ...(options.partner ?? NOTHING_REPORTED), test: true };
  const programme = cardProgrammeOutput({
    id: 'card-sim',
    simulated: true,
    // Says what it is in the name, because this string reaches a screen.
    displayName: options.displayName ?? 'Simulated card (no card programme)',
  });
  const credits = new Map<string, { userId: string; assetId: string; amount: Amount; partnerRef: string; reversed: boolean }>();

  return {
    programme,

    issue: async ({ cardId }) => ({
      issuerRef: `card-sim:${cardId}`,
      // Deterministic, so re-issuing the same card id twice is the same card
      // rather than two, and derived from a hash so nobody can read a sequence
      // out of it. Four digits that identify nothing.
      panTail: (parseInt(createHash('sha256').update(cardId).digest('hex').slice(0, 8), 16) % 10_000).toString().padStart(4, '0'),
    }),

    // The simulator has nowhere to carry a decision TO. Doing nothing is the
    // truthful implementation, and it is written as one line rather than as a
    // queue that never drains.
    respondToAuthorization: async () => undefined,
    setStatus: async () => undefined,
    partnerTerms: () => partner,
    // The TEST partner's figures: the same TEST balances for every cardholder, as its switches set them, plus any
    // provisional dispute credit it has given that cardholder and not reversed (J-bank-27 #3).
    cardholderBalances: async ({ userId }) => withCredits(partner.balances, userId, credits),
    // The TEST partner takes an instruction it offers and answers with a TEST reference derived from the request's key,
    // so the same request always gets the same reference. It moves nothing: there is no partner and no money behind it.
    programmeFunding: async (input) => {
      const offers = partner.fundingOffers;
      const offered = offers && (input.kind === 'fund' ? offers.fund : input.kind === 'defund' ? offers.defund : offers.autoReload);
      if (!offered || partner.fundingAssetId !== input.assetId) {
        throw new BankError(`The TEST card partner does not offer ${input.kind} in ${input.assetId}`, 'bank.card_funding_not_offered');
      }
      return { partnerRef: `TEST-card-sim-${createHash('sha256').update(input.requestId).digest('hex').slice(0, 16)}` };
    },
    // TEST rule: the TEST partner credits the disputed amount in full, once per request key, and adds it to what it reports
    // that cardholder can spend in that asset. It keeps its credits in this process only, as a stand-in: there is no
    // partner and no money behind them, and nothing posts to the ledger.
    provisionalCredit: async (input) => {
      const prior = credits.get(input.requestId);
      if (prior) return { partnerRef: prior.partnerRef, amount: formatAmount(prior.amount) };
      const credit = {
        userId: input.userId,
        assetId: input.assetId,
        amount: parseAmount(input.amount),
        partnerRef: testRef('credit', input.requestId),
        reversed: false,
      };
      credits.set(input.requestId, credit);
      return { partnerRef: credit.partnerRef, amount: formatAmount(credit.amount) };
    },
    settleProvisionalCredit: async (input) => {
      const credit = credits.get(input.creditRequestId);
      if (credit && input.settlement === 'reversed') credit.reversed = true;
      return { partnerRef: testRef(input.settlement, input.requestId) };
    },
  };
}

const testRef = (kind: string, key: string): string =>
  `TEST-card-sim-${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

/** The TEST partner's reported balance for one cardholder: its TEST figure plus the provisional credits it has not reversed. */
function withCredits(
  balances: Readonly<Record<string, string>> | null,
  userId: string,
  credits: ReadonlyMap<string, { userId: string; assetId: string; amount: Amount; reversed: boolean }>,
): Readonly<Record<string, string>> | null {
  if (!balances) return balances;
  const out: Record<string, string> = { ...balances };
  for (const c of credits.values()) {
    // An asset the partner reports no balance for stays "not known": a credit does not make it known.
    if (c.userId !== userId || c.reversed || out[c.assetId] === undefined) continue;
    out[c.assetId] = formatAmount(parseAmount(out[c.assetId]!) + c.amount);
  }
  return out;
}

/**
 * THE DEFAULT, AND IT REFUSES EVERYTHING.
 *
 * A deployment that has not chosen an issuer has no card programme, and the
 * dangerous default is the plausible one: fall back to the simulator, and now
 * an environment somebody believes is live is approving authorisations against
 * a counterparty that does not exist.
 *
 * Same posture as `createBankServices`' price source, which defaults to a feed
 * with no prices in it so that no mark is possible rather than a bad mark being
 * possible. Choosing `cardSim()` has to be an act somebody performed.
 */
export const noCardIssuer: CardIssuerAdapter = {
  programme: cardProgrammeOutput({ id: 'none', simulated: true, displayName: 'No card programme' }),
  issue: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card programme', 'bank.no_card_issuer');
  },
  respondToAuthorization: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card programme', 'bank.no_card_issuer');
  },
  setStatus: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card programme', 'bank.no_card_issuer');
  },
  partnerTerms: () => {
    throw new BankError('No card issuer is configured — this deployment has no card partner to ask', 'bank.no_card_issuer');
  },
  cardholderBalances: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card partner to ask', 'bank.no_card_issuer');
  },
  programmeFunding: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card partner to fund', 'bank.no_card_issuer');
  },
  provisionalCredit: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card partner to credit', 'bank.no_card_issuer');
  },
  settleProvisionalCredit: async () => {
    throw new BankError('No card issuer is configured — this deployment has no card partner to tell', 'bank.no_card_issuer');
  },
};

/**
 * THE SETTINGS A DEPLOYMENT MAY CHOOSE BETWEEN, AND THERE ARE EXACTLY TWO.
 *
 * Closed on purpose. A free-form string would let a typo select the fallback
 * branch, and the fallback branch is the one deciding whether this deployment
 * has a card programme at all.
 */
export const CARD_ISSUER_SETTINGS = ['none', 'card-sim'] as const;
export type CardIssuerSetting = (typeof CARD_ISSUER_SETTINGS)[number];

/**
 * Environments where a sandbox rail must not move value — same set pay uses
 * (`RAIL_POSTURE_ENFORCED_ENVS`). `NODE_ENV=production` is the other live flag.
 */
export const CARD_SIM_LIVE_APP_ENVS = ['staging', 'prod'] as const;

export type CardIssuerPosture = {
  /** Explicit override. Wins over env inspection. */
  readonly live?: boolean;
  readonly NODE_ENV?: string;
  /** Only the value passed in — tests must not inherit `.env` APP_ENV. */
  readonly APP_ENV?: string;
};

/**
 * True when this process must not treat `card-sim` as an issuer.
 *
 * `NODE_ENV=production` or `APP_ENV` staging/prod (the existing live flag).
 * Explicit `live: false` keeps the ledger-half simulator usable in tests.
 */
export function cardSimIsLivePosture(posture: CardIssuerPosture = {}): boolean {
  if (posture.live === true) return true;
  if (posture.live === false) return false;
  const nodeEnv = posture.NODE_ENV ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') return true;
  return (CARD_SIM_LIVE_APP_ENVS as readonly string[]).includes(posture.APP_ENV ?? '');
}

const CARD_SIM_NOT_LIVE_MESSAGE = 'card-sim is not a live issuer — this deployment will not issue or authorise as if a BIN exists';

/**
 * `card-sim` under live posture: still named as the simulator on the programme
 * surface (`simulated: true`), and every mutation named-refuses. There is no BIN.
 */
export function cardSimNotLive(): CardIssuerAdapter {
  const refuse = (): never => {
    throw new BankError(CARD_SIM_NOT_LIVE_MESSAGE, 'bank.card_sim_not_live');
  };
  return {
    programme: cardProgrammeOutput({
      id: 'card-sim',
      simulated: true,
      displayName: 'Simulated card (no card programme)',
    }),
    mutationRefuse: 'bank.card_sim_not_live',
    issue: async () => refuse(),
    respondToAuthorization: async () => refuse(),
    setStatus: async () => refuse(),
    // The TEST partner's answers are never shown as a live partner's.
    partnerTerms: () => refuse(),
    cardholderBalances: async () => refuse(),
    programmeFunding: async () => refuse(),
    provisionalCredit: async () => refuse(),
    settleProvisionalCredit: async () => refuse(),
  };
}

/**
 * LIVE-RAIL auth decision budget (tracker title "<2s auth decision").
 *
 * This number is NOT a claim about `card-sim`. An in-process simulator has no
 * network window to miss — measuring it against 2s would be theatre. It is the
 * budget a `socket.live-issuer` adapter must meet when carrying our already-true
 * ledger decision back to a scheme that treats silence as a decline.
 *
 * The ledger half proves separately that balance check + hold + named decline
 * complete well inside this window when the counterparty is simulated, so the
 * book is not the bottleneck a live rail would blame.
 */
export const LIVE_ISSUER_AUTH_DECISION_BUDGET_MS = 2_000;

/**
 * THE ONLY PLACE A DEPLOYMENT'S ISSUER IS CHOSEN.
 *
 * ── Why this function has to exist ───────────────────────────────────────────
 *
 * `noCardIssuer` above is the right default, and until now it was the entire
 * story: nothing anywhere constructed `cardSim()` outside a test file, and
 * `index.ts` never passed a `cards` option to `createBankServices`. So the card
 * procedures the router mounts refused `bank.no_card_issuer` in EVERY
 * deployment, with no setting, flag or argument an operator could use to change
 * that. A refusal nobody can lift is not a safe default — it is an unreachable
 * module wearing a safe default's clothes, and from the outside it is
 * indistinguishable from one that works. That is the state D-S-15 named
 * UNFINISHED.
 *
 * ── Why it is still not a default ────────────────────────────────────────────
 *
 * `'none'` is what you get by saying nothing, and the mapping is TOTAL — a
 * `switch` the compiler checks, not a `?? cardSim()`. Choosing the simulator
 * remains an act somebody performed and wrote into an environment file. The only
 * thing that changed is that the act is now possible.
 *
 * ── What choosing `card-sim` does NOT do ─────────────────────────────────────
 *
 * It does not create a card programme. There is no card, no scheme, no issuing
 * BIN, no network call, and nothing that can be presented at a terminal — see
 * `cardSim` above, which says so at length. It makes the LEDGER half exercisable
 * against real postings in the real book, carrying `simulated: true` on the
 * programme, on every card row and on every router output, so no surface can
 * render one of these as real. The live rail is `socket.live-issuer`: a sponsor
 * bank and a contract, never a setting.
 *
 * ── Live posture ─────────────────────────────────────────────────────────────
 *
 * `card-sim` plus `NODE_ENV=production` or `APP_ENV` staging/prod named-refuses
 * `bank.card_sim_not_live` rather than issuing or authorising as if a BIN
 * exists. `none` is unchanged: `bank.no_card_issuer`.
 */
export function cardIssuerFor(setting: CardIssuerSetting, posture: CardIssuerPosture = {}, partner?: CardPartnerTerms): CardIssuerAdapter {
  switch (setting) {
    case 'card-sim':
      return cardSimIsLivePosture(posture) ? cardSimNotLive() : cardSim(partner ? { partner } : {});
    case 'none':
      return noCardIssuer;
  }
}

/** Cashback owed on a captured amount. Integer basis points, rounded DOWN. */
export function cashbackOn(capturedAmount: Amount, rateBps: number): Amount {
  if (rateBps <= 0) return 0n;
  // Floor, and deliberately: a rounding unit invented in the user's favour is
  // value the rewards pot never earned, and it is paid out of a pot that has to
  // balance. Under-paying by one atomic unit is visible and correctable;
  // over-paying is a slow leak nobody notices.
  return mulBps(capturedAmount, rateBps, 'floor');
}
