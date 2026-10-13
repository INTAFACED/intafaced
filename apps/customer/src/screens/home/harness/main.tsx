// Test harness only. Mounts the Home screen without the app shell (B2 builds the real top bar).
import '../../../../../../packages/ui/node_modules/@fontsource-variable/inter/index.css';
import './harness-tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from '../../../features/session/session';
import Home from '../index';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <nav className="harness-bar" aria-label="Harness stand-in for the top bar">
        <a href="/home">intafaced</a>
        <a href="/home" aria-current="page">
          Home
        </a>
        <a href="/money">Money</a>
        <a href="/trade">Trade</a>
        <a href="/pay">Pay</a>
        <a href="/more">More</a>
        <span>harness stand-in for the top bar</span>
      </nav>
      <Home />
    </SessionProvider>
  </StrictMode>,
);
