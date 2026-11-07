// Listeners are registered synchronously at the top level, because Chrome's
// service worker is torn down after about 30 s of inactivity (TASKS.md §2.6)
// and Firefox only allows `sidebarAction.toggle()` inside the user gesture.
// The guard arrives with M3b.2.
import { registerPanelOpening } from '@/platform/panel';

import { registerBadge } from './badge';
import { registerCleanup } from './cleanup';
import { registerMenus } from './menus';
import { registerTracker } from './tracker';

export default defineBackground(() => {
  registerPanelOpening();
  registerTracker();
  registerBadge();
  registerCleanup();
  registerMenus();
});
