import { createHash } from 'node:crypto';
import { mulBps, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

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

export function cardSim(options: { displayName?: string } = {}): CardIssuerAdapter {
  const programme = cardProgrammeOutput({
    id: 'card-sim',
    simulated: true,
    // Says what it is in the name, because this string reaches a screen.
    displayName: options.displayName ?? 'Simulated card (no card programme)',
  });

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
  };
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
export function cardIssuerFor(setting: CardIssuerSetting, posture: CardIssuerPosture = {}): CardIssuerAdapter {
  switch (setting) {
    case 'card-sim':
      return cardSimIsLivePosture(posture) ? cardSimNotLive() : cardSim();
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
