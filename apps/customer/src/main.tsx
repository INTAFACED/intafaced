import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './features/session/session';
import './shared/styles.css';
import './app/redesign.css';
import './app/shell.css';
import { App } from './app/App';
import { applyLook } from './app/look';

applyLook();
const element = document.getElementById('root');
if (!element) throw new Error('Customer root element is missing');
createRoot(element).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
