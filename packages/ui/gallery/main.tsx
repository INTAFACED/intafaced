/** Entry of the kit gallery (`pnpm --filter @intafaced/ui gallery`). Dev tool only: it is never part of the package build. */
import { createRoot } from 'react-dom/client';
import { Gallery } from '../src/components/__gallery__/Gallery.js';
import './gallery.css';
import '../src/brand/brand.css';

createRoot(document.getElementById('root')!).render(<Gallery />);
