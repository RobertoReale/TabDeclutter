import { describe, expect, it, vi } from 'vitest';

import type { Capabilities } from '../../src/platform/capabilities';
import type { PanelApi } from '../../src/platform/panel';
import { registerPanelOpening } from '../../src/platform/panel';

const NOTHING: Capabilities = {
  sidePanel: false,
  sidebarAction: false,
  faviconApi: false,
  promptApi: false,
  tabGroups: false,
  containers: false,
  sessionTabValues: false,
  duplicateCommandDetection: false,
};

function chromeApi() {
  return {
    setPanelBehavior: vi.fn(() => Promise.resolve()),
    addListener: vi.fn<(listener: () => void) => void>(),
    toggle: vi.fn(),
  };
}

function panelApi(spies: ReturnType<typeof chromeApi>, hasSidebar: boolean): PanelApi {
  return {
    sidePanel: hasSidebar ? undefined : { setPanelBehavior: spies.setPanelBehavior },
    sidebarAction: hasSidebar ? { toggle: spies.toggle } : undefined,
    action: { onClicked: { addListener: spies.addListener } },
  };
}

describe('registerPanelOpening on Chrome', () => {
  it('lets the action click open the side panel, and adds no listener', () => {
    const spies = chromeApi();
    registerPanelOpening({ ...NOTHING, sidePanel: true }, panelApi(spies, false));

    expect(spies.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(spies.addListener).not.toHaveBeenCalled();
  });
});

describe('registerPanelOpening on Firefox', () => {
  it('toggles the sidebar synchronously from the click listener', () => {
    const spies = chromeApi();
    registerPanelOpening({ ...NOTHING, sidebarAction: true }, panelApi(spies, true));

    expect(spies.addListener).toHaveBeenCalledTimes(1);
    const listener = spies.addListener.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');

    // Called inside the listener, with no await before it: Firefox throws away
    // the user gesture at the first microtask (PLAN.md §4.1).
    expect(spies.toggle).not.toHaveBeenCalled();
    listener?.();
    expect(spies.toggle).toHaveBeenCalledTimes(1);
    expect(spies.setPanelBehavior).not.toHaveBeenCalled();
  });
});

describe('registerPanelOpening with neither API', () => {
  it('does nothing', () => {
    const spies = chromeApi();
    registerPanelOpening(NOTHING, panelApi(spies, true));

    expect(spies.addListener).not.toHaveBeenCalled();
    expect(spies.setPanelBehavior).not.toHaveBeenCalled();
    expect(spies.toggle).not.toHaveBeenCalled();
  });
});
