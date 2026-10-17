import { createContext, useContext, type ReactNode } from 'react';

/**
 * A review surface is anywhere a merchant reads an amount before confirming it. Inside one, money shows its exact
 * value with no toggle, whatever page opened it. Lists, tiles, cards and charts never sit inside this scope.
 */
const ExactMoneyScopeContext = createContext(false);

export function ExactMoneyScope({ children }: { children: ReactNode }) {
  return <ExactMoneyScopeContext.Provider value={true}>{children}</ExactMoneyScopeContext.Provider>;
}

/** True inside a review surface, where `MoneyDisplay` renders the exact amount. */
export function useExactMoneyScope(): boolean {
  return useContext(ExactMoneyScopeContext);
}
