import type { TRPCError } from '@intafaced/contracts';

/**
 * One folder's refusals: each code (`bank.*`, or a named blocker such as `rail.bank`) with what a caller is told
 * for it. Declaring a code here IS deciding its status (rule 2 in `router/errors.ts`), so no code exists without it.
 */
export type BankErrorTable = Readonly<Record<`${string}.${string}`, TRPCError['code']>>;
