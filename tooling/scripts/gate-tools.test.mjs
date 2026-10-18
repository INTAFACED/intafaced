/**
 * One entry point for the merge-gate tools' unit tests (merge-gate, gate-file-guard, gate-gh), plus the
 * services-map generator tests, so a generator change that brings back wrong "required env" rows is red.
 * Run: node --test tooling/scripts/gate-tools.test.mjs    (also: pnpm test:gate-tools)
 * Importing a node:test file registers its tests, so this file is just the list.
 */
import './gate-file-guard.test.mjs';
import './merge-gate.test.mjs';
import './services-map.test.mjs';
