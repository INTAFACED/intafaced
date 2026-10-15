/** TEST DATA fixture for the memory-only sandbox; never a live destination. */
export function syntheticPayoutAddress(merchantId: string): string {
  return `0x00000000${merchantId.replaceAll('-', '')}`;
}
