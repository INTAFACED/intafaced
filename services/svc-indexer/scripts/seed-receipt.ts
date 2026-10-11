/**
 * viem's `waitForTransactionReceipt` resolves a reverted receipt. It does not
 * throw. The same `receipt.status !== 'success'` refusal as `deployDevVenue`.
 */
export function assertSeedReceipt(receipt: { readonly status: string }): void {
  if (receipt.status !== 'success') {
    throw new Error(`DevVenue seed failed: receipt status ${receipt.status}`);
  }
}
