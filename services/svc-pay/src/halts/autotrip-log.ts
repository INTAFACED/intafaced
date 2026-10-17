/**
 * A failure while RECORDING an auto-trip streak. The money outcome has already
 * been decided; this must not change it. The default sink is silent so tests
 * and library callers need no logger. `index.ts` wires the service log.
 * The counter is process-local and only answers "did accounting throw".
 */
export interface AutoTripAccountError {
  readonly op: 'recordFailure' | 'recordSuccess';
  readonly scope: string;
  readonly target: string;
  readonly sourceKey: string;
  readonly name: string;
}

export type AutoTripAccountErrorSink = (event: AutoTripAccountError) => void;

let sink: AutoTripAccountErrorSink = () => undefined;
let count = 0;

export function setAutoTripAccountErrorSink(next: AutoTripAccountErrorSink | null): void {
  sink = next ?? (() => undefined);
}

export function autoTripAccountErrorCount(): number {
  return count;
}

export function resetAutoTripAccountErrors(): void {
  count = 0;
}

/** Never throws: a broken logger must not change the money answer. */
export function noteAutoTripAccountError(event: AutoTripAccountError): void {
  count += 1;
  try {
    sink(event);
  } catch {
    // swallowed on purpose
  }
}
