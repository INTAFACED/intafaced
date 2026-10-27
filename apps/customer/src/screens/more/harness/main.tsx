// Test harness only. Mounts the More screen with the real theme and providers but without the app shell. No API is used.
import '../../../shared/styles.css';
import '../../../features/public/public.css';
import '../../../app/redesign.css';
import '../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@intafaced/ui';
import { SessionProvider } from '../../../features/session/session';
import { navigate, useLocation } from '../../../app/location';
import More from '../index';

/** The app's own link handler (App.tsx followLink), so a tile click is a client-side move, as in the real app. */
function follow(event: MouseEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
}

function Page() {
  const here = useLocation();
  const [path = '/'] = here.split('?');
  return (
    <TooltipProvider>
      <div className="if-app" onClick={follow}>
        <nav data-testid="harness-bar" className="harness-bar" aria-label="Harness stand-in for the top bar">
          <a href="/home">intafaced</a>
          <a href="/home">Home</a>
          <a href="/money">Money</a>
          <a href="/trade">Trade</a>
          <a href="/pay">Pay</a>
          <a href="/more" aria-current={path === '/more' ? 'page' : undefined}>
            More
          </a>
          <span>harness stand-in for the top bar</span>
        </nav>
        <main id="main">
          {path === '/more' ? (
            <More path={path} search="" params={{}} />
          ) : (
            <p data-testid="standin" style={{ padding: 32 }}>
              Stand-in page {path}
            </p>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <Page />
    </SessionProvider>
  </StrictMode>,
);
