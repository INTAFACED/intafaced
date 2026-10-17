export const NOT_MINE: unique symbol;
export function mockContext(
  scenario: string,
  now: number,
  options?: { myAccess?: string; role?: string },
): { scenario: string; now: number; role: string; state: Record<string, unknown> };
export function refuse(route: unknown, status: number, code: string, message?: string): Promise<unknown>;
export function createSettingsBMock(ctx: ReturnType<typeof mockContext>): {
  handle(
    procedure: string,
    input: Record<string, unknown>,
    route: { fulfill(r: { status?: number; body: string }): Promise<void> | void },
  ): Promise<unknown>;
};
