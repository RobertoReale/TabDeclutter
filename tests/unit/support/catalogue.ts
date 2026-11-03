/**
 * `t` over the shipped catalogues, for the tests that are about wording.
 *
 * The panel's text helpers take `t` as an argument precisely so they can be checked
 * against the real `src/public/_locales/` without an extension around them: what
 * the user will read is what comes out of these tests, not a mock.
 *
 * This is the `unit` project, so there is no `browser` and no WXT alias — the catalogues
 * are read off the disk and the substitution `i18n.getMessage` does is reproduced here.
 */

import { readFileSync } from 'node:fs';

import type { Translate } from '../../../src/platform/i18n';
import { translator } from '../../../src/platform/i18n';

export interface Message {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

export function catalogue(locale: string): Record<string, Message> {
  const path = new URL(`../../../src/public/_locales/${locale}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Message>;
}

/** `i18n.getMessage`'s substitution, over one locale's real messages. */
export function localeTranslator(locale: string): Translate {
  const messages = catalogue(locale);
  return translator({
    getMessage(key: string, subs: string[] = []): string {
      const entry = messages[key];
      if (entry === undefined) return '';
      let text = entry.message;
      for (const [name, { content }] of Object.entries(entry.placeholders ?? {})) {
        const index = /^\$([1-9])$/.exec(content)?.[1];
        const value = index === undefined ? content : (subs[Number(index) - 1] ?? '');
        text = text.replaceAll(`$${name.toUpperCase()}$`, value);
      }
      return text.replace(/\$([1-9])/g, (_, at: string) => subs[Number(at) - 1] ?? '');
    },
  });
}
