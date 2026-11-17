import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Invariant 7 (TASKS.md §2): tab titles and URLs are untrusted input, and both
 * stores reject remote code. `dangerouslySetInnerHTML` is caught as a JSX
 * attribute and as an object property, which `no-restricted-properties` alone
 * would miss.
 */
const untrustedHtmlRules = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-restricted-properties': [
    'error',
    {
      property: 'innerHTML',
      message: 'Invariant 7: titles and URLs are untrusted input. Use textContent or JSX.',
    },
    {
      property: 'outerHTML',
      message: 'Invariant 7: titles and URLs are untrusted input. Use textContent or JSX.',
    },
    {
      property: 'dangerouslySetInnerHTML',
      message: 'Invariant 7: titles and URLs are untrusted input. Render them as text.',
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
      message: 'Invariant 7: titles and URLs are untrusted input. Render them as text.',
    },
    {
      selector: 'Property[key.name="dangerouslySetInnerHTML"]',
      message: 'Invariant 7: titles and URLs are untrusted input. Render them as text.',
    },
  ],
};

/**
 * Invariant 11 (TASKS.md §2): every visible string goes through i18n. A lint rule and
 * not a test, because the thing being forbidden is a shape of source code rather than a
 * behaviour, and the author is told where it is as they write it (M6.4, docs/DECISIONS.md).
 *
 * Two shapes carry text to the user from the source itself: a text node between tags, and
 * a literal in one of the attributes a browser or a screen reader reads out. `alt=""` is
 * deliberate and stays legal, and anything computed (`title={tab.url}`) is not a literal.
 * `label` is missing from the list on purpose: our own fields take a `MessageKey` under
 * that name, so its literals are keys, not text.
 */
const visibleText =
  'alt|title|placeholder|aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext';

const i18nRules = [
  {
    selector: 'JSXText[value=/[A-Za-z]/]',
    message: "Invariant 11: visible strings go through i18n. Render {t('key')} instead.",
  },
  {
    selector: `JSXAttribute[name.name=/^(${visibleText})$/] > Literal[value=/[A-Za-z]/]`,
    message: "Invariant 11: visible strings go through i18n. Pass t('key') instead.",
  },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      '.output/',
      '.wxt/',
      '.analysis/',
      'coverage/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
      '.phasekit/',
      'stats*.html',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      ...untrustedHtmlRules,
      // Invariant 5: the browser APIs live behind src/platform/. Application
      // code asks capabilities.ts and never names a browser.
      'no-restricted-globals': [
        'error',
        {
          name: 'chrome',
          message: 'Invariant 5: use the wrappers in src/platform/, never chrome.* directly.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Invariant 4: src/core/ stays pure TypeScript, so it is tested in full and
    // shared between the background and the panel.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: 'Invariant 4: src/core/ is pure TypeScript, no browser API.' },
        { name: 'browser', message: 'Invariant 4: src/core/ is pure TypeScript, no browser API.' },
      ],
    },
  },

  {
    // Invariant 11, on the only files that render anything. The invariant-7 selectors
    // come along because a second `no-restricted-syntax` for the same file replaces the
    // first one's options rather than adding to them.
    files: ['src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...untrustedHtmlRules['no-restricted-syntax'].slice(1),
        ...i18nRules,
      ],
    },
  },

  {
    // src/platform/ is the one place allowed to touch chrome.* behind feature
    // detection (PLAN.md §5.5).
    files: ['src/platform/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
);
