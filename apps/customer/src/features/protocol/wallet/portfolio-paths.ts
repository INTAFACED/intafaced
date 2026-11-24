/** Every convention with its own page under /wallet/conventions/<id>. */
export const CONVENTIONS = ['pnl', 'drawdown', 'prices', 'entry', 'modes'] as const;
export type Convention = (typeof CONVENTIONS)[number];
export const conventionPath = (id: Convention) => `/wallet/conventions/${id}`;
