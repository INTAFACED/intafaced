/**
 * Spot and futures each have their own live flag.
 *
 * One operator token cannot flip a plane. The audit line names the operator
 * and a second, distinct confirming operator. The console waits 5 seconds
 * (`apps/admin` control-plane client); a write that does not finish in that
 * time leaves the previous flags for the next read.
 */

export const PLANE_FLAG_TIMEOUT_MS = 5_000;

export type TradingPlane = 'spot' | 'futures';

export interface PlaneAuditLine {
  readonly plane: TradingPlane;
  readonly enabled: boolean;
  readonly operatorId: string;
  readonly confirmOperatorId: string;
}

export interface PlaneFlags {
  readonly spot: boolean;
  readonly futures: boolean;
  readonly audit: readonly PlaneAuditLine[];
}

export interface PlaneFlagWriter {
  write(next: PlaneFlags): Promise<void>;
}

const noopWriter: PlaneFlagWriter = {
  async write() {},
};

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('plane flag write failed'));
      },
    );
  });
}

export class TradingPlanes {
  private spot = true;
  private futures = true;
  private readonly audit: PlaneAuditLine[] = [];

  constructor(
    private readonly writer: PlaneFlagWriter = noopWriter,
    private readonly timeoutMs = PLANE_FLAG_TIMEOUT_MS,
  ) {}

  read(): PlaneFlags {
    return { spot: this.spot, futures: this.futures, audit: [...this.audit] };
  }

  async turnOff(input: {
    readonly plane: TradingPlane;
    readonly operatorId: string;
    readonly confirmOperatorId?: string | null;
  }): Promise<{ ok: true } | { ok: false; code: 'missing_operator' | 'unknown' }> {
    const operatorId = input.operatorId.trim();
    const confirm = input.confirmOperatorId?.trim() ?? '';
    if (!operatorId || !confirm || confirm === operatorId) {
      return { ok: false, code: 'missing_operator' };
    }

    const line: PlaneAuditLine = {
      plane: input.plane,
      enabled: false,
      operatorId,
      confirmOperatorId: confirm,
    };
    const next: PlaneFlags = {
      spot: input.plane === 'spot' ? false : this.spot,
      futures: input.plane === 'futures' ? false : this.futures,
      audit: [...this.audit, line],
    };

    try {
      await withTimeout(this.writer.write(next), this.timeoutMs);
    } catch {
      return { ok: false, code: 'unknown' };
    }

    this.spot = next.spot;
    this.futures = next.futures;
    this.audit.push(line);
    return { ok: true };
  }
}
