import type { ReactNode } from 'react';
import { Page } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy } from '../copy';
import { watchCopy } from './copy';
import '../protocol.css';

/** Shell of a Web3 page: the read-only banner and the Not INTACHAIN pill every protocol room carries. */
export function WatchShell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const { language } = usePreferences();
  const room = protocolCopy.forLocale(language).t;
  return (
    <div className="legacy-room protocol-room" lang={watchCopy.forLocale(language).renderedLocale}>
      <Page
        title={title}
        description={description}
        eyebrow={
          <>
            <span>{room('bannerLine')}</span>
            <span className="badge protocol-pill">{room('bannerPill')}</span>
          </>
        }
      >
        {children}
      </Page>
    </div>
  );
}
