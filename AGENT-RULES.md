# AGENT-RULES.md

Standing rules for any agent working in this repository. `TASKS.md` says what to do, `PLAN.md`
says what the product is, and this file says how to behave while doing it.

## The documents

| File | What it is | How to read it |
|---|---|---|
| `PLAN.md` | The product spec, in Italian, ~76 KB. **Binding.** | Never read it whole. `grep -n '^#' PLAN.md` gives the section line numbers; read only the sections your task lists under **Spec**, plus §3 (design principles) the first time you touch product code in a session. |
| `TASKS.md` | The execution plan: one section per task, the invariants (§2) and the ledger (§12). | Your task's section is quoted in your prompt. Grep for anything else (the ledger row, the invariants). |
| `docs/DECISIONS.md` | Every choice the spec did not make for you. | Grep or read when a task touches an earlier decision. |
| `docs/MANUAL-CHECKS.md` | What only a person can verify. | Append to it; never tick anything in it. |

Code, identifiers, comments, commit messages and docs aimed at developers are in **English**. User-facing
strings go through i18n (`en` and `it`). `docs/` files that the plan writes in Italian (for example
`CLUSTER-REVIEW.md`, `MANUAL-CHECKS.md`) stay in Italian.

## The gates

The gates are the `gates` array in `phasekit.json`, and only that array. Run every `run` command,
from the repository root, in the order listed, **in the foreground**, and read the result. A gate is
green when it exits 0.

- Run them before every commit, not once at the end.
- A task that introduces a new automated check (TASKS.md says so explicitly) adds it to the `gates`
  array **in the same commit**. Never edit any other field of `phasekit.json` (`autoSequence`, model,
  effort, paths).
- Never remove or weaken a gate. That includes: deleting, skipping (`.skip`, `.only`, `test.fixme`)
  or loosening a failing test; lowering a coverage threshold or a performance budget; editing fixture
  labels so that precision passes; adding a retry to hide a real failure. If a gate cannot be made
  green honestly, stop and report.

## Scope

- Do the task in your prompt and nothing else. Do not start the next one.
- Do not add features the spec does not list (PLAN.md §0.4: "poche cose, fatte bene").
- **Dependencies.** Runtime: only `wxt`, `preact`, `@preact/signals`, `tldts` (or a lighter variant)
  unless the task names another one. Dev dependencies that a task's tooling needs (test runners,
  lint plugins, axe, visualizer, an SVG rasterizer) are allowed, each recorded in DECISIONS.md with
  the reason. Pin exact versions.
- When a browser API seems to behave differently from the spec, check the official docs
  (developer.chrome.com, developer.mozilla.org) before deciding. Then pick the simplest solution
  consistent with PLAN.md §3, and record it in DECISIONS.md.

## Deciding versus stopping

This runs unattended, so a question costs hours. Separate the two cases:

- **Decide and record** when the spec is silent or ambiguous and the choice is reversible: a library
  version, a test runner, a file layout, a threshold within the spec's range. Choose the simplest
  option consistent with the principles, add a DECISIONS.md entry, and carry on.
- **Stop and report** (end your turn with the report, without committing half-done work as if it
  were done) when:
  - a task's premise turns out to be false (a file it relies on does not exist, a decision it builds
    on was reversed);
  - a gate that was green before your change is red after it and you cannot see why;
  - the task would break an invariant in TASKS.md §2 or a principle in PLAN.md §3;
  - the spec contradicts itself in a way that matters, or the choice is irreversible (something
    published, sent or deleted outside this repository);
  - an acceptance criterion cannot be met (a budget, a precision target) after a genuine attempt.

Reporting a wrong plan is useful. Quietly doing an easier task, or ticking a box you did not earn,
is the most expensive thing you can do here.

## Recording

`docs/DECISIONS.md`, one entry per decision, newest at the bottom:

```markdown
## <task id> — <short title>
- **Context:** what was open or surprising.
- **Decision:** what you chose.
- **Why:** the reason, with a link to the official doc when an API was involved.
```

`docs/MANUAL-CHECKS.md`, one unticked line per check, under the heading of the task that added it:

```markdown
- [ ] (<task id>) <what to do> → <what should happen>
```

## Committing

- One task, one commit, Conventional Commit message (`feat(core): …`, `test(e2e): …`,
  `chore(build): …`). The body says **why**, not what.
- Tick the task's row in the TASKS.md ledger (`- [ ]` → `- [x]`) **in that same commit**, and only
  if every **Done when** condition holds.
- Documentation the change invalidated is updated in the same commit.
- Never add `Co-authored-by` or any other attribution to Claude or an AI in commit messages. Commit
  with the git identity already configured.
- Never commit `.output/`, `node_modules/`, `.phasekit/`, coverage or test reports, credentials.

## Working unattended

- **Never end your turn waiting on something.** There is no next turn: ending the turn ends the
  process and kills anything you left in the background. Run builds, test suites and gates in the
  foreground and let the call block, however long it takes. If you do start something in the
  background, poll it to completion inside the same turn.
- Never run anything that waits for input or never exits on its own (`pnpm dev`, `wxt dev`,
  `web-ext run`, a watch mode, an interactive prompt). Run E2E tests headless.
- Keep the context small: read the part of a file you need, pipe long output through `tail`, never
  read a lockfile.
- The shell is Git Bash on Windows. Quote paths, because the repository path contains spaces. For
  deletions, never use `rm` with a glob right after a variable or on a command-substitution target;
  prefer a literal path, a `"${VAR:?}"` guard, or Node's `fs.rmSync`. Never delete outside the
  repository.

## Reporting

End every run with:

1. The commit you made: hash and subject.
2. The exact gate results: per gate, numbers and not "all green" (tests passed/failed, coverage
   percentage, error counts).
3. The DECISIONS.md and MANUAL-CHECKS.md entries you added.
4. Anything you noticed and did not act on.

## Verification honesty

Never report a check you did not run, and never describe an expected result as an observed one. If
a gate could not run, say so and say why. Every later task builds on what this one claims.
