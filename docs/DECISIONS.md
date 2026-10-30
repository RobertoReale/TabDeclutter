# Decisions

Choices that PLAN.md did not make, and places where a browser API behaved differently from the
spec. One entry per decision, newest at the bottom. Format in AGENT-RULES.md.

## setup — Execution plan and tooling for unattended runs
- **Context:** PLAN.md §13 describes milestones of one or two days each, too large for one
  reviewable commit.
- **Decision:** the milestones are split into 45 single-commit tasks in TASKS.md and run by
  phasekit. The gates live only in `phasekit.json` and grow as the project gains checks (M0.4,
  M0.5, M7.2). Checks that need a person are collected in `docs/MANUAL-CHECKS.md` and do not block
  the sequence.
- **Why:** one task per commit keeps every change reviewable and revertable on its own, and the
  gates are re-run before every merge.

## setup — Firefox add-on id (provisional)
- **Context:** PLAN.md §5.4 leaves `gecko.id` as `tabdeclutter@<dominio-o-nome-utente>`, and the id
  can never change after the first AMO submission.
- **Decision:** `tabdeclutter@robertoreale`, provisional.
- **Why:** the build needs an id from M0.1. The owner confirms or changes it before the first AMO
  submission (an entry in MANUAL-CHECKS.md).
