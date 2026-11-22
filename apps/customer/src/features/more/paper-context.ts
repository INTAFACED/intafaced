import { createContext, useContext } from 'react';

/** True inside a More room opened with `?simulated=true` (MC-order-01, ORD-002): `useAction` sends nothing there. */
export const PaperMode = createContext(false);
export const usePaperMode = () => useContext(PaperMode);
