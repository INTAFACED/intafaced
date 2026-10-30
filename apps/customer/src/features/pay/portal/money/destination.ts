import { mc } from './copy';

type Words = ReturnType<typeof mc.useCopy>['t'];
const RAILS = { 'crypto-native': 'railCrypto', 'card-sandbox': 'railCard', 'bank-payout': 'railBank' } as const;

/** The network or bank a payout goes through, in words. An unknown rail is "a payout network", never its internal id. */
export const railWords = (t: Words, railId: string): string => (railId in RAILS ? t(RAILS[railId as keyof typeof RAILS]) : t('railOther'));

/** "Wallet 0x1234…abcd · Crypto network" or "Bank account ••••1234 · Bank transfer". The service already masked it. */
export function describeDestination(t: Words, kind: string, masked: string, railId: string): string {
  const what = kind === 'crypto' ? t('destWallet') : kind === 'bank' ? t('destBank') : t('destOther');
  return railId ? t('destLine', { what, masked, rail: railWords(t, railId) }) : t('destLineBare', { what, masked });
}

/**
 * The masked form svc-pay shows of a destination (`control/mask-destination.ts`): first 6 and last 4 of an address of
 * at least 20 characters, the last 4 of an account of at least 9. Used only to check that a retyped destination is the
 * saved one before asking for a confirmation; the service decides.
 */
export function maskedLike(kind: string, ref: string): string {
  const compact = ref.trim().replace(/\s+/g, '');
  const address = kind.trim().toLowerCase() === 'crypto' || /^0x[0-9a-fA-F]{40}$/.test(compact);
  if (address) return compact.length < 20 ? '••••' : `${compact.slice(0, 6)}…${compact.slice(-4)}`;
  return compact.length < 9 ? '••••' : `••••${compact.slice(-4)}`;
}
