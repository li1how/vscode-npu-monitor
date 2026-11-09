import type { MonitorNode } from './nodes.js';

export function contextSelection<T extends MonitorNode>(
  selection: readonly MonitorNode[],
  node: MonitorNode | undefined,
  matches: (item: MonitorNode) => item is T,
  key: (item: T) => string,
): T[] {
  const selected = selection.filter(matches);
  return node && matches(node) && !selected.some(item => key(item) === key(node)) ? [node] : selected;
}

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map(item => [key(item), item])).values()];
}
