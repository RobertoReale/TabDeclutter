import type { BrowserContext, ConsoleMessage, Request, Worker } from '@playwright/test';

/**
 * Watches everything the extension's own contexts do, so that two invariants
 * can be checked without any test having to remember to check them:
 *
 * - an extension page or the service worker must never log an error
 *   (PLAN.md §14, "No console errors/warnings");
 * - no extension context may talk to any origin but its own
 *   (invariant 1, PLAN.md §3.4 and §11: zero network requests).
 *
 * Both are read by the `health` fixture at the end of every test. The readers
 * drain what they return: that is what lets the recorder's own test provoke a
 * violation on purpose, take it, and still end clean.
 */
export interface ExtensionRecorder {
  /**
   * Console errors and uncaught exceptions from extension pages and from the
   * service worker, oldest first. Reading removes them.
   */
  takeConsoleErrors(): string[];
  /**
   * Requests made by an extension context to anything outside
   * `chrome-extension://<extensionId>/`, oldest first. Reading removes every
   * recorded request, not only the returned ones.
   */
  takeForeignRequests(extensionId: string): string[];
  /** Starts recording on a freshly launched context. Call once. */
  attach(context: BrowserContext): void;
}

interface RecordedRequest {
  /** URL of the page or service worker that issued the request. */
  from: string;
  to: string;
}

/** The extension's own origin, and the schemes that never touch the network. */
function isOwnOrigin(url: string, extensionId: string): boolean {
  const own = `chrome-extension://${extensionId}/`;
  return (
    url.startsWith(own) ||
    url.startsWith(`blob:${own}`) ||
    url.startsWith('data:') ||
    url.startsWith('about:')
  );
}

function isExtensionUrl(url: string): boolean {
  return url.startsWith('chrome-extension://');
}

/**
 * Where a request came from, or `undefined` when it did not come from an
 * extension context. `request.frame()` throws for service worker requests, so
 * the service worker is asked about first.
 */
function initiator(request: Request): string | undefined {
  const worker = request.serviceWorker();
  if (worker) {
    return isExtensionUrl(worker.url()) ? worker.url() : undefined;
  }
  let frameUrl: string;
  try {
    frameUrl = request.frame().url();
  } catch {
    // A navigation whose frame does not exist yet: the target URL is the only
    // thing known about it, and a navigation to an extension page is ours.
    return isExtensionUrl(request.url()) ? request.url() : undefined;
  }
  return isExtensionUrl(frameUrl) ? frameUrl : undefined;
}

export function createRecorder(): ExtensionRecorder {
  const consoleErrors: string[] = [];
  const requests: RecordedRequest[] = [];

  const onConsole = (message: ConsoleMessage, from: string) => {
    if (message.type() === 'error') {
      consoleErrors.push(`${from}: ${message.text()}`);
    }
  };

  return {
    attach(context) {
      // Page and extension-page messages. A console error in a page that is
      // not the extension's (a seeded tab) is none of our business.
      context.on('console', (message) => {
        const url = message.page()?.url();
        if (url !== undefined && isExtensionUrl(url)) {
          onConsole(message, url);
        }
      });
      context.on('weberror', (error) => {
        const url = error.page()?.url();
        if (url !== undefined && isExtensionUrl(url)) {
          consoleErrors.push(`${url}: uncaught ${String(error.error())}`);
        }
      });

      // The service worker has its own console. It may already be running by
      // the time this is called, so both the event and the current list are
      // used.
      const watchWorker = (worker: Worker) => {
        if (!isExtensionUrl(worker.url())) return;
        worker.on('console', (message) => onConsole(message, worker.url()));
      };
      context.on('serviceworker', watchWorker);
      for (const worker of context.serviceWorkers()) watchWorker(worker);

      context.on('request', (request) => {
        const from = initiator(request);
        if (from !== undefined) requests.push({ from, to: request.url() });
      });
    },

    takeConsoleErrors() {
      return consoleErrors.splice(0, consoleErrors.length);
    },

    takeForeignRequests(extensionId) {
      return requests
        .splice(0, requests.length)
        .filter(({ to }) => !isOwnOrigin(to, extensionId))
        .map(({ from, to }) => `${from} → ${to}`);
    },
  };
}
