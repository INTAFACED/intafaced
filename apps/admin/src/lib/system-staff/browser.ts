/** Browser re-reads for the staff screens. Same-origin BFF only; every answer is parsed again with the contract schemas. */
import { readRolesView, readRosterView, readStaffMemberView, type RolesView, type RosterView, type StaffMemberView } from './model';

async function read<T>(query: string, parse: (raw: unknown) => T | null): Promise<T | null> {
  try {
    const res = await fetch(`/api/system/staff?${query}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    return null;
  }
}

export function fetchRoster(cursor?: string): Promise<RosterView | null> {
  return read(`view=roster${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, readRosterView);
}

export function fetchStaffMember(staffId: string): Promise<StaffMemberView | null> {
  return read(`view=member&staffId=${encodeURIComponent(staffId)}`, readStaffMemberView);
}

export function fetchRoles(): Promise<RolesView | null> {
  return read('view=roles', readRolesView);
}
