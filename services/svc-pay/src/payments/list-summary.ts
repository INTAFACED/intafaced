/**
 * Totals for a payment filter, over every matching row, not the loaded page.
 *
 * Succeeded is captured, settled, refunded, or disputed. Failed is failed.
 * Created and authorized have not finished, so they count in `matchedCount`
 * and in neither side of the rate. No finished payment is `successRate: null`,
 * never 0 and never 100. The rate is a whole percent, half up (2 of 3 is "67").
 */
export interface PaymentListSummary {
  matchedCount: string;
  succeededCount: string;
  failedCount: string;
  finishedCount: string;
  successRate: string | null;
}

export function paymentListSummary(matched: bigint, succeeded: bigint, failed: bigint): PaymentListSummary {
  if (matched < 0n || succeeded < 0n || failed < 0n || succeeded + failed > matched) {
    throw new Error('payment list counts are inconsistent');
  }
  const finished = succeeded + failed;
  const successRate = finished === 0n ? null : ((succeeded * 100n + finished / 2n) / finished).toString();
  return {
    matchedCount: matched.toString(),
    succeededCount: succeeded.toString(),
    failedCount: failed.toString(),
    finishedCount: finished.toString(),
    successRate,
  };
}

const COUNT = /^(?:0|[1-9]\d*)$/;

export function paymentListSummaryFromText(matched: string, succeeded: string, failed: string): PaymentListSummary {
  if (!COUNT.test(matched) || !COUNT.test(succeeded) || !COUNT.test(failed)) {
    throw new Error('payment list count was not an integer');
  }
  return paymentListSummary(BigInt(matched), BigInt(succeeded), BigInt(failed));
}
