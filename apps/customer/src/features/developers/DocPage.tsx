import type { ReactNode } from 'react';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { docsCopy } from './developers-docs-copy';

/**
 * One written page of the developer portal on the reading template: its title and lead, its sections in the body, and
 * the link back to the portal home in the footer. The page keeps its own `developers-<id>` test id around the room.
 */
export function DocPage({
  id,
  title,
  lead,
  back,
  children,
}: {
  id: string;
  title: string;
  lead: string;
  /** The back link's words, when the page's own copy names them; else the portal's. */
  back?: string;
  children: ReactNode;
}) {
  const { t } = docsCopy.useCopy();
  return (
    <div data-testid={`developers-${id}`}>
      <ReadingTemplate
        title={title}
        description={lead}
        state={{ kind: 'ready' }}
        body={<div className="lt-stack">{children}</div>}
        footer={<BackLink label={back ?? t('back')} />}
      />
    </div>
  );
}

/** The link back to a portal page, standing on its own. */
export function BackLink({ label, href = '/developers' }: { label: string; href?: string }) {
  return (
    <a className="lt-link lt-link-alone" href={href}>
      <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {label}
    </a>
  );
}

/** A link on to another page, standing on its own. */
export function GoLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="lt-link lt-link-alone" href={href}>
      {children} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
    </a>
  );
}
