/** Reads an approval from the identity service with the contract schema. Server code only (see restrictions-parse.ts). */
import { actionApprovalSchema, type ActionApproval } from '@intafaced/contracts';

export function parseApproval(raw: unknown): ActionApproval | null {
  const r = actionApprovalSchema.safeParse(raw);
  return r.success ? r.data : null;
}
