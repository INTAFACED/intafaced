/**
 * The sync group's study commands. A study added to one chart of a colour group goes to every chart in it. Each request
 * has a nonce, and each grid slot keeps the nonce it has applied (or counts as applied). A chart whose studies bar is not
 * mounted when a command fires still owes it, and applies it when it mounts. A chart that joins a group after a command
 * was issued counts that command as applied at once, so it never replays a command from before it joined.
 */
import type { Group } from './grid';
import type { StudyKind } from './studies/catalogue';

export interface GroupCommand {
  kind: StudyKind;
  /** New for each request, so a request is applied once per chart. */
  nonce: number;
}

export type GroupCommands = Partial<Record<Group, GroupCommand>>;

/** The nonce a chart counts as applied when it joins `group`: the group's current command, or 0 when it has none. */
export function joinedNonce(commands: GroupCommands, group: Group | null): number {
  return group === null ? 0 : (commands[group]?.nonce ?? 0);
}

/** The command a chart still owes: the group's command when its nonce is newer than the one the chart applied. */
export function pendingCommand(command: GroupCommand | null | undefined, applied: number): GroupCommand | null {
  return command && command.nonce > applied ? command : null;
}
