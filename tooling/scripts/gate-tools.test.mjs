/**
 * One entry point for the gate tools' unit tests (gate-file-guard, s2s-scan).
 * Run: node --test tooling/scripts/gate-tools.test.mjs    (also: pnpm test:gate-tools)
 * Importing a node:test file registers its tests, so this file is just the list. CI and `pnpm verify` run these files
 * through tooling-tests.mjs, which runs every .test.mjs file under tooling/ (it skips this entry, so nothing runs twice).
 */
import './gate-file-guard.test.mjs';
import './s2s-scan.test.mjs';
