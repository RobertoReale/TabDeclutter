import { beforeAll, expect, test } from 'vitest';

import { openPanel, panelState } from './fixtures/panel';

/**
 * That the panel follows the system theme on Firefox, with no switch of its own
 * (PLAN.md §4.7, §14).
 *
 * Chromium's `tests/e2e/shell.spec.ts` asks Playwright for `colorScheme`. Puppeteer has no
 * equivalent for Firefox and BiDi has nothing like CDP's `emulateMediaFeatures`, so the
 * scheme is forced the way Firefox itself stores it: `ui.systemUsesDarkTheme` is the system
 * theme the browser believes it is running under, and
 * `layout.css.prefers-color-scheme.content-override` is what content is told — 0 dark,
 * 1 light, 2 follow the system
 * (https://searchfox.org/mozilla-central/source/modules/libpref/init/StaticPrefList.yaml,
 * `layout.css.prefers-color-scheme.content-override`).
 *
 * Both schemes are measured, in a browser each, and both are forced: the point is that the
 * panel *follows* the system, which a single dark reading would not show, and a machine in
 * dark mode must not make the light one pass by accident.
 *
 * The assertions are on WCAG luminance rather than on hex values, as Chromium's are, so the
 * palette can be retuned without rewriting the test. What must not change is which of the
 * two is the light one.
 *
 * This is why §14's "dark theme" manual check needs no Firefox entry
 * (see `docs/TEST-COVERAGE.md`).
 */

interface Reading {
  /** What the document's own `matchMedia` says, which is what the CSS keys off. */
  readonly prefersDark: boolean;
  readonly background: string;
  readonly text: string;
  readonly errors: readonly string[];
}

/** The relative luminance of a `rgb(...)`, as WCAG defines it. */
function luminance(colour: string): number {
  const channels = [...colour.matchAll(/\d+(?:\.\d+)?/g)].slice(0, 3).map((match) => {
    const value = Number(match[0]) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A panel in a Firefox told the system theme is `dark`, read and then shut down. */
async function readPanel(dark: boolean): Promise<Reading> {
  const session = await openPanel({
    prefs: {
      'ui.systemUsesDarkTheme': dark ? 1 : 0,
      'layout.css.prefers-color-scheme.content-override': dark ? 0 : 1,
    },
  });
  try {
    // The panel rendered, so the stylesheet that carries the theme is applied.
    await panelState(session.page);
    const colours = await session.page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return {
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        background: style.getPropertyValue('background-color'),
        text: style.getPropertyValue('color'),
      };
    });
    return { ...colours, errors: session.errors.take() };
  } finally {
    await session.close();
  }
}

let dark: Reading;
let light: Reading;

beforeAll(async () => {
  // One browser at a time: each `openPanel` installs the extension into a fresh profile.
  dark = await readPanel(true);
  light = await readPanel(false);
});

test('a dark system theme reaches the panel as prefers-color-scheme: dark', () => {
  expect(dark.prefersDark).toBe(true);
  expect(light.prefersDark).toBe(false);
});

test('the panel is dark on a dark system, light text on a dark surface', () => {
  expect(luminance(dark.background)).toBeLessThan(0.1);
  expect(luminance(dark.text)).toBeGreaterThan(0.6);
});

test('the panel is light on a light system, dark text on a light surface', () => {
  expect(luminance(light.background)).toBeGreaterThan(0.8);
  expect(luminance(light.text)).toBeLessThan(0.1);
});

test('the extension logged no errors in either theme', () => {
  expect(dark.errors).toEqual([]);
  expect(light.errors).toEqual([]);
});
