import { average, enumerateBuckets, resolveWindow } from './analytics.service';

describe('resolveWindow', () => {
  it('buckets a week by day', () => {
    const { granularity, from, to } = resolveWindow({ range: '7d' });
    expect(granularity).toBe('day');
    expect(to.getTime() - from.getTime()).toBeCloseTo(7 * 86_400_000, -4);
  });

  it('buckets today by hour, starting at midnight', () => {
    const { granularity, from } = resolveWindow({ range: 'today' });
    expect(granularity).toBe('hour');
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
  });

  it('picks hourly buckets for a short custom range and daily for a long one', () => {
    expect(
      resolveWindow({ range: 'custom', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }).granularity,
    ).toBe('hour');
    expect(
      resolveWindow({ range: 'custom', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }).granularity,
    ).toBe('day');
  });

  it('falls back to the default window when a custom range is nonsense', () => {
    // Reversed bounds would otherwise produce an empty or negative window.
    const reversed = resolveWindow({ range: 'custom', from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' });
    expect(reversed.granularity).toBe('day');
    expect(reversed.from.getTime()).toBeLessThan(reversed.to.getTime());

    const unparseable = resolveWindow({ range: 'custom', from: 'yesterday' });
    expect(unparseable.from.getTime()).toBeLessThan(unparseable.to.getTime());
  });
});

describe('enumerateBuckets', () => {
  it('emits every day in the window so quiet days are drawn, not skipped', () => {
    const buckets = enumerateBuckets(new Date(2026, 0, 1), new Date(2026, 0, 5), 'day');
    expect(buckets).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  });

  it('emits hourly labels for an hourly window', () => {
    const buckets = enumerateBuckets(new Date(2026, 0, 1, 9, 30), new Date(2026, 0, 1, 12, 0), 'hour');
    expect(buckets).toEqual(['2026-01-01 09:00', '2026-01-01 10:00', '2026-01-01 11:00']);
  });

  it('bounds a wildly wide range instead of generating an unbounded array', () => {
    const buckets = enumerateBuckets(new Date(1990, 0, 1), new Date(2030, 0, 1), 'day');
    expect(buckets.length).toBeLessThanOrEqual(400);
  });
});

describe('average', () => {
  it('rounds to one decimal', () => {
    expect(average([1, 2, 4])).toBe(2.3);
  });

  it('returns null for an empty sample rather than zero', () => {
    // Zero would read as "we answer instantly"; null lets the UI say there is no data yet.
    expect(average([])).toBeNull();
  });
});
