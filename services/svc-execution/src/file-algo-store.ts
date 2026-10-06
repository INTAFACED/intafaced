/**
 * File-backed algo parent + pause journals — sibling JSONL next to the EMS ack log.
 *
 * Missing file is an honest empty journal: never invent a live parent, never invent a pause.
 * Last write per key wins. Blank path refuses (named error) — tests inject in-memory.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InMemoryAlgoPauseStore, type AlgoPauseIds, type AlgoPauseKey, type AlgoPauseStore } from './oms-pause.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type ApprovedAlgoParentStore } from './oms-start.js';

export const EXECUTION_ALGO_STORE_PATH_UNSET = 'execution.algo_store_path_unset' as const;

export class ExecutionAlgoStorePathUnsetError extends Error {
  readonly code = EXECUTION_ALGO_STORE_PATH_UNSET;

  constructor() {
    super('EXECUTION_EMS_STORE_PATH is unset — refusing in-memory algo parents, pauses, and fills');
    this.name = 'ExecutionAlgoStorePathUnsetError';
  }
}

export function requireExecutionEmsStorePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new ExecutionAlgoStorePathUnsetError();
  return trimmed;
}

export function algoParentJournalPath(emsStorePath: string): string {
  return join(dirname(requireExecutionEmsStorePath(emsStorePath)), 'algo-parents.jsonl');
}

export function algoPauseJournalPath(emsStorePath: string): string {
  return join(dirname(requireExecutionEmsStorePath(emsStorePath)), 'algo-pauses.jsonl');
}

function ensureJournalDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonlLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function appendJsonl(filePath: string, value: unknown): void {
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export class FileApprovedAlgoParentStore implements ApprovedAlgoParentStore {
  private readonly inner = new InMemoryApprovedAlgoParentStore();

  constructor(private readonly filePath: string) {
    requireExecutionEmsStorePath(filePath);
    ensureJournalDir(filePath);
    for (const line of readJsonlLines(filePath)) {
      const parsed = JSON.parse(line) as ApprovedAlgoParent;
      const id = parsed.parentClientOrderId?.trim() ?? '';
      if (!id) {
        throw new Error(`algo parent journal corrupt: missing parentClientOrderId (${filePath})`);
      }
      this.inner.seed(parsed);
    }
  }

  private commit(parentClientOrderId: string, apply: () => ApprovedAlgoParent | null): ApprovedAlgoParent | null {
    const previous = this.inner.get(parentClientOrderId);
    const row = apply();
    if (!row) return null;
    try {
      appendJsonl(this.filePath, row);
    } catch (err) {
      this.inner.restore(parentClientOrderId, previous);
      throw err;
    }
    return row;
  }

  get(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.inner.get(parentClientOrderId);
  }

  list(): readonly ApprovedAlgoParent[] {
    return this.inner.list();
  }

  approve(parent: ApprovedAlgoParent): ApprovedAlgoParent {
    return this.commit(parent.parentClientOrderId, () => this.inner.approve(parent)) as ApprovedAlgoParent;
  }

  start(parentClientOrderId: string, startedAt: string, operatorId?: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.start(parentClientOrderId, startedAt, operatorId));
  }

  stop(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.stop(parentClientOrderId));
  }

  kill(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.kill(parentClientOrderId));
  }

  undeploy(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.undeploy(parentClientOrderId));
  }

  expire(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.expire(parentClientOrderId));
  }

  releaseResidual(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.releaseResidual(parentClientOrderId));
  }

  consumeResidual(parentClientOrderId: string, remaining: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.consumeResidual(parentClientOrderId, remaining));
  }

  paper(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.paper(parentClientOrderId));
  }

  promote(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.promote(parentClientOrderId));
  }

  stage(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.stage(parentClientOrderId, operatorId));
  }

  release(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.release(parentClientOrderId, operatorId));
  }

  abandon(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.abandon(parentClientOrderId, operatorId));
  }

  claim(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.claim(parentClientOrderId, operatorId));
  }

  unclaim(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.unclaim(parentClientOrderId, operatorId));
  }

  offerPass(parentClientOrderId: string, fromOperatorId: string, toOperatorId: string, expireAt: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () =>
      this.inner.offerPass(parentClientOrderId, fromOperatorId, toOperatorId, expireAt),
    );
  }

  acceptPass(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.acceptPass(parentClientOrderId, operatorId));
  }

  rejectPass(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.rejectPass(parentClientOrderId, operatorId));
  }

  timeoutPass(parentClientOrderId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.timeoutPass(parentClientOrderId));
  }

  shift(parentClientOrderId: string, fromOperatorId: string, toOperatorId: string): ApprovedAlgoParent | null {
    return this.commit(parentClientOrderId, () => this.inner.shift(parentClientOrderId, fromOperatorId, toOperatorId));
  }
}

type StoredPauseLine = {
  readonly kind: AlgoPauseKey['kind'];
  readonly id: string;
  readonly paused: boolean;
};

export class FileAlgoPauseStore implements AlgoPauseStore {
  private readonly inner = new InMemoryAlgoPauseStore();

  constructor(private readonly filePath: string) {
    requireExecutionEmsStorePath(filePath);
    ensureJournalDir(filePath);
    for (const line of readJsonlLines(filePath)) {
      const parsed = JSON.parse(line) as StoredPauseLine;
      if (parsed.kind !== 'parent' && parsed.kind !== 'group') {
        throw new Error(`algo pause journal corrupt: kind (${filePath})`);
      }
      const id = parsed.id?.trim() ?? '';
      if (!id) {
        throw new Error(`algo pause journal corrupt: missing id (${filePath})`);
      }
      const key: AlgoPauseKey = { kind: parsed.kind, id };
      if (parsed.paused) this.inner.pause(key);
      else this.inner.resume(key);
    }
  }

  pause(key: AlgoPauseKey): boolean {
    const newlyPaused = this.inner.pause(key);
    if (newlyPaused) appendJsonl(this.filePath, { kind: key.kind, id: key.id, paused: true } satisfies StoredPauseLine);
    return newlyPaused;
  }

  resume(key: AlgoPauseKey): boolean {
    const resumed = this.inner.resume(key);
    if (resumed) appendJsonl(this.filePath, { kind: key.kind, id: key.id, paused: false } satisfies StoredPauseLine);
    return resumed;
  }

  isPaused(ids: AlgoPauseIds): boolean {
    return this.inner.isPaused(ids);
  }
}
