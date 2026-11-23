import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';

/**
 * A button that states why it is off, drawn with the kit: the reason sits next to the button, not in a tooltip, and the
 * button points at it, so a screen reader hears it with the button. When the button is on, no reason is shown.
 */
export function KitGuardedButton({
  reason,
  reasonId,
  variant = 'primary',
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  reason: ReactNode | null;
  reasonId: string;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <div className="lt-stack">
      <Button {...props} tone={variant} disabled={reason !== null} aria-describedby={reason !== null ? reasonId : undefined}>
        {children}
      </Button>
      {reason !== null && (
        <small id={reasonId} className="lt-hint">
          {reason}
        </small>
      )}
    </div>
  );
}
