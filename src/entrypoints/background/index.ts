// Listeners are registered synchronously at the top level, because Chrome's
// service worker is torn down after about 30 s of inactivity (TASKS.md §2.6)
// and Firefox only allows `sidebarAction.toggle()` inside the user gesture.
import { registerPanelOpening } from '@/platform/panel';

import { registerBadge } from './badge';
import { registerCleanup } from './cleanup';
import { registerGuard } from './guard';
import { registerMenus } from './menus';
import { registerTracker } from './tracker';

export default defineBackground(() => {
  registerPanelOpening();
  registerTracker();
  const badge = registerBadge();
  registerCleanup();
  registerMenus();
  // The flash of PLAN.md §8.5 is the badge's; the guard is handed it so it does not have to
  // know there is a badge at all.
  registerGuard({ flash: badge.flash });
});
