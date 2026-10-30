// How a bot reads in "My bots": its kind, then its market. TWAP, VWAP, POV and DCA are names and stay as they are; only
// "Spot grid" is a phrase, so it goes through the room's copy. A kind this screen does not know reads in capitals.
const KIND_NAME: Record<string, string> = { twap: 'TWAP', vwap: 'VWAP', pov: 'POV', dca: 'DCA' };

export function botName(kind: string, market: string, t: (key: 'Spot grid') => string): string {
  return `${kind === 'grid' ? t('Spot grid') : (KIND_NAME[kind] ?? kind.toUpperCase())} ${market}`;
}
