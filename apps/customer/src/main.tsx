import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './features/session/session';
import './shared/tokens.css';
import './shared/styles.css';
import { App } from './app/App';

const element = document.getElementById('root');
if (!element) throw new Error('Customer root element is missing');
createRoot(element).render(<StrictMode><SessionProvider><App /></SessionProvider></StrictMode>);
