/** Types for features.mjs, which TypeScript tests import to read a feature's declared tracker status. */
export type DeclaredStatus = 'done' | 'wip' | 'ready' | 'socket';

export interface Feature {
  id: string;
  title: string;
  module: string;
  phase: string;
  plane: string;
  status: DeclaredStatus;
  dependsOn: string[];
  owner: string | null;
  note: string | null;
  /** Services or packages that must exist on disk for `done` to be credible. */
  requires: string[];
}

export const FEATURES: Feature[];
