/**
 * Post-only rejection and the scale-order send lock (S04).
 *
 * A rejected batch item is refused and is not counted as placed.
 * A lost reply, a 401, or a 403 keeps the do-not-send-twice lock.
 * The lock clears only when the batch is accounted for.
 */

export type DeskInstruction = 'GTC' | 'IOC' | 'FOK' | 'PO';

export function placeInstruction(choice: DeskInstruction): { timeInForce: DeskInstruction; postOnly: boolean } {
  if (choice === 'PO') return { timeInForce: 'PO', postOnly: true };
  return { timeInForce: choice, postOnly: false };
}

export interface BatchItem {
  readonly clientOrderId: string;
  readonly refused: boolean;
}

export function batchItemLabel(item: BatchItem): 'refused' | 'placed' {
  return item.refused ? 'refused' : 'placed';
}

export function placedCount(items: readonly BatchItem[]): number {
  return items.filter((item) => !item.refused).length;
}

export type ScaleOutcome = 'lost' | 'unauthorized' | 'forbidden' | 'accounted' | 'refused';

/** True while a second batch must not be sent. */
export function scaleLockStays(outcome: ScaleOutcome): boolean {
  return outcome !== 'accounted' && outcome !== 'refused';
}
