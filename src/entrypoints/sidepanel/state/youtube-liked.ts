/**
 * On-demand state for closing open (and suspended) YouTube video tabs that the signed-in user
 * has already liked, behind the optional `https://www.youtube.com/*` host permission.
 *
 * Every close flows through `closeTabs` (archiving each tab first) and `rememberClose` so
 * Declutter's standard Undo toast (`Ctrl+Z` / `Annulla`) and Archive work identically to manual
 * tab cleanup.
 */

import { computed, signal } from '@preact/signals';

import type { TabInfo } from '@/core/types';
import { eligibleLikedYouTubeTabs, selectLikedYouTubeTabsToClose } from '@/core/youtube';
import { closeTabs } from '@/platform/tabs';
import {
  resolveLikedYouTubeVideos,
  type ResolveLikedYouTubeOptions,
  type ResolveLikedYouTubeResult,
} from '@/platform/youtube';
import { deselectTabs } from './selection';
import { panelData } from './tabs';
import { rememberClose } from './undo';

export type LikedYouTubeStatus = 'none' | 'logged-out' | 'unavailable' | null;

/** Whether a liked-video scan/close is currently running. */
export const likedYouTubeWorking = signal(false);

/** Live progress counter while checking YouTube video like status. */
export const likedYouTubeProgress = signal<{
  readonly done: number;
  readonly total: number;
} | null>(null);

/** Non-toast outcome of the last manual liked-video check. */
export const likedYouTubeStatus = signal<LikedYouTubeStatus>(null);

let activeController: AbortController | null = null;

/** Open (or suspended) YouTube video tabs currently eligible for liked-video closing. */
export const eligibleLikedTabs = computed<readonly TabInfo[]>(() => {
  const data = panelData.value;
  if (data === null) return [];
  return eligibleLikedYouTubeTabs(data.tabs, {
    includeActiveOrAudible: data.settings.closeLikedYouTubeActive,
    protectedSites: data.protectedSites,
    keeps: data.keeps,
    now: data.at,
  });
});

export interface CloseLikedYouTubeDeps {
  readonly resolveLiked?: (
    tabs: readonly TabInfo[],
    options?: ResolveLikedYouTubeOptions,
  ) => Promise<ResolveLikedYouTubeResult>;
  readonly close?: typeof closeTabs;
  readonly now?: () => number;
}

/** Cancels any in-flight liked-video scan cleanly. */
export function cancelLikedYouTubeClose(): void {
  activeController?.abort();
  activeController = null;
  likedYouTubeWorking.value = false;
  likedYouTubeProgress.value = null;
}

/**
 * Checks eligible open (and suspended) YouTube tabs for videos the signed-in user has already
 * liked, archives and closes matching tabs, and arms the Declutter Undo toast.
 */
export async function closeLikedYouTubeNow(deps: CloseLikedYouTubeDeps = {}): Promise<void> {
  if (likedYouTubeWorking.value) return;
  const data = panelData.value;
  const candidates = eligibleLikedTabs.value;
  if (data === null || candidates.length === 0) return;

  const controller = new AbortController();
  activeController = controller;
  likedYouTubeWorking.value = true;
  likedYouTubeStatus.value = null;
  likedYouTubeProgress.value = { done: 0, total: candidates.length };

  try {
    const resolveLiked = deps.resolveLiked ?? resolveLikedYouTubeVideos;
    const result = await resolveLiked(candidates, {
      signal: controller.signal,
      onProgress: (done, total) => {
        if (activeController === controller) {
          likedYouTubeProgress.value = { done, total };
        }
      },
    });
    if (controller.signal.aborted || activeController !== controller) return;

    if (result.status === 'logged-out') {
      likedYouTubeStatus.value = 'logged-out';
      return;
    }
    if (result.status !== 'ok') {
      likedYouTubeStatus.value = 'unavailable';
      return;
    }

    const toClose = selectLikedYouTubeTabsToClose(candidates, result.likedVideoIds, {
      includeActiveOrAudible: data.settings.closeLikedYouTubeActive,
    });
    if (toClose.length === 0) {
      likedYouTubeStatus.value = 'none';
      return;
    }

    const at = (deps.now ?? Date.now)();
    const entries = await (deps.close ?? closeTabs)(toClose, at);
    deselectTabs(toClose.map((tab) => tab.id));
    rememberClose({ entries, windows: 0 });
  } finally {
    if (activeController === controller) {
      activeController = null;
      likedYouTubeWorking.value = false;
      likedYouTubeProgress.value = null;
    }
  }
}

/** Resets module-level signals (used by tests). */
export function resetLikedYouTubeState(): void {
  cancelLikedYouTubeClose();
  likedYouTubeStatus.value = null;
}
