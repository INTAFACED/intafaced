import type { ReactNode } from 'react';
import { StatusTag } from '@intafaced/ui';
import './frames.css';

/**
 * The one treatment for a feature that has not launched: a calm card with a short plain line on what it will do.
 * Real permission refusals do not use it; they keep the refusal wording.
 */
export function ComingSoonCard({
  title,
  children = 'You’ll be able to use this part of your business here soon.',
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <section className="pfo-soon" aria-label={title ?? 'Coming soon'}>
      <StatusTag status="working" label="Coming soon" />
      {title && <h3>{title}</h3>}
      <p>{children}</p>
    </section>
  );
}
