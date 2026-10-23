import { createContext, useContext, type ReactNode } from 'react';
import { moreRoomRoutesCopy } from './more-room-routes-copy';

/** True inside a More room opened with `?simulated=true` (MC-order-01, ORD-002): `useAction` sends nothing there. */
const PaperMode = createContext(false);
export const usePaperMode = () => useContext(PaperMode);

/** A room of the set in its simulated view: the shared label above it, and every action in it refused before any request. */
export function PaperRoom({ paper, liveHref, children }: { paper: boolean; liveHref: string; children: ReactNode }) {
  const { t, languageFor } = moreRoomRoutesCopy.useCopy();
  if (!paper) return <>{children}</>;
  return (
    <PaperMode.Provider value={true}>
      <section className="more-paper-banner" role="note" data-paper="simulated" aria-labelledby="more-paper-title">
        <span className="more-paper-label" lang={languageFor('paperLabel')}>
          {t('paperLabel')}
        </span>
        <h2 id="more-paper-title" lang={languageFor('paperTitle')}>
          {t('paperTitle')}
        </h2>
        <p lang={languageFor('paperBody')}>{t('paperBody')}</p>
        <a className="text-link" href={liveHref} lang={languageFor('paperExit')}>
          {t('paperExit')}
        </a>
      </section>
      {children}
    </PaperMode.Provider>
  );
}
