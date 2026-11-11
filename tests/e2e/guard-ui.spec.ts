import type { Page } from '@playwright/test';

import type { Locale, MessageKey } from '../../src/platform/i18n';
import { expect, message, test } from './fixtures/extension';

/**
 * The duplicate protection's interface in the real browser (PLAN.md §4.2, §8.3): the chip
 * says what the protection is doing, its menu changes the mode, and the whitelist editor
 * validates what is typed, previews how many open tabs each pattern matches and saves it.
 *
 * Both halves end at `storage.local`, which is the only thing the panel does to change the
 * guard: §5.2 forbids it to message the background, so a mode the chip claims and a mode
 * the background would read are the same fact only if it was written down.
 */

/** The chip's "Duplicates: <state>", as `guard-settings.ts` builds it. */
function chipText(locale: Locale, state: MessageKey): string {
  return message(locale, 'guardChip').replace('$1', message(locale, state));
}

/** §8.3's "matches 3 open tabs", plural as the panel picks it. */
function matchesText(locale: Locale, count: number): string {
  if (count === 0) return message(locale, 'whitelistMatchesNone');
  const key: MessageKey =
    new Intl.PluralRules(locale).select(count) === 'one'
      ? 'whitelistMatchesOne'
      : 'whitelistMatchesOther';
  return message(locale, key).replace('$1', new Intl.NumberFormat(locale).format(count));
}

/** "Line 2 ignored, not a valid regular expression". */
function ignoredText(locale: Locale, reason: MessageKey): string {
  return message(locale, 'whitelistIgnored').replace('$1', message(locale, reason));
}

/** The slice of the extension API this spec asks the panel page for. */
interface GuardApi {
  tabs: { query(query: Record<string, unknown>): Promise<{ url?: string }[]> };
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
}

/** `local:settings`, read from the browser rather than inferred from the screen. */
async function storedMode(panel: Page): Promise<string> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const stored = await api.storage.local.get('settings');
    const settings = stored.settings as { guard?: { mode?: string } } | undefined;
    return settings?.guard?.mode ?? '';
  });
}

/** `local:duplicateWhitelist`, the list the guard compiles. */
async function storedWhitelist(panel: Page): Promise<string[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const stored = await api.storage.local.get('duplicateWhitelist');
    return (stored.duplicateWhitelist as string[] | undefined) ?? [];
  });
}

/**
 * How many tabs are open on `about:blank` right now.
 *
 * Counted from the browser, not written out: the preview's whole claim is that it agrees
 * with what is open, and a hard-coded number would only pin how many tabs the fixture
 * happens to leave behind.
 */
async function blankTabs(panel: Page): Promise<number> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    return (await api.tabs.query({})).filter((tab) => tab.url === 'about:blank').length;
  });
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('§4.2: the chip says what the protection does, and its menu changes it', async ({
    panel,
  }) => {
    const chip = panel.locator('.td-guard-chip');

    // The default is "Solo avvisi" (TASKS.md §2.2: nothing closes until the user has said so),
    // and it is a fallback rather than a written value — nothing is in `local:settings` until
    // the user changes something, which is also what makes the write below the user's choice.
    await expect(chip).toContainText(chipText('en', 'guardStateWarn'));
    expect(await storedMode(panel), 'the default is a fallback, not a stored value').toBe('');

    const menu = panel.getByRole('menu', { name: message('en', 'guardMenuLabel') });
    await expect(menu).toHaveCount(0);
    await chip.click();

    // Three modes, one choice: the state the chip shows is the one marked in the menu.
    const modes = menu.getByRole('menuitemradio');
    await expect(modes).toHaveText([
      message('en', 'guardModeOff'),
      message('en', 'guardModeWarn'),
      message('en', 'guardModeAuto'),
    ]);
    await expect(modes.nth(1)).toHaveAttribute('aria-checked', 'true');

    await modes.nth(2).click();

    // The menu closes on the choice, the chip says the new state, and — the part that
    // matters to the background — `local:settings` holds it (§5.2).
    await expect(menu).toHaveCount(0);
    await expect(chip).toContainText(chipText('en', 'guardStateAuto'));
    await expect.poll(async () => storedMode(panel)).toBe('auto');

    // And the choice survives a reopening of the menu, because it was read back from
    // storage rather than remembered by the chip.
    await chip.click();
    await expect(menu.getByRole('menuitemradio').nth(2)).toHaveAttribute('aria-checked', 'true');

    // Escape dismisses it, which is the only way to leave it with the keyboard.
    await panel.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('§4.2: the menu opens the duplicate settings, where the whitelist is saved', async ({
    panel,
  }) => {
    await panel.locator('.td-guard-chip').click();
    await panel.getByRole('menuitem', { name: message('en', 'guardMenuSettings') }).click();

    // §8.3's sub-page, reached from the chip and not only from the gear.
    await expect(
      panel.getByRole('heading', { name: message('en', 'settingsDuplicates') }),
    ).toBeVisible();
    // The note about Duplicate Tabs Closer is always there: coexistence cannot be detected.
    await expect(panel.locator('.td-note')).toHaveText(message('en', 'guardCoexistence'));

    const editor = panel.locator('#td-whitelist');
    await expect(editor).toHaveValue('');
    expect(await storedWhitelist(panel)).toEqual([]);

    const open = await blankTabs(panel);
    expect(open, 'the fixture leaves at least one about:blank tab open').toBeGreaterThan(0);

    /*
     * A pattern that matches something, a blank line, a pattern that matches nothing and a
     * regular expression that does not compile. The validation is live: nothing has been
     * saved yet at this point.
     */
    await editor.fill('about:blank\n\nhttps://nothing.test/*\n/[unclosed/');

    const lines = panel.locator('.td-pattern-line');
    // The blank line is not a pattern, so it gets no line of its own — but it is still
    // counted, which is why the bad regular expression is "Line 4".
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText(message('en', 'whitelistLine').replace('$1', '1'));
    await expect(lines.nth(0)).toContainText(matchesText('en', open));
    await expect(lines.nth(1)).toContainText(matchesText('en', 0));
    await expect(lines.nth(2)).toContainText(message('en', 'whitelistLine').replace('$1', '4'));
    await expect(lines.nth(2)).toContainText(ignoredText('en', 'whitelistErrorInvalidRegex'));
    await expect(lines.nth(2)).toHaveClass(/td-pattern-bad/);
    expect(await storedWhitelist(panel), 'typing is not saving').toEqual([]);

    // "Salva" is the gesture that saves: a half-typed pattern is not a choice yet. The bad
    // line is stored with the rest — it is ignored when the list is compiled, never fatal.
    await panel.getByRole('button', { name: message('en', 'whitelistSave') }).click();
    await expect
      .poll(async () => storedWhitelist(panel))
      .toEqual(['about:blank', 'https://nothing.test/*', '/[unclosed/']);

    // Saved, so there is nothing left to save.
    await expect(
      panel.getByRole('button', { name: message('en', 'whitelistSave') }),
    ).toBeDisabled();

    // §8.3's import: an extension cannot read another extension's storage, so the button
    // explains how to paste instead of pretending to read it.
    const how = message('en', 'whitelistImportHow');
    await expect(panel.getByText(how)).toHaveCount(0);
    await panel.getByRole('button', { name: message('en', 'whitelistImport') }).click();
    await expect(panel.getByText(how)).toBeVisible();
  });
});

test.describe('in Italian', () => {
  test.use({ uiLanguage: 'it' });

  test('§4.2: the chip and its menu are localized', async ({ panel }) => {
    const chip = panel.locator('.td-guard-chip');
    await expect(chip).toContainText(chipText('it', 'guardStateWarn'));

    await chip.click();
    await expect(
      panel
        .getByRole('menu', { name: message('it', 'guardMenuLabel') })
        .getByRole('menuitem', { name: message('it', 'guardMenuSettings') }),
    ).toBeVisible();
  });
});
