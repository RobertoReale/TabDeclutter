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

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      '.output/',
      '.wxt/',
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
    // src/platform/ is the one place allowed to touch chrome.* behind feature
    // detection (PLAN.md §5.5).
    files: ['src/platform/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
);
