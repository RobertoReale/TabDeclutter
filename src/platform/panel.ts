/**
 * Opening the panel, PLAN.md §4.1 and §5.5.
 *
 * One WXT `sidepanel` entrypoint, two ways of showing it: Chrome lets the
 * action click open the side panel by itself, Firefox needs the extension to
 * toggle the sidebar from the click listener.
 */
import type { Capabilities } from './capabilities';
import { caps } from './capabilities';

/** The pieces of the extension API that opening the panel needs. */
export interface PanelApi {
  readonly sidePanel?: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  readonly sidebarAction?: { toggle(): void };
  readonly action?: { onClicked: { addListener(listener: () => void): void } };
}

/**
 * Registered from the background at the top level, before any `await`: Chrome
 * tears the service worker down after about 30 s (invariant 6), and Firefox
 * only allows `sidebarAction.toggle()` inside the user gesture, which means
 * **synchronously** in the listener.
 */
export function registerPanelOpening(
  capabilities: Capabilities = caps,
  api: PanelApi = browser as unknown as PanelApi,
): void {
  if (capabilities.sidePanel) {
    api.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error: unknown) => console.error('TabDeclutter: setPanelBehavior failed', error));
    return;
  }

  if (capabilities.sidebarAction) {
    api.action?.onClicked.addListener(() => {
      // No await before this call, and none after: the gesture would be gone.
      api.sidebarAction?.toggle();
    });
  }
}
