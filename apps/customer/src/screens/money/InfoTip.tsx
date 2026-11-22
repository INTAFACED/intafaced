import { InfoTip as KitInfoTip } from '@intafaced/ui/lit';

/**
 * "About this number": the kit's InfoTip, a real button that opens on hover, keyboard focus and a tap. The text also sits in
 * the page as the button's description, so it never depends on hover. Opens below the number, or at its end side, never
 * under the top bar. Money, Home and profit and loss share it.
 */
export function InfoTip({ text, label, side = 'bottom' }: { text: string; label: string; side?: 'bottom' | 'right' }) {
  return <KitInfoTip text={text} label={label} side={side === 'right' ? 'end' : 'below'} data-testid="if-tip" />;
}
