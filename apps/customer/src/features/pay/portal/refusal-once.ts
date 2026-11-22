import { createContext } from 'react';

/** One page says each refusal once: the first failure to draw a given title and text keeps it, the rest draw nothing. */
export type Once = { claim: (key: string, owner: string) => boolean; release: (key: string, owner: string) => void };
export const RefusalOnce = createContext<Once | null>(null);
