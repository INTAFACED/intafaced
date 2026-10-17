/**
 * A payment mutation has already committed. The following facts read (pricing
 * snapshot, catalog failure) failed. The caller still gets the committed
 * payment. The sink is silent until the process wires a logger. The event
 * names the payment id only — a facts-query error can carry row text.
 */
export interface PaymentFactsReadFailure {
  readonly paymentId: string;
}

export type PaymentFactsReadFailureSink = (event: PaymentFactsReadFailure) => void;

let sink: PaymentFactsReadFailureSink = () => undefined;

export function setPaymentFactsReadFailureSink(next: PaymentFactsReadFailureSink | null): void {
  sink = next ?? (() => undefined);
}

export function logPaymentFactsReadFailure(paymentId: string): void {
  sink({ paymentId });
}
