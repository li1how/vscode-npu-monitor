import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_BUCKET_MS } from '../../src/npu/history.js';
import { renderIdleHistory } from '../../src/ui/idleHistory.js';
import { resetVscodeMock } from '../mocks/vscode.js';

beforeEach(() => resetVscodeMock());

describe('idle history chart', () => {
  it('shows the newest day section first while keeping each day chronological', () => {
    const now = Math.floor(Date.UTC(2026, 8, 23, 12) / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
    const html = renderIdleHistory({ alias: 'alpha', retentionDays: 3, cards: [] }, now);
    const dayStart = now - (3 * 24 * 60 * 60 * 1000 - HISTORY_BUCKET_MS);
    const headings = [...html.matchAll(/<section><h2>(.*?)<\/h2>/g)].map(match => match[1]);
    expect(headings).toHaveLength(3);
    for (let day = 0; day < 3; day += 1) {
      const start = dayStart + (2 - day) * 24 * 60 * 60 * 1000;
      expect(headings[day]).toContain(new Date(start).toLocaleString());
    }
  });

  it('renders each card, observed states, unknown gaps and a restrictive CSP', () => {
    const now = Math.floor(Date.UTC(2026, 8, 23, 12) / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
    const html = renderIdleHistory({
      alias: '<alpha>', retentionDays: 1,
      cards: [{ id: '0', state: 'idle', observedAt: now, idleSince: now - 60000,
        bins: [[now - HISTORY_BUCKET_MS, 'busy'], [now, 'idle']] }],
    }, now, 'nonce');
    expect(html).toContain('Idle history: &lt;alpha&gt;');
    expect(html).toContain('NPU 0');
    expect(html).toContain('class="cell busy"');
    expect(html).toContain('class="cell idle"');
    expect(html).toContain('class="cell unknown"');
    expect(html).toContain("default-src 'none'; style-src 'nonce-nonce'");
    expect(html).not.toContain('<script');
  });
});
