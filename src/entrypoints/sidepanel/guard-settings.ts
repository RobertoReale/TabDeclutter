/**
 * The shape of the duplicate-protection UI: the chip's text (PLAN.md §4.2), the option rows of
 * the "Protezione duplicati" sub-page (§8.3), which of them the running browser has at all
 * (§5.5) and the warnings the current values deserve (§8.6).
 *
 * Everything here is data and pure functions, so the views are only markup and the rules the
 * spec states — defaults, hidden options, warnings — are tested without a DOM.
 *
 * Relative imports, not `@/`: the `unit` vitest project runs without WXT's plugin and so without
 * WXT's alias, and this module is tested there.
 */
import type { PatternErrorCode } from '../../core/patterns';
import type {
  GuardAfterAction,
  GuardKeepWhich,
  GuardMode,
  GuardScope,
  GuardSettings,
  MatchOptions,
  Settings,
} from '../../core/types';
import type { Capabilities } from '../../platform/capabilities';
import type { MessageKey, Translate } from '../../platform/i18n';
import { formatCount, pluralRules, timeText } from './format';

/** The keys of `T` that hold a boolean, which are exactly the ones a checkbox can drive. */
type BooleanKeys<T> = { [K in keyof T]-?: T[K] extends boolean ? K : never }[keyof T];

export type GuardToggleId = BooleanKeys<GuardSettings>;
export type MatchToggleId = BooleanKeys<MatchOptions>;

export interface Choice<V extends string> {
  readonly value: V;
  readonly label: MessageKey;
}

export interface Toggle<Id extends string> {
  readonly id: Id;
  readonly label: MessageKey;
  /**
   * The capability without which the option does not exist here. §5.5: an option the browser
   * cannot honour is hidden, not shown disabled — a dead switch is worse than no switch.
   */
  readonly needs?: keyof Capabilities;
}

/** §8.3, "Behaviour". The default is chosen in onboarding, so no value is marked here. */
export const MODE_CHOICES: readonly Choice<GuardMode>[] = [
  { value: 'off', label: 'guardModeOff' },
  { value: 'warn', label: 'guardModeWarn' },
  { value: 'auto', label: 'guardModeAuto' },
];

export const AFTER_CHOICES: readonly Choice<GuardAfterAction>[] = [
  { value: 'none', label: 'guardAfterNone' },
  { value: 'activate', label: 'guardAfterActivate' },
  { value: 'move-activate', label: 'guardAfterMoveActivate' },
];

export const SCOPE_CHOICES: readonly Choice<GuardScope>[] = [
  { value: 'window', label: 'guardScopeWindow' },
  { value: 'all-windows', label: 'guardScopeAllWindows' },
];

/** §8.3, "Priority and exclusions": which tab stays. */
export const KEEP_CHOICES: readonly Choice<GuardKeepWhich>[] = [
  { value: 'oldest', label: 'guardKeepOldest' },
  { value: 'newest', label: 'guardKeepNewest' },
  { value: 'oldest-reloaded', label: 'guardKeepOldestReloaded' },
];

/**
 * The rest of "Priority and exclusions", in the spec's order.
 *
 * "Duplicate tab" rides on `duplicateCommandDetection` and containers on `containers`: the app
 * asks what the browser can do and never what it is called (TASKS.md §2.5).
 */
export const GUARD_TOGGLES: readonly Toggle<GuardToggleId>[] = [
  { id: 'preferHttps', label: 'guardPreferHttps' },
  { id: 'keepPinned', label: 'guardKeepPinned' },
  { id: 'keepActive', label: 'guardKeepActive' },
  { id: 'preferActiveWindow', label: 'guardPreferActiveWindow' },
  { id: 'ignoreEmptyTabs', label: 'guardIgnoreEmptyTabs' },
  { id: 'ignoreAuthPages', label: 'guardIgnoreAuthPages' },
  {
    id: 'allowIntentionalDuplicates',
    label: 'guardAllowIntentional',
    needs: 'duplicateCommandDetection',
  },
  { id: 'containersAreSeparate', label: 'guardContainersSeparate', needs: 'containers' },
];

/** §8.3, "URL comparison". Shared with Declutter, which is why the group says so. */
export const MATCH_TOGGLES: readonly Toggle<MatchToggleId>[] = [
  { id: 'ignoreCase', label: 'matchIgnoreCase' },
  { id: 'ignoreWww', label: 'matchIgnoreWww' },
  { id: 'ignoreHash', label: 'matchIgnoreHash' },
  { id: 'ignoreTrackingParams', label: 'matchIgnoreTracking' },
  { id: 'ignoreAllParams', label: 'matchIgnoreAllParams' },
  { id: 'ignorePath', label: 'matchIgnorePath' },
];

/** The options this browser has. */
export function visibleGuardToggles(capabilities: Capabilities): readonly Toggle<GuardToggleId>[] {
  return GUARD_TOGGLES.filter((row) => row.needs === undefined || capabilities[row.needs]);
}

/**
 * §8.6: the warnings the chosen values earn, in the order they are shown.
 *
 * They depend on the values rather than sitting permanently under their options, because a
 * caution that is always on screen is read as decoration.
 */
export function guardWarnings(settings: Pick<Settings, 'guard' | 'match'>): readonly MessageKey[] {
  const warnings: MessageKey[] = [];
  if (settings.guard.keep === 'newest') warnings.push('guardWarnNewest');
  if (settings.match.ignorePath) warnings.push('guardWarnIgnorePath');
  return warnings;
}

/** Why a whitelist line was ignored, in the user's language. */
const PATTERN_ERRORS: Readonly<Record<PatternErrorCode, MessageKey>> = {
  'too-long': 'whitelistErrorTooLong',
  'too-many-wildcards': 'whitelistErrorTooManyWildcards',
  'invalid-regex': 'whitelistErrorInvalidRegex',
};

export function patternErrorText(code: PatternErrorCode, t: Translate): string {
  return t(PATTERN_ERRORS[code]);
}

/** The state the chip reads from. */
export interface GuardStatus {
  readonly mode: GuardMode;
  /** ms epoch, from `storage.session`; absent when the guard is not paused. */
  readonly pausedUntil?: number;
}

/**
 * A pause further out than this is "fino al riavvio".
 *
 * "Until restart" is stored as a deadline a year away rather than as a flag of its own
 * (docs/DECISIONS.md M3b.2), so the chip tells the two apart by distance: no pause a person
 * picks from the menu is a day long.
 */
export const PAUSE_UNTIL_RESTART_FROM_MS = 24 * 60 * 60 * 1000;

/** When the pause ends, or `null` if the guard is not paused. */
export function pausedUntil(status: GuardStatus, now: number): number | null {
  const until = status.pausedUntil;
  if (until === undefined || until <= now) return null;
  return until;
}

/** §4.2: "ON", "Solo avvisi", "In pausa fino alle 15:40", "In pausa fino al riavvio", "OFF". */
export function guardStateText(
  status: GuardStatus,
  now: number,
  t: Translate,
  language: string,
): string {
  const until = pausedUntil(status, now);
  if (until !== null) {
    if (until - now > PAUSE_UNTIL_RESTART_FROM_MS) return t('guardStatePausedRestart');
    return t('guardStatePausedUntil', timeText(until, language));
  }
  if (status.mode === 'auto') return t('guardStateAuto');
  if (status.mode === 'warn') return t('guardStateWarn');
  return t('guardStateOff');
}

/** The whole chip: "Duplicati: ON". */
export function guardChipText(
  status: GuardStatus,
  now: number,
  t: Translate,
  language: string,
): string {
  return t('guardChip', guardStateText(status, now, t, language));
}

/** The plural form `value` takes, with only `one` and `other` distinguished (see `format.ts`). */
function counted(
  value: number,
  one: MessageKey,
  other: MessageKey,
  t: Translate,
  language: string,
): string {
  const key = pluralRules(language).select(value) === 'one' ? one : other;
  return t(key, formatCount(value, language));
}

/** §4.2's counter under the chip: "1 duplicato chiuso oggi". */
export function closedTodayText(count: number, t: Translate, language: string): string {
  return counted(count, 'guardClosedTodayOne', 'guardClosedTodayOther', t, language);
}

/** §8.3's per-line preview: "Corrisponde a 3 schede aperte". */
export function matchesText(count: number, t: Translate, language: string): string {
  if (count === 0) return t('whitelistMatchesNone');
  return counted(count, 'whitelistMatchesOne', 'whitelistMatchesOther', t, language);
}
