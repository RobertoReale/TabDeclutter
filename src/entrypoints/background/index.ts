// Listeners are registered synchronously at the top level, because Chrome's
// service worker is torn down after about 30 s of inactivity (TASKS.md §2.6)
// and Firefox only allows `sidebarAction.toggle()` inside the user gesture.
// The tracker, the guard, the badge and the menus arrive with M1 and later.
import { registerPanelOpening } from '@/platform/panel';

export default defineBackground(() => {
  registerPanelOpening();
});
