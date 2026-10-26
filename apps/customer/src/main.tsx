import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './features/session/session';
import './shared/styles.css';
import './app/redesign.css';
import './app/shell.css';
import './app/lit-look-styles';
import { App } from './app/App';
import { applyLook } from './app/look';
import { LitLookRoot, applyLookSurfaces } from './app/LitLookRoot';

const look = applyLook();
// Before the first paint, so a person who chose Solid surfaces never sees a frame of glass.
if (look === 'lit') applyLookSurfaces();
const element = document.getElementById('root');
if (!element) throw new Error('Customer root element is missing');
createRoot(element).render(
  <StrictMode>
    {look === 'lit' ? <LitLookRoot /> : null}
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
