/**
 * DMA broker / desk / shift products (PTX-M01-R06/R07, M20).
 *
 * Named products only. Creating one without owner-set hierarchy law refuses.
 * Does not invent a broker tree. Existing org roles stay (admin / trader /
 * auditor / risk-manager). Uses existing organizations — never mints a home org.
 */
import type { Sql } from 'postgres';
import { assertOrgActor } from './org-service.js';

export const DMA_HIERARCHY_PRODUCTS = ['dma-broker', 'desk', 'shift'] as const;
export type DmaHierarchyProduct = (typeof DMA_HIERARCHY_PRODUCTS)[number];

export type DmaHierarchyLaw = { readonly published: false } | { readonly published: true };

/** Production default — no invent. */
export const UNPUBLISHED_DMA_HIERARCHY_LAW: DmaHierarchyLaw = { published: false };

export const DMA_HIERARCHY_LAW_RESIDUAL =
  'PTX-M01-R06/R07 DMA broker / desk / shift hierarchy is owner-set — refuse-closed until owner law exists (never invent a broker tree)';

export type DmaHierarchyRefuseCode =
  | 'identity.dma.kind_required'
  | 'identity.dma.kind_invalid'
  | 'identity.dma.law_invalid'
  | 'identity.dma.hierarchy_law_unset'
  | 'identity.dma.tree_unbuilt';

export class DmaHierarchyRefuseError extends Error {
  constructor(
    message: string,
    readonly code: DmaHierarchyRefuseCode,
    readonly residual: string,
  ) {
    super(message);
    this.name = 'DmaHierarchyRefuseError';
  }
}

export function requireDmaHierarchyProduct(value: string | null | undefined): DmaHierarchyProduct {
  if (value === null || value === undefined) {
    throw new DmaHierarchyRefuseError('DMA product kind is required', 'identity.dma.kind_required', DMA_HIERARCHY_LAW_RESIDUAL);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DmaHierarchyRefuseError('DMA product kind is required', 'identity.dma.kind_required', DMA_HIERARCHY_LAW_RESIDUAL);
  }
  const kind = value.trim();
  if (kind === 'dma-broker' || kind === 'desk' || kind === 'shift') {
    return kind;
  }
  throw new DmaHierarchyRefuseError('DMA product kind is invalid', 'identity.dma.kind_invalid', DMA_HIERARCHY_LAW_RESIDUAL);
}

function hasInventedTree(obj: Record<string, unknown>): boolean {
  const keys = ['tree', 'brokers', 'desks', 'shifts', 'nodes', 'children', 'parent'];
  return keys.some((k) => k in obj);
}

/**
 * Parse owner-published DMA hierarchy law from env JSON.
 * Empty / whitespace → unpublished. A broker tree in the JSON is refused
 * (this module does not accept an invented tree). Malformed → throw (fail boot).
 *
 * Shape:
 *   { "published": false }
 *   { "published": true }
 */
export function parseDmaHierarchyLawJson(raw: string | null | undefined): DmaHierarchyLaw {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_DMA_HIERARCHY_LAW;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DmaHierarchyRefuseError(
      'IDENTITY_DMA_HIERARCHY_LAW_JSON is not valid JSON',
      'identity.dma.law_invalid',
      DMA_HIERARCHY_LAW_RESIDUAL,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DmaHierarchyRefuseError(
      'IDENTITY_DMA_HIERARCHY_LAW_JSON must be an object',
      'identity.dma.law_invalid',
      DMA_HIERARCHY_LAW_RESIDUAL,
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (hasInventedTree(obj)) {
    throw new DmaHierarchyRefuseError(
      'IDENTITY_DMA_HIERARCHY_LAW_JSON must not carry a broker tree',
      'identity.dma.tree_unbuilt',
      DMA_HIERARCHY_LAW_RESIDUAL,
    );
  }
  if (obj.published === false) return UNPUBLISHED_DMA_HIERARCHY_LAW;
  if (obj.published !== true) {
    throw new DmaHierarchyRefuseError(
      'IDENTITY_DMA_HIERARCHY_LAW_JSON.published must be true or false',
      'identity.dma.law_invalid',
      DMA_HIERARCHY_LAW_RESIDUAL,
    );
  }
  return { published: true };
}

export function dmaHierarchyLawIsPublished(law: DmaHierarchyLaw): boolean {
  return law.published === true;
}

export function dmaHierarchyLawStatusLine(law: DmaHierarchyLaw): string {
  return law.published ? 'published=1 tree=0' : 'published=0 tree=0';
}

export type CreateDmaHierarchyProductInput = {
  readonly sql: Sql;
  readonly actorUserId: string | null | undefined;
  readonly orgId: string | null | undefined;
  readonly kind: string | null | undefined;
  readonly law: DmaHierarchyLaw;
};

/**
 * Create a named DMA product on an existing org.
 * Unpublished law → typed refuse. With the law published the org acts as that product; broker client links,
 * schedules and allocations live in `broker-clients.ts` (RC-identity-09). Nothing is persisted here.
 */
export async function createDmaHierarchyProduct(
  input: CreateDmaHierarchyProductInput,
): Promise<{ orgId: string; kind: DmaHierarchyProduct }> {
  const kind = requireDmaHierarchyProduct(input.kind);
  const seat = await assertOrgActor(input.sql, input.actorUserId, input.orgId);
  if (!input.law.published) {
    throw new DmaHierarchyRefuseError(
      `Creating ${kind} is refuse-closed until owner-set DMA hierarchy law exists`,
      'identity.dma.hierarchy_law_unset',
      DMA_HIERARCHY_LAW_RESIDUAL,
    );
  }
  return { orgId: seat.orgId, kind };
}
