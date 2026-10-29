import type { RuleCondition, RuleGroup, RuleNode } from '@intafaced/contracts/campaigns-catalogue';

/**
 * Editing a campaign rule tree in the builder (CM-eligibility-rules-02, J-campaigns-16 #4). Pure: the tree is replaced,
 * never changed in place, and a place in it is a list of part indexes from the outer group (`[]` is the outer group).
 * The service checks the owner's depth and size limits; the builder only builds.
 */

export type Place = readonly number[];

/** A new condition: the account type, which every account has. The founder changes it before trying the rule. */
export const NEW_CONDITION: RuleCondition = { kind: 'condition', field: 'accountType', is: 'individual' };

export const emptyRule = (): RuleGroup => ({ kind: 'group', op: 'and', parts: [] });

/** The group at a place; the outer group when the place no longer names a group. */
export function groupAt(tree: RuleGroup, place: Place): RuleGroup {
  let node: RuleGroup = tree;
  for (const i of place) {
    const next = node.parts[i];
    if (!next || next.kind !== 'group') return tree;
    node = next;
  }
  return node;
}

/** The place itself while it names a group in the tree, else the outer group's. */
function groupPlace(tree: RuleGroup, place: Place): Place {
  let node: RuleGroup = tree;
  for (const i of place) {
    const next = node.parts[i];
    if (!next || next.kind !== 'group') return [];
    node = next;
  }
  return place;
}

/**
 * Where new parts go once the part at `removed` is gone: its parent group when the removed part held that place, the
 * same group one index earlier when an earlier sibling on its way was removed, else unchanged.
 */
export function placeAfterRemove(building: Place, removed: Place): Place {
  if (removed.length === 0 || building.length < removed.length) return building;
  const depth = removed.length - 1;
  for (let i = 0; i < depth; i += 1) if (building[i] !== removed[i]) return building;
  if (building[depth] === removed[depth]) return removed.slice(0, -1);
  if (building[depth]! > removed[depth]!) return [...building.slice(0, depth), building[depth]! - 1, ...building.slice(depth + 1)];
  return building;
}

function replaceAt(tree: RuleGroup, place: Place, make: (node: RuleNode) => RuleNode | null): RuleGroup {
  if (place.length === 0) return make(tree) as RuleGroup;
  const [head, ...rest] = place;
  const parts = tree.parts.flatMap((part, i): RuleNode[] => {
    if (i !== head) return [part];
    if (rest.length === 0) {
      const made = make(part);
      return made ? [made] : [];
    }
    return part.kind === 'group' ? [replaceAt(part, rest, make)] : [part];
  });
  return { ...tree, parts };
}

/**
 * Adds a group (with one condition, so it is never empty) inside the group at `wanted` (the outer group when the place no
 * longer names one); returns the new group's place.
 */
export function addGroup(tree: RuleGroup, wanted: Place, op: 'and' | 'or'): { tree: RuleGroup; place: Place } {
  const place = groupPlace(tree, wanted);
  const target = groupAt(tree, place);
  const at = [...place, target.parts.length];
  const next = replaceAt(tree, place, (node) => ({
    ...(node as RuleGroup),
    parts: [...(node as RuleGroup).parts, { kind: 'group', op, parts: [NEW_CONDITION] }],
  }));
  return { tree: next, place: at };
}

/** Adds a condition to the group at `place` (the outer group when the place no longer names one). */
export function addCondition(tree: RuleGroup, place: Place): RuleGroup {
  return replaceAt(tree, groupPlace(tree, place), (node) => ({
    ...(node as RuleGroup),
    parts: [...(node as RuleGroup).parts, NEW_CONDITION],
  }));
}

/** Replaces the condition at `place`. */
export function setCondition(tree: RuleGroup, place: Place, condition: RuleCondition): RuleGroup {
  return replaceAt(tree, place, () => condition);
}

/** Flips the group at `place` between all (AND) and any (OR). */
export function setOp(tree: RuleGroup, place: Place, op: 'and' | 'or'): RuleGroup {
  return replaceAt(tree, place, (node) => ({ ...(node as RuleGroup), op }));
}

/** Removes the part at `place` (never the outer group). */
export function removeAt(tree: RuleGroup, place: Place): RuleGroup {
  return place.length === 0 ? tree : replaceAt(tree, place, () => null);
}

/** A place as the service names it in a try's failing list: `2.1` is the first part of the outer group's second part. */
export const placeName = (place: Place) => place.map((i) => i + 1).join('.');

const TIER: Record<string, string> = { none: 'not verified', basic: 'basic', full: 'full', institutional: 'institutional' };

/** A condition in words. */
export function conditionText(c: RuleCondition): string {
  switch (c.field) {
    case 'accountType':
      return `Account type is ${c.is === 'individual' ? 'individual' : 'business'}`;
    case 'region':
      return `Region is ${c.test === 'in' ? '' : 'not '}one of ${c.regions.join(', ')}`;
    case 'kycTier':
      return `Verification is at least ${TIER[c.atLeast] ?? c.atLeast}`;
    case 'status':
      return `Account status is ${c.is}`;
  }
}
