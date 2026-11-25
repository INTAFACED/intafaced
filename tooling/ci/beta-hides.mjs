#!/usr/bin/env node
// Which of the given customer-app paths the hosted beta hides, by the rule the beta is built with: apps/customer/vite.config.ts
// betaVoltDefine gives the beta `betaRoomList(beta-screens.json rooms, rooms)` (the rooms Order 1's journey steps showed), and the app hides a path when `betaHides` says so
// (apps/customer/src/app/beta-volt.ts), as it does a room a switched-off feature holds (feature-registry.ts betaHidden).
// Read here through the same files, so the beta and this check share one rule.
// tooling/ci/journey-verdict.mjs runs it to name the steps whose screens no tester can open (`notOnBeta`). The beta shows only
// Order 1's screens (project-state decision PR #4049, Nino approves "the Order 1 screens the beta shows. Everything else waits until after Phantom's first wave."), so the list is what the hosted beta serves, and a step is proven only where a tester reaches it
// there (project-state decision PR #4016). A step whose screen is not on the list is still named, until a newer report is read.
// Needs @intafaced/contracts and @intafaced/i18n built (the route table imports them), as the verdict job does.
//   node tooling/ci/beta-hides.mjs < paths.json   prints { "hidden": [...the given paths it hides], "rooms": n, "hiddenRooms": n }
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const paths = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw new Error('stdin must be a JSON list of paths');
const { rooms: shown } = JSON.parse(readFileSync(new URL('../../apps/customer/src/app/beta-screens.json', import.meta.url), 'utf8'));
const { betaRoomList, betaHides } = await tsImport('../../apps/customer/src/app/beta-volt.ts', import.meta.url);
const { rooms } = await tsImport('../../apps/customer/src/app/navigation.ts', import.meta.url);
const { betaOffFeatureFor } = await tsImport('../../apps/customer/src/app/feature-registry.ts', import.meta.url);
const list = betaRoomList(shown, rooms);
// An empty list would hide nothing and pass every step: the beta's rooms and the route table are never empty, so it is an error.
if (!list.length) throw new Error('the beta room list is empty');
// The beta's build defines this list (vite.config.ts betaVoltDefine); feature-registry's betaOffFeatureFor reads it to know
// it runs in the beta. A room the beta switches off (a `blocked` feature) is hidden from every account; one that needs
// something of the account (a business account, the venue door) is counted as shown, since the beta shows it to an account
// that has it.
globalThis.__BETA_VOLT_ROOMS__ = list;
const EVERY_NEED = { business: true, venue: true, staking: true, vaults: true };
const hidden = paths.filter((path) => betaHides(path, list) || betaOffFeatureFor(path, EVERY_NEED) !== undefined);
process.stdout.write(`${JSON.stringify({ hidden, rooms: list.length, hiddenRooms: list.filter(([, on]) => !on).length })}\n`);
