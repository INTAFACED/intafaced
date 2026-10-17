export const USER_ID: string;
export function createPortalMock(
  scenario?: string,
  options?: { now?: number; myAccess?: string; role?: string },
): {
  calls: { procedure: string; method: string; input: any }[];
  state: Record<string, any>;
  handle(route: unknown): Promise<unknown>;
  install(page: unknown): Promise<void>;
};
