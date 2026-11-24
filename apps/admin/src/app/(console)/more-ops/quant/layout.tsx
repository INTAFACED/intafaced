import type { ReactNode } from 'react';
import '@/app/kit.css';

/**
 * The quant desk is drawn with the trade desk's frame (DeskPage) and the shared UI kit, whose Tailwind styles load from
 * app/kit.css, as the trade desk's do; without it the halt desk rendered as unstyled tables and browser-default controls.
 * Scoped to `.if-app`, as the trade desk's layout does, so the console's own look elsewhere is unchanged.
 */
export default function QuantLayout({ children }: { children: ReactNode }) {
  return <div className="if-app min-h-[calc(100vh-64px)] bg-bg text-fg">{children}</div>;
}
