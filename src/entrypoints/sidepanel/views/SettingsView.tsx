/**
 * The settings, as the gear of PLAN.md §4.2 opens them.
 *
 * Only "Protezione duplicati" (§8.3) exists so far — the rest of the settings is M6.1 — so the
 * shell shows that sub-page itself instead of a list of one. When the other sub-pages arrive
 * this is where they are chosen between, which is why the gear leads here and not straight at
 * `DuplicateSettingsView`.
 */

import { DuplicateSettingsView } from './DuplicateSettingsView';

export function SettingsView({ language }: { language: string }) {
  return <DuplicateSettingsView language={language} />;
}
