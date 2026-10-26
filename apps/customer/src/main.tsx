import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './features/session/session';
import './shared/styles.css';
import './app/redesign.css';
import './app/shell.css';
// The Lit glass look, in the kit's order. Every rule is scoped to data-look="lit", or to the kit's own classes and
// role tokens that stay today's skin while it is off, so the app with the look off is unchanged. Fonts are self-hosted.
import '@intafaced/ui/lit/lit.css';
import '@intafaced/ui/lit/fonts.css';
import '@intafaced/ui/lit/components.css';
import '@intafaced/ui/a11y/a11y.css';
import '@intafaced/ui/lit/templates.css';
import { App } from './app/App';
import { applyLook } from './app/look';

// The look's access hooks download only when the look is on, so today's first download is unchanged.
const LitLookRoot = lazy(() => import('./app/LitLookRoot').then((m) => ({ default: m.LitLookRoot })));
const look = applyLook();
const element = document.getElementById('root');
if (!element) throw new Error('Customer root element is missing');
createRoot(element).render(
  <StrictMode>
    {look === 'lit' ? (
      <Suspense fallback={null}>
        <LitLookRoot />
      </Suspense>
    ) : null}
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
