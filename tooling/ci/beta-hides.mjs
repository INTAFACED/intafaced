#!/usr/bin/env node
// Which of the given customer-app paths the hosted beta hides, by the rule the beta is built with: apps/customer/vite.config.ts
// betaVoltDefine gives the beta `betaRoomList(voltCount().rooms, rooms)`, and the app hides a path when `betaHides` says so
// (apps/customer/src/app/beta-volt.ts). Read here through the same three files, so the beta and this check share one rule.
// tooling/ci/journey-verdict.mjs runs it to name the steps whose screens no tester can open (`notOnBeta`).
// Needs @intafaced/contracts and @intafaced/i18n built (the route table imports them), as the verdict job does.
//   node tooling/ci/beta-hides.mjs < paths.json   prints { "hidden": [...the given paths it hides], "rooms": n, "hiddenRooms": n }
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const paths = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw new Error('stdin must be a JSON list of paths');
const { voltCount } = await tsImport('../../apps/customer/src/app/volt-count.ts', import.meta.url);
const { betaRoomList, betaHides } = await tsImport('../../apps/customer/src/app/beta-volt.ts', import.meta.url);
const { rooms } = await tsImport('../../apps/customer/src/app/navigation.ts', import.meta.url);
const list = betaRoomList(voltCount().rooms, rooms);
// An empty list would hide nothing and pass every step: the count and the route table are never empty, so it is an error.
if (!list.length) throw new Error('the beta room list is empty');
const hidden = paths.filter((path) => betaHides(path, list));
process.stdout.write(`${JSON.stringify({ hidden, rooms: list.length, hiddenRooms: list.filter(([, volt]) => !volt).length })}\n`);
