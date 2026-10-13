import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './features/session/session';
import './shared/tokens.css';
import './shared/styles.css';
// TODO(B1): also import '@intafaced/ui/theme.css' here once packages/ui exports it (UI-SPEC 2.1).
import './app/shell.css';
import { App } from './app/App';

const element = document.getElementById('root');
if (!element) throw new Error('Customer root element is missing');
createRoot(element).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
