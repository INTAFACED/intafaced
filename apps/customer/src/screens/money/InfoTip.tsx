import { useId } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './deps';

/**
 * "About this number": a real button that opens a kit Tooltip on hover and on keyboard focus. The text also sits in the
 * page for screen readers, so it never depends on hover. Opens below (or right) of the number, never under the top bar.
 */
export function InfoTip({ text, label, side = 'bottom' }: { text: string; label: string; side?: 'bottom' | 'right' }) {
  const id = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger data-testid="if-tip" className="if-tip" render={<button type="button" aria-label={label} aria-describedby={id} />}>
          <Info size={16} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent side={side} align={side === 'right' ? 'start' : 'center'}>
          {text}
        </TooltipContent>
      </Tooltip>
      <span id={id} className="if-sr">
        {text}
      </span>
    </>
  );
}
