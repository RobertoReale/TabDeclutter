/**
 * Shutdown-aware error reporting for background service worker listeners (docs/DECISIONS.md, F.2).
 *
 * When the browser is shutting down it rejects whichever extension API call happens to be in
 * flight (`Error: The browser is shutting down.`). Probing `storage.local` distinguishes a
 * browser teardown (where the store no longer answers at all) from a genuine extension failure
 * without coupling to browser-specific error messages.
 */

import { activityItem } from '@/platform/storage';

export async function reportBackgroundError(scope: string, error: unknown): Promise<void> {
  try {
    await activityItem.getValue();
  } catch {
    return;
  }
  console.error(`TabDeclutter: ${scope}`, error);
}
