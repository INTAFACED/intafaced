import { useId, type ReactNode } from 'react';
import { Button } from '../../shared/ui';
import './bank-depth.css';

/** A control that is on the screen but cannot be used, with the reason next to it in plain words. */
export function DisabledAction({
  label,
  reason,
  variant = 'secondary',
}: {
  label: ReactNode;
  reason: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const id = useId();
  return (
    <div className="bd-disabled">
      <Button variant={variant} disabled aria-describedby={id}>
        {label}
      </Button>
      <p id={id} className="money-caption">
        {reason}
      </p>
    </div>
  );
}

/** Several controls that are blocked for one reason: the buttons sit side by side and the reason is said once. */
export function DisabledActions({
  labels,
  reason,
  variant = 'secondary',
}: {
  labels: ReactNode[];
  reason: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const id = useId();
  return (
    <div className="bd-disabled">
      <div className="actions">
        {labels.map((label, index) => (
          <Button key={index} variant={variant} disabled aria-describedby={id}>
            {label}
          </Button>
        ))}
      </div>
      <p id={id} className="money-caption">
        {reason}
      </p>
    </div>
  );
}

/** A real on/off switch. It shows the state the service reports, in words as well as position, and asks before it changes it. */
export function ChannelSwitch({
  label,
  on,
  state,
  disabled,
  onToggle,
}: {
  label: ReactNode;
  on: boolean;
  state: ReactNode;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bd-switch-row">
      <button type="button" role="switch" aria-checked={on} disabled={disabled} className="bd-switch-btn" onClick={onToggle}>
        <span>{label}</span>
        <span className="bd-switch-state">
          {state}
          <span className="bd-switch" aria-hidden="true">
            <span className="bd-switch__knob" />
          </span>
        </span>
      </button>
    </div>
  );
}

export function DepthPanel({ title, lead, children, id }: { title: ReactNode; lead?: ReactNode; children: ReactNode; id?: string }) {
  const heading = useId();
  return (
    <section className="bd-panel" aria-labelledby={heading} id={id}>
      <h3 id={heading}>{title}</h3>
      {lead && <p className="money-caption">{lead}</p>}
      {children}
    </section>
  );
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="bd-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
