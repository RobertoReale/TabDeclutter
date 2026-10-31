import { expect, test } from './fixtures/extension';

/**
 * The recorder's own tests. Without them the two guards every later E2E test
 * relies on could stop seeing anything — a renamed event, a Playwright change —
 * and the whole suite would stay green while checking nothing.
 *
 * Each test provokes one violation on purpose and then takes it off the
 * recorder, which is what leaves the `health` fixture with nothing to report.
 *
 * `http://127.0.0.1:1/` is used as "somewhere else": nothing listens on port 1,
 * so the connection is refused and the suite itself stays offline. The request
 * is still issued, which is all the guard looks at.
 */
const ELSEWHERE = 'http://127.0.0.1:1/declutter-recorder-probe';

/**
 * Reading the recorder empties it, so a test that waits for an entry has to
 * keep what it reads. This also removes any ordering question: it does not
 * matter whether Playwright delivers the event to the recorder before or after
 * the test looks.
 */
function accumulate(take: () => string[]) {
  const seen: string[] = [];
  return async (): Promise<string[]> => {
    await expect
      .poll(() => {
        seen.push(...take());
        return seen.length;
      })
      .toBeGreaterThan(0);
    return seen;
  };
}

test('a request from an extension page to another origin is caught', async ({
  panel,
  recorder,
  extensionId,
}) => {
  const foreign = accumulate(() => recorder.takeForeignRequests(extensionId));

  await panel.evaluate((url) => void fetch(url).catch(() => undefined), ELSEWHERE);

  expect(await foreign()).toEqual([
    `chrome-extension://${extensionId}/sidepanel.html → ${ELSEWHERE}`,
  ]);
});

test('a request from the service worker to another origin is caught', async ({
  context,
  recorder,
  extensionId,
}) => {
  const foreign = accumulate(() => recorder.takeForeignRequests(extensionId));
  const [worker] = context.serviceWorkers();
  expect(worker, 'the background service worker should be running').toBeTruthy();

  await worker?.evaluate((url) => void fetch(url).catch(() => undefined), ELSEWHERE);

  expect(await foreign()).toEqual([`${worker?.url()} → ${ELSEWHERE}`]);
});

test('the extension reading its own files is not a violation', async ({
  panel,
  recorder,
  extensionId,
}) => {
  const own = `chrome-extension://${extensionId}/manifest.json`;
  const body = await panel.evaluate((url) => fetch(url).then((response) => response.text()), own);

  expect(body).toContain('manifest_version');
  expect(recorder.takeForeignRequests(extensionId)).toEqual([]);
});

test('an error logged by an extension page is caught', async ({ panel, recorder, extensionId }) => {
  const errors = accumulate(() => recorder.takeConsoleErrors());

  await panel.evaluate(() => console.error('recorder probe'));

  expect(await errors()).toEqual([
    `chrome-extension://${extensionId}/sidepanel.html: recorder probe`,
  ]);
});

test('an uncaught exception in an extension page is caught', async ({
  panel,
  recorder,
  extensionId,
}) => {
  const errors = accumulate(() => recorder.takeConsoleErrors());

  await panel.evaluate(() => {
    setTimeout(() => {
      throw new Error('recorder probe');
    }, 0);
  });

  expect(await errors()).toContain(
    `chrome-extension://${extensionId}/sidepanel.html: uncaught Error: recorder probe`,
  );
});

test('an error logged by the service worker is caught', async ({ context, recorder }) => {
  const errors = accumulate(() => recorder.takeConsoleErrors());
  const [worker] = context.serviceWorkers();
  expect(worker, 'the background service worker should be running').toBeTruthy();

  await worker?.evaluate(() => console.error('recorder probe'));

  expect(await errors()).toEqual([`${worker?.url()}: recorder probe`]);
});
