// The look gate's TEST account, written in plain JavaScript for the gate (tooling/ci/look-gate): the parts the recording uses.
declare module '*/look-gate/fixture-answer.mjs' {
  export function fixtureAnswer(
    href: string,
    method: string,
    body: string,
    options: { signedIn: boolean; now: number },
  ): { status: number; json: unknown } | null;
  export const SIGNED_OUT: string[];
  export const VIEW: Record<string, unknown>;
}
