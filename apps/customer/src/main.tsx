import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './features/session/session';
import './shared/styles.css';
import './app/redesign.css';
import './app/shell.css';
import './app/lit-look-styles';
import { App } from './app/App';
import { LitLookRoot, applyLookSurfaces } from './app/LitLookRoot';

// Volt is the only look: index.html's root carries data-look="lit" from the first byte. Before the first paint, so a
// person who chose Solid surfaces never sees a frame of glass.
applyLookSurfaces();
const element = document.getElementById('root');
if (!element) throw new Error('Customer root element is missing');
createRoot(element).render(
  <StrictMode>
    <LitLookRoot />
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
