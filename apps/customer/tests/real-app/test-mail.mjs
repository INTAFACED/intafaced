import { existsSync, readFileSync } from 'node:fs';
import { stackFile } from './stack.mjs';

/**
 * The LOCAL-TEST lines the stack's TEST email stand-in wrote (svc-notify test-outbox.ts, on while a journey restarts notify
 * with LOCAL_STACK_NOTIFY_EMAIL=on), oldest first; empty while it has written none. The file outlives a run on a kept
 * stack, so a journey reads only the lines for its own address.
 */
export function mailbox() {
  const file = stackFile('notify-mail-outbox.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST '))
    .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)));
}
