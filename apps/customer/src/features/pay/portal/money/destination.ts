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
