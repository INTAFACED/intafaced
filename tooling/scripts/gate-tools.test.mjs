/**
 * One entry point for the gate tools' unit tests (gate-file-guard, gate-gh).
 * Run: node --test tooling/scripts/gate-tools.test.mjs    (also: pnpm test:gate-tools)
 * Importing a node:test file registers its tests, so this file is just the list.
 */
import './gate-file-guard.test.mjs';
