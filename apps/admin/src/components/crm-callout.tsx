import type { HTMLAttributes, ReactNode, Ref } from 'react';

export type CalloutTone = 'neutral' | 'warn' | 'danger';
type IconName = 'info' | 'check' | 'warning' | 'danger';

const PATHS: Record<IconName, ReactNode> = {
  // A circle with an "i".
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v3.5M8 5v.01" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.25 8.25 1.9 1.9 3.6-3.9" />
    </>
  ),
  // A triangle with an exclamation mark.
  warning: (
    <>
      <path d="M8 2.25 14.25 13H1.75L8 2.25Z" />
      <path d="M8 6.5v3M8 11.25v.01" />
    </>
  ),
  danger: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75M8 10.75v.01" />
    </>
  ),
};

/** A 16px outline icon. Decorative: the words beside it carry the meaning. */
export function CrmIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="crm-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

const DEFAULT_ICON: Record<CalloutTone, IconName> = { neutral: 'info', warn: 'warning', danger: 'danger' };

/**
 * The one message box the CRM uses for saved notices, restored drafts, stale-draft warnings, errors and "are you sure"
 * questions: 1px border, 8px radius, 12px 16px padding, a faint tint of its tone and a 16px leading icon.
 * Pass `role` ("alert" for something that went wrong, "status" for something that was done); the box adds none of its own.
 */
export function Callout({
  tone = 'neutral',
  icon,
  actions,
  children,
  className,
  innerRef,
  ...rest
}: {
  tone?: CalloutTone;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  innerRef?: Ref<HTMLDivElement>;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div ref={innerRef} className={`crm-callout${className ? ` ${className}` : ''}`} data-tone={tone} {...rest}>
      <CrmIcon name={icon ?? DEFAULT_ICON[tone]} />
      <div className="crm-callout__body">
        <div className="crm-callout__text">{children}</div>
        {actions && <div className="crm-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}
