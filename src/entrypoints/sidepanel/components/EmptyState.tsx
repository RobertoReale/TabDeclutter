/**
 * What a view says when it has nothing to say (PLAN.md §4.3: "a simple illustration +
 * «Tutto in ordine. Nessuna scheda da rivedere.»").
 *
 * The illustration is an inline SVG — drawn, not fetched, because the panel makes no
 * requests at all (invariant 1) — and `aria-hidden`, since the sentence below it already
 * says everything it means.
 */

export function EmptyState({ text }: { text: string }) {
  return (
    <div class="td-empty-state">
      <svg class="td-empty-art" viewBox="0 0 48 32" aria-hidden="true" focusable="false">
        {/* Three tidy tabs and a tick: the state the view is reporting. */}
        <rect x="1" y="5" width="46" height="26" rx="3" />
        <path d="M1 11h46M13 5v6M25 5v6" />
        <path class="td-empty-tick" d="m18 21 4 4 8-9" />
      </svg>
      <p class="td-empty">{text}</p>
    </div>
  );
}
