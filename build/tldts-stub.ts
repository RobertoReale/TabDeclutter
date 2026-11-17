/**
 * Stand-in for `tldts-experimental`, used **only** by the measurement build of
 * `tools/size.mjs` (`TD_SIZE_WITHOUT_TLDTS=1`), never by a build that ships.
 *
 * The JS budgets of PLAN.md §11 exclude tldts (docs/DECISIONS.md, M7.2), and gzip has no
 * exact per-module decomposition, so the extension's own share is measured by building
 * the same bundle with the public suffix list replaced by this module and gzipping the
 * real file. Only the dataset leaves: the call sites stay, and the answer depends on the
 * input so that the minifier cannot fold a constant into them and drop the code that
 * uses a domain.
 */

export function getDomain(hostname: string, _options?: unknown): string | null {
  return hostname === '' ? null : hostname;
}
