import type { ReactNode } from 'react';
import './depth.css';

export type DepthState = 'ready' | 'blocked' | 'info' | 'paper';

/** A small status mark. The label is authored copy supplied by the caller. */
export function StatusPill({ state, children }: { state: DepthState; children: ReactNode }) {
  return <span className={`depth-pill depth-pill--${state}`}>{children}</span>;
}

export type JourneyStep = {
  id: string;
  title: ReactNode;
  body: ReactNode;
  state: DepthState;
  stateLabel: ReactNode;
  /** The named blocker, shown verbatim when the step cannot run. */
  reason?: ReactNode;
  action?: ReactNode;
};

/** An ordered journey. Every step states whether it can run and, if not, why. */
export function Journey({ steps, label }: { steps: readonly JourneyStep[]; label: string }) {
  return (
    <ol className="depth-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} className={`depth-step depth-step--${step.state}`}>
          <span className="depth-step-index" aria-hidden="true">
            {index + 1}
          </span>
          <div className="depth-step-main">
            <div className="depth-step-head">
              <h3>{step.title}</h3>
              <StatusPill state={step.state}>{step.stateLabel}</StatusPill>
            </div>
            <p>{step.body}</p>
            {step.reason ? <p className="depth-reason">{step.reason}</p> : null}
            {step.action ? <div className="depth-step-action">{step.action}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Row of at-a-glance numbers. A value is a real reading or a stated absence. */
export function StatRow({ items }: { items: readonly { label: ReactNode; value: ReactNode; note?: ReactNode }[] }) {
  return (
    <dl className="depth-stats">
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.note ? <small>{item.note}</small> : null}
        </div>
      ))}
    </dl>
  );
}

/** A control that cannot run: shown disabled, with the reason next to it. */
export function DisabledAction({ label, reason }: { label: ReactNode; reason: ReactNode }) {
  return (
    <div className="depth-disabled">
      <button type="button" className="button button--primary" disabled aria-disabled="true">
        {label}
      </button>
      <p className="muted" role="note">
        {reason}
      </p>
    </div>
  );
}
