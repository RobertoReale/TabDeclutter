/**
 * The 16 px icon a row shows for a page (PLAN.md §4.3, §4.5, §5.5).
 *
 * `faviconOf` decides between the browser's own cached icon and an avatar — and never the
 * network, invariant 1 — so this only draws the answer. Shared by the Declutter rows and
 * the Archive rows, which show the same thing about an open tab and about a closed one:
 * an archive entry keeps only a `data:` favicon (PLAN.md §5.5), and Chrome's favicon cache
 * still answers for a page whose tab has gone.
 */

import type { Favicon, FaviconTab } from '@/platform/favicon';
import { faviconOf } from '@/platform/favicon';

export function RowFavicon({ page }: { page: FaviconTab }) {
  const favicon: Favicon = faviconOf(page);

  if (favicon.kind === 'image') {
    // Decorative: the title beside it names the page, and an alt text repeating the
    // domain would be read twice. `loading="lazy"` keeps a long list cheap (§11).
    return <img class="td-favicon" src={favicon.src} alt="" loading="lazy" decoding="async" />;
  }

  return (
    <span
      class="td-favicon td-avatar"
      aria-hidden="true"
      // A custom property, so the hue is the only thing the component decides: the
      // saturation, the lightness and the contrast stay in the stylesheet (§4.8).
      style={`--td-avatar-hue: ${favicon.hue}`}
    >
      {favicon.initial}
    </span>
  );
}
