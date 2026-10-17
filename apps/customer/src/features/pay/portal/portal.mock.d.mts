export const USER_ID: string;
export const OWNER_SCOPES: string[];
export const OWNER_SCOPES_WITH_MONEY: string[];
export function accessTokenFor(scopes?: string[]): string;
export function createPortalMock(
  scenario?: string,
  options?: { now?: number; myAccess?: string; role?: string },
): {
  calls: { procedure: string; method: string; input: any }[];
  unmounted: string[];
  state: Record<string, any>;
  world: any;
  handle(route: unknown): Promise<unknown>;
  install(page: unknown): Promise<void>;
};
