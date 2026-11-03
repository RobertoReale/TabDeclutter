/**
 * A chip: one short fact beside a row's reason (PLAN.md §4.3, "12 g", "aperta 1 volta").
 *
 * Text only, and no punctuation of its own: the chips are separated by a gap, so nothing
 * on screen depends on a separator the stylesheet would have to invent.
 */

export function Chip({ text }: { text: string }) {
  return <span class="td-chip">{text}</span>;
}
