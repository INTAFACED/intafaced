/**
 * ops.admin fleet compose wiring — required BFF shared-secret pass-through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function adminComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'admin');
}

export function adminBffSecretComposeWired(): boolean {
  const block = adminComposeBlock();
  return /ADMIN_BFF_SHARED_SECRET/.test(block);
}
