import { useId } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './deps';

/**
 * "About this number" tip: a small info button that opens a kit Tooltip on hover and on keyboard focus
 * (UI-SPEC 4.1 Tooltip). Not a tab stop, so the keyboard order stays eye -> actions -> rows (UI-SPEC 5.1);
 * the full text sits in the page for screen readers, so it never depends on hover.
 */
export function InfoTip({ text, label }: { text: string; label: string }) {
  const id = useId();
  return (
    <Tooltip>
      <TooltipTrigger className="if-tip" render={<span />}>
        <Info size={16} aria-hidden="true" />
        <span id={id} className="if-sr">
          {label}: {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
