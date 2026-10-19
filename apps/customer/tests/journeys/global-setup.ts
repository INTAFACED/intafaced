import type { TestProject } from 'vitest/node';
import { founderSession, founders, type Claims } from './identity';

declare module 'vitest' {
  export interface ProvidedContext {
    operators: [Claims, Claims];
  }
}

/** Sign the two throwaway founders in once for the whole run (their TOTP steps are single-use) and hand the sessions to the journeys. */
export default async function setup(project: TestProject) {
  const [a, b] = founders();
  project.provide('operators', [await founderSession(a), await founderSession(b)]);
}
