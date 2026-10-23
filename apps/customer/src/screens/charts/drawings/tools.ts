/**
 * The drawing toolbar's tools and their groups. A tool is either a cursor (select, eraser), a drawing kind, or a pattern
 * variant (a pattern is one kind with a variant). Groups follow the instrument groups the desk's own toolbar copies:
 * cursors, lines, channels and Fibonacci, Gann, patterns, positions, measure, shapes, brush and text.
 */
import type { DrawingKind, PatternVariant } from './model';

export type CursorTool = 'cursor' | 'dot' | 'arrow' | 'eraser';
export type ToolId = CursorTool | DrawingKind | 'pattern-abcd' | 'pattern-xabcd';

export interface ToolGroup {
  id: string;
  tools: readonly ToolId[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: 'cursors', tools: ['cursor', 'dot', 'arrow', 'eraser'] },
  { id: 'lines', tools: ['horizontal', 'ray', 'vertical', 'cross', 'trend', 'info'] },
  { id: 'channels', tools: ['channel', 'pitchfork', 'fib', 'fibExtension'] },
  { id: 'gann', tools: ['gannFan', 'gannBox'] },
  { id: 'patterns', tools: ['pattern-abcd', 'pattern-xabcd'] },
  { id: 'positions', tools: ['long', 'short'] },
  { id: 'measure', tools: ['measure'] },
  { id: 'shapes', tools: ['rectangle', 'ellipse'] },
  { id: 'brush', tools: ['brush'] },
  { id: 'annotation', tools: ['text'] },
];

export const isCursorTool = (tool: ToolId): tool is CursorTool =>
  tool === 'cursor' || tool === 'dot' || tool === 'arrow' || tool === 'eraser';

/** The drawing kind and pattern variant a tool places. Cursor tools place nothing. */
export function toolKind(tool: ToolId): { kind: DrawingKind; variant?: PatternVariant } | null {
  if (isCursorTool(tool)) return null;
  if (tool === 'pattern-abcd') return { kind: 'pattern', variant: 'abcd' };
  if (tool === 'pattern-xabcd') return { kind: 'pattern', variant: 'xabcd' };
  return { kind: tool };
}
