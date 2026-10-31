/**
 * `PAY_SETTLEMENT_ASSETS`: the assets a business can settle in, as ledger asset ids (`USDT,EUR`). It is an owner
 * setting with NO DEFAULT: blank means "not set", and the read that needs it refuses `pay.settlement_assets_unset`.
 * Never invent a list (USDT is not assumed). A malformed or repeated entry is refused at boot, so a typo never quietly
 * drops an asset from what a business is shown.
 */
export class SettlementAssetsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementAssetsConfigError';
  }
}

/** A ledger asset id: letters and digits, with `.`, `_` or `-` inside, at most 16 characters (the wire's limit). */
const ASSET_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,14}[A-Za-z0-9])?$/;

/** The list, in the owner's order; `null` when blank (unset). */
export function parseSettlementAssets(raw: string | undefined): readonly string[] | null {
  const text = raw?.trim() ?? '';
  if (text === '') return null;
  const out: string[] = [];
  for (const part of text.split(',')) {
    const asset = part.trim();
    if (!ASSET_ID.test(asset)) {
      throw new SettlementAssetsConfigError(`PAY_SETTLEMENT_ASSETS has a malformed asset id "${asset}"`);
    }
    if (out.includes(asset)) throw new SettlementAssetsConfigError(`PAY_SETTLEMENT_ASSETS names "${asset}" twice`);
    out.push(asset);
  }
  return Object.freeze(out);
}
