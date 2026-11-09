import { describe, expect, it } from 'vitest';

import { isNpuObservationCurrent, npuMaxAgeMs } from '../../src/npu/freshness.js';

describe('NPU observation freshness', () => {
  const settings = { pollIntervalSeconds: 180 };
  const collectedAt = 1000;

  it('expires observations only after twice the polling interval', () => {
    expect(npuMaxAgeMs(settings)).toBe(360000);
    expect(isNpuObservationCurrent(collectedAt, settings, collectedAt)).toBe(true);
    expect(isNpuObservationCurrent(collectedAt, settings, collectedAt + 360000)).toBe(true);
    expect(isNpuObservationCurrent(collectedAt, settings, collectedAt + 360001)).toBe(false);
  });

  it('rejects observations from the future and follows polling interval changes', () => {
    expect(isNpuObservationCurrent(collectedAt, settings, collectedAt - 1)).toBe(false);
    expect(isNpuObservationCurrent(collectedAt, { pollIntervalSeconds: 10 }, collectedAt + 20001)).toBe(false);
  });
});
