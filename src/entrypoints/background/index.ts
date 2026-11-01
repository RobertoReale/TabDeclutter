// Listeners are registered synchronously at the top level, because Chrome's
// service worker is torn down after about 30 s of inactivity (TASKS.md §2.6)
// and Firefox only allows `sidebarAction.toggle()` inside the user gesture.
// The guard, the badge and the menus arrive with M2 and later.
import { registerPanelOpening } from '@/platform/panel';

import { registerTracker } from './tracker';

export default defineBackground(() => {
  registerPanelOpening();
  registerTracker();
});
