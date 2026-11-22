// Listeners are registered synchronously at the top level, because Chrome's
// service worker is torn down after about 30 s of inactivity (TASKS.md §2.6)
// and Firefox only allows `sidebarAction.toggle()` inside the user gesture.
import { registerPanelOpening } from '@/platform/panel';

import { registerAutopilot } from './autopilot';
import { registerBadge } from './badge';
import { registerCleanup } from './cleanup';
import { registerCommands } from './commands';
import { registerGuard } from './guard';
import { registerMenus } from './menus';
import { registerTracker } from './tracker';

export default defineBackground({
  // ESM background keeps dynamic `import('@/platform/llm')` and `import('@/core/ai-grouping')`
  // as lazy chunks so startup stays lightweight and Firefox never fetches Chrome's Prompt API.
  type: 'module',
  main() {
    registerPanelOpening();
    registerTracker();
    const badge = registerBadge();
    registerCleanup();
    registerAutopilot({ flash: badge.flash });
    // The flash of PLAN.md §8.5 is the badge's; the guard is handed it so it does not have to
    // know there is a badge at all.
    const guard = registerGuard({ flash: badge.flash });
    // The guard first: the icon menu and the shortcuts act on it, and both must do the same
    // thing for the same gesture (PLAN.md §4.1).
    registerMenus({ guard });
    registerCommands({ guard });
  },
});
