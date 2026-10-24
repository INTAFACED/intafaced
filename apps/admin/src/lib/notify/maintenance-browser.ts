/** Browser hop for the maintenance desk. Same-origin BFF only; changes go through the incident desk's change hop. */
import type { MaintenanceDeskView } from './maintenance-model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchMaintenanceDesk(): Promise<MaintenanceDeskView | null> {
  try {
    const res = await fetch('/api/notify-maintenance', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.windows) && isRecord(body.approvals)
      ? (body as unknown as MaintenanceDeskView)
      : null;
  } catch {
    return null;
  }
}
