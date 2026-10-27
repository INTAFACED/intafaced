import { useId } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './deps';

/**
 * "About this number" tip: a small info button that opens a kit Tooltip on hover and on keyboard focus
 * (UI-SPEC 4.1 Tooltip). It is a real button so a keyboard user can reach and read the rule (critic M5); the
 * full text also sits in the page for screen readers, so it never depends on hover. The tip opens below the
 * number: above it, the text hid behind the top bar and the local test banner (critic H7). The tip beside the
 * "Est. total value" label opens to the right, so it does not cover the figure it explains.
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
