/**
 * TEST SUPPORT. The shared fake svc-ledger service-to-service door
 * (`@intafaced/ledger-client/testing/ledger-door`) with this service's
 * signature verifier plugged in. See that file for what it enforces.
 */
import { fakeLedgerDoor as sharedFakeLedgerDoor, type DoorCall } from '@intafaced/ledger-client/testing/ledger-door';
import { verifyServiceHeaders } from '@intafaced/contracts';
import type { MemoryLedger } from '@intafaced/ledger-client';

export type { DoorCall };

export function fakeLedgerDoor(ledger: MemoryLedger, secret: string, calls: DoorCall[] = []): typeof fetch {
  return sharedFakeLedgerDoor(ledger, secret, verifyServiceHeaders, calls);
}
