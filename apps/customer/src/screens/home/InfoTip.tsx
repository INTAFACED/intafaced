import { InfoTip as KitTip } from '@intafaced/ui/lit';

/**
 * "About this number" tip: the kit's info key, which shows the rule on hover, keyboard focus and press (UI-SPEC 4.1
 * Tooltip; critic M5). The full text also sits in the page for screen readers, so it never depends on hover. The tip beside
 * the "Est. total value" label opens towards the line's end, so it does not cover the figure it explains.
 */
export function InfoTip({ text, label, side = 'bottom' }: { text: string; label: string; side?: 'bottom' | 'right' }) {
  return <KitTip text={text} label={label} side={side === 'right' ? 'end' : 'below'} data-testid="if-tip" />;
}
