/**
 * File-backed fill confirm / manual fill / fill-assign journals — sibling JSONL next to the EMS ack log.
 *
 * Missing file is an honest empty journal: never invent a confirmation, print, or assignment.
 * Confirm/manual are first-write; assign trail is append-only (latest get() is last row).
 * Blank path refuses (named error) — tests inject in-memory.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireExecutionEmsStorePath } from './file-algo-store.js';
import { InMemoryFillAssignStore, type ChildFillAssignment, type FillAssignStore } from './oms-fill-assign.js';
import { InMemoryFillConfirmStore, type ChildFillConfirmation, type FillConfirmStore } from './oms-fill-confirm.js';
import { InMemoryManualFillStore, type ManualChildFill, type ManualFillStore } from './oms-manual-fill.js';

export function fillConfirmJournalPath(emsStorePath: string): string {
  return join(dirname(requireExecutionEmsStorePath(emsStorePath)), 'fill-confirms.jsonl');
}

export function manualFillJournalPath(emsStorePath: string): string {
  return join(dirname(requireExecutionEmsStorePath(emsStorePath)), 'manual-fills.jsonl');
}

export function fillAssignJournalPath(emsStorePath: string): string {
  return join(dirname(requireExecutionEmsStorePath(emsStorePath)), 'fill-assigns.jsonl');
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

function requireId(id: string | undefined, filePath: string, label: string): string {
  const trimmed = id?.trim() ?? '';
  if (!trimmed) {
    throw new Error(`${label} journal corrupt: missing clientOrderId (${filePath})`);
  }
  return trimmed;
}

export class FileFillConfirmStore implements FillConfirmStore {
  private readonly inner = new InMemoryFillConfirmStore();

  constructor(private readonly filePath: string) {
    requireExecutionEmsStorePath(filePath);
    ensureJournalDir(filePath);
    for (const line of readJsonlLines(filePath)) {
      const parsed = JSON.parse(line) as ChildFillConfirmation;
      const id = requireId(parsed.clientOrderId, filePath, 'fill confirm');
      const recorded = this.inner.confirm({
        clientOrderId: id,
        parentClientOrderId: parsed.parentClientOrderId,
        confirmerId: parsed.confirmerId,
        confirmedAt: parsed.confirmedAt,
      });
      if (!recorded && !this.inner.get(id)) {
        throw new Error(`fill confirm journal corrupt: confirm refused (${filePath})`);
      }
    }
  }

  get(clientOrderId: string): ChildFillConfirmation | null {
    return this.inner.get(clientOrderId);
  }

  confirm(row: ChildFillConfirmation): ChildFillConfirmation | null {
    const id = row.clientOrderId.trim();
    if (!id || this.inner.get(id)) return null;
    const recorded: ChildFillConfirmation = {
      clientOrderId: id,
      parentClientOrderId: row.parentClientOrderId,
      confirmerId: row.confirmerId,
      confirmedAt: row.confirmedAt,
    };
    appendJsonl(this.filePath, recorded);
    return this.inner.confirm(recorded);
  }
}

export class FileManualFillStore implements ManualFillStore {
  private readonly inner = new InMemoryManualFillStore();

  constructor(private readonly filePath: string) {
    requireExecutionEmsStorePath(filePath);
    ensureJournalDir(filePath);
    for (const line of readJsonlLines(filePath)) {
      const parsed = JSON.parse(line) as ManualChildFill;
      const id = requireId(parsed.clientOrderId, filePath, 'manual fill');
      const recorded = this.inner.record({
        clientOrderId: id,
        parentClientOrderId: parsed.parentClientOrderId,
        filledAmount: parsed.filledAmount,
        averagePrice: parsed.averagePrice,
        confirmerId: parsed.confirmerId,
        confirmedAt: parsed.confirmedAt,
      });
      if (!recorded && !this.inner.get(id)) {
        throw new Error(`manual fill journal corrupt: record refused (${filePath})`);
      }
    }
  }

  get(clientOrderId: string): ManualChildFill | null {
    return this.inner.get(clientOrderId);
  }

  record(row: ManualChildFill): ManualChildFill | null {
    const id = row.clientOrderId.trim();
    if (!id || this.inner.get(id)) return null;
    const recorded: ManualChildFill = {
      clientOrderId: id,
      parentClientOrderId: row.parentClientOrderId,
      filledAmount: row.filledAmount,
      averagePrice: row.averagePrice,
      confirmerId: row.confirmerId,
      confirmedAt: row.confirmedAt,
    };
    appendJsonl(this.filePath, recorded);
    return this.inner.record(recorded);
  }
}

export class FileFillAssignStore implements FillAssignStore {
  private readonly inner = new InMemoryFillAssignStore();

  constructor(private readonly filePath: string) {
    requireExecutionEmsStorePath(filePath);
    ensureJournalDir(filePath);
    for (const line of readJsonlLines(filePath)) {
      const parsed = JSON.parse(line) as ChildFillAssignment;
      const id = requireId(parsed.clientOrderId, filePath, 'fill assign');
      const row: ChildFillAssignment = {
        clientOrderId: id,
        parentClientOrderId: parsed.parentClientOrderId,
        accountTag: parsed.accountTag,
        filledAmount: parsed.filledAmount,
        averagePrice: parsed.averagePrice,
        operatorId: parsed.operatorId,
        recordedAt: parsed.recordedAt,
        kind: parsed.kind,
      };
      if (row.kind === 'assign') {
        const recorded = this.inner.assign(row);
        if (!recorded && !this.inner.get(id)) {
          throw new Error(`fill assign journal corrupt: assign refused (${filePath})`);
        }
      } else if (row.kind === 'correct') {
        this.inner.correct(row);
      } else {
        throw new Error(`fill assign journal corrupt: kind (${filePath})`);
      }
    }
  }

  get(clientOrderId: string): ChildFillAssignment | null {
    return this.inner.get(clientOrderId);
  }

  trail(clientOrderId: string): readonly ChildFillAssignment[] {
    return this.inner.trail(clientOrderId);
  }

  assign(row: ChildFillAssignment): ChildFillAssignment | null {
    const id = row.clientOrderId.trim();
    const existing = id ? this.inner.get(id) : null;
    if (!id || Boolean(existing?.accountTag.trim())) return null;
    const recorded: ChildFillAssignment = {
      clientOrderId: id,
      parentClientOrderId: row.parentClientOrderId,
      accountTag: row.accountTag,
      filledAmount: row.filledAmount,
      averagePrice: row.averagePrice,
      operatorId: row.operatorId,
      recordedAt: row.recordedAt,
      kind: 'assign',
    };
    appendJsonl(this.filePath, recorded);
    return this.inner.assign(recorded);
  }

  correct(row: ChildFillAssignment): ChildFillAssignment {
    const recorded = this.inner.correct(row);
    appendJsonl(this.filePath, recorded);
    return recorded;
  }
}
