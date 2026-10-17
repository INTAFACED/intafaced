// What the copy desk's three open/closed facts mean to a customer. The service sends booleans plus its own internal
// wording; only the booleans are used here, so the words are always ours.
import { dec, str } from '../../../data/decimal';
import type { CopyDesk } from './api';

export type DeskState = { open: boolean; reasons: string[] };

export function deskState(desk: CopyDesk | null): DeskState | null {
  if (desk === null) return null;
  const reasons: string[] = [];
  if (!desk.feeSharePublished) reasons.push('The share a leader earns from the trading fee has not been approved');
  if (!desk.jurisdictionPublished) reasons.push('The list of countries where copy trading is offered has not been approved');
  if (desk.autoMirrorPlace && !desk.autoMirrorPlace.published) reasons.push('Automatic copying of leader orders is switched off');
  return { open: desk.feeSharePublished && desk.jurisdictionPublished, reasons };
}

/** Basis points as a percent: "250" is "2.5%". Whole-number strings only; anything else is unknown. */
export function bpsText(bps: string | null): string | null {
  if (bps === null || !/^\d+$/.test(bps)) return null;
  const whole = bps.length > 2 ? bps.slice(0, -2) : '0';
  const fraction = bps.padStart(2, '0').slice(-2).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

/** A fee ratio as a percent: "0.001" is "0.1%", "0.0025" is "0.25%". Unknown or malformed input is null. */
export function ratioPercent(ratio: string): string | null {
  const value = dec(ratio);
  if (value === null || value < 0n) return null;
  return `${str(value * 100n)}%`;
}
