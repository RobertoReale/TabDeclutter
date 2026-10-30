import { describe, expect, it } from 'vitest';

import { clamp, DAY, HOUR, MINUTE } from '../../src/core/time';

describe('time units', () => {
  it('expresses every unit in milliseconds', () => {
    expect(MINUTE).toBe(60_000);
    expect(HOUR).toBe(3_600_000);
    expect(DAY).toBe(86_400_000);
  });

  it('keeps the units consistent with each other', () => {
    expect(HOUR).toBe(60 * MINUTE);
    expect(DAY).toBe(24 * HOUR);
  });
});

describe('clamp', () => {
  it('leaves a value inside the range untouched', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('returns the bounds for a value outside the range', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('includes both bounds', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('works with negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(0, -10, -1)).toBe(-1);
  });

  it('collapses to the single value when min equals max', () => {
    expect(clamp(7, 3, 3)).toBe(3);
  });

  it('returns max when the range is inverted', () => {
    expect(clamp(5, 10, 0)).toBe(0);
  });
});
