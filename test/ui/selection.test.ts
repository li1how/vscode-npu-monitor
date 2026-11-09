import { describe, expect, it } from 'vitest';

import { HostNode, StatusNode, type MonitorNode } from '../../src/ui/nodes.js';
import { contextSelection, uniqueBy } from '../../src/ui/selection.js';
import { makeHost, makeRecord } from '../helpers/fixtures.js';

const host = (alias: string): HostNode => new HostNode(makeRecord({ host: makeHost({ alias }) }));
const isHost = (node: MonitorNode): node is HostNode => node instanceof HostNode;
const alias = (node: HostNode): string => node.record.host.alias;

describe('context selections', () => {
  it('keeps the selection when its context target has the same identity, and filters other node types', () => {
    const first = host('alpha');
    const second = host('beta');
    expect(contextSelection([first, new StatusNode('status'), second], host('alpha'), isHost, alias))
      .toEqual([first, second]);
  });

  it('uses an outside context target alone and ignores a context target of another type', () => {
    const selected = host('alpha');
    const clicked = host('beta');
    expect(contextSelection([selected], clicked, isHost, alias)).toEqual([clicked]);
    expect(contextSelection([selected], new StatusNode('status'), isHost, alias)).toEqual([selected]);
    expect(contextSelection([], undefined, isHost, alias)).toEqual([]);
  });

  it('keeps the first position and last value for repeated identities', () => {
    const first = host('alpha');
    const second = host('beta');
    const latest = host('alpha');
    expect(uniqueBy([first, second, latest], alias)).toEqual([latest, second]);
  });
});
