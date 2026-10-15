/** Provider contracts carry sensitive inputs; adapters must never log them. */
export interface ScreeningParty {
  readonly name: string;
  readonly country: string;
  readonly registration: string;
}
export interface ScreeningWallet {
  readonly address: string;
  readonly chain: string;
}
/** Trusted dossier resolver supplies independently verified account KYC, not merchant KYB. */
export interface ScreeningPartyContext extends ScreeningParty {
  readonly identityKycTier: 'none' | 'basic' | 'full' | 'institutional';
}
export interface PartyReference {
  readonly merchantId: string;
  readonly kybRef: string;
}
export type ScreeningOutcome = 'pass' | 'review' | 'block' | 'unavailable';
export interface ScreeningDecision {
  readonly outcome: ScreeningOutcome;
  readonly provider: string;
  readonly fixture: boolean;
}
export interface ScreeningProvider {
  /** A fixed adapter identifier, never a customer-supplied string. */
  readonly id: string;
  readonly mode: 'live' | 'fixture';
  resolveParty(reference: PartyReference): Promise<ScreeningPartyContext | null>;
  screenParty(party: ScreeningParty): Promise<ScreeningOutcome>;
  screenWallet(wallet: ScreeningWallet): Promise<ScreeningOutcome>;
}
export interface ScreeningSocket {
  readonly provider: string;
  readonly fixture: boolean;
  resolveParty(reference: PartyReference): Promise<ScreeningPartyContext | null>;
  screenParty(party: ScreeningParty): Promise<ScreeningDecision>;
  screenWallet(wallet: ScreeningWallet): Promise<ScreeningDecision>;
}

export interface ScreeningFixtureCase {
  readonly reference: PartyReference;
  readonly party: ScreeningPartyContext;
  readonly partyOutcome: ScreeningOutcome;
  readonly wallets?: readonly (ScreeningWallet & { readonly outcome: ScreeningOutcome })[];
}

/** Synthetic exact-match answers only. An absent case is unavailable, never a clean miss. */
export function createFixtureScreeningProvider(options: { appEnv?: string; cases: readonly ScreeningFixtureCase[] }): ScreeningProvider {
  if (options.appEnv !== 'dev' && options.appEnv !== 'test') throw new Error('screening.fixture_requires_explicit_dev_test');
  // Copy caller-owned configuration: later mutations must not change fixture authority.
  const cases = structuredClone(options.cases);
  return {
    id: 'fixture-test-data',
    mode: 'fixture',
    async resolveParty(reference) {
      return cases.find((c) => c.reference.merchantId === reference.merchantId && c.reference.kybRef === reference.kybRef)?.party ?? null;
    },
    async screenParty(party) {
      return (
        cases.find((c) => c.party.name === party.name && c.party.country === party.country && c.party.registration === party.registration)
          ?.partyOutcome ?? 'unavailable'
      );
    },
    async screenWallet(wallet) {
      return (
        cases.flatMap((c) => c.wallets ?? []).find((w) => w.address === wallet.address && w.chain === wallet.chain)?.outcome ??
        'unavailable'
      );
    },
  };
}

export function validParty(value: unknown): value is ScreeningParty {
  if (!value || typeof value !== 'object') return false;
  const p = value as ScreeningParty;
  return (
    typeof p.name === 'string' &&
    p.name.trim().length > 0 &&
    p.name.length <= 500 &&
    typeof p.registration === 'string' &&
    p.registration.trim().length > 0 &&
    p.registration.length <= 500 &&
    typeof p.country === 'string' &&
    /^[A-Z]{2}$/.test(p.country) &&
    p.country !== 'XX'
  );
}

/** Unconfigured, failed, timed-out or malformed answers always mean unavailable. */
export function createScreeningSocket(options: { appEnv?: string; provider?: ScreeningProvider; timeoutMs?: number }): ScreeningSocket {
  const configured = options.provider;
  const explicitLocal = options.appEnv === 'dev' || options.appEnv === 'test';
  const provider =
    configured &&
    /^[a-z0-9_-]{1,64}$/.test(configured.id) &&
    (configured.mode === 'live' || (configured.mode === 'fixture' && explicitLocal))
      ? configured
      : undefined;
  const id = provider?.id ?? 'unconfigured';
  const fixture = provider?.mode === 'fixture';
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('screening.invalid_timeout');
  async function bounded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function decide(work: () => Promise<ScreeningOutcome>): Promise<ScreeningDecision> {
    const answer = provider ? await bounded(work, 'unavailable') : 'unavailable';
    const outcome = ['pass', 'review', 'block', 'unavailable'].includes(answer) ? answer : 'unavailable';
    return { outcome, provider: id, fixture };
  }
  return {
    provider: id,
    fixture,
    async resolveParty(reference) {
      if (!provider) return null;
      const party = await bounded(() => provider.resolveParty(reference), null);
      return validParty(party) && ['none', 'basic', 'full', 'institutional'].includes(party.identityKycTier)
        ? { name: party.name, country: party.country, registration: party.registration, identityKycTier: party.identityKycTier }
        : null;
    },
    screenParty(party) {
      return decide(() => (validParty(party) ? provider!.screenParty(party) : Promise.resolve('unavailable')));
    },
    screenWallet(wallet) {
      return decide(() =>
        typeof wallet.address === 'string' && wallet.address.trim() && typeof wallet.chain === 'string' && wallet.chain.trim()
          ? provider!.screenWallet(wallet)
          : Promise.resolve('unavailable'),
      );
    },
  };
}
