/**
 * Time units and small numeric helpers.
 *
 * `src/core/` is pure TypeScript: no browser API, no ambient clock (TASKS.md §2.4).
 * Durations are milliseconds, the unit every extension API uses.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Constrains `value` to the inclusive range [`min`, `max`].
 *
 * When the range is inverted (`min > max`) the result is `max`, so it is always
 * one of the two bounds and never silently drifts outside them.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
