export const USER_ID: string;
export const TEST_TOTP_CODE: string;
export const OWNER_SCOPES: string[];
export const OWNER_SCOPES_WITH_MONEY: string[];
export function accessTokenFor(scopes?: string[]): string;
export function createPortalMock(
  scenario?: string,
  options?: { now?: number; myAccess?: string; role?: string; stepUp?: 'ok' | 'role' | 'keys' },
): {
  calls: { procedure: string; method: string; input: any; bearer?: string | null }[];
  unmounted: string[];
  state: Record<string, any>;
  stepUp: { minted: { token: string; scopes: string[]; expiresAt: number; merchantId: string }[]; expireAll(): void };
  world: any;
  handle(route: unknown): Promise<unknown>;
  install(page: unknown): Promise<void>;
};
