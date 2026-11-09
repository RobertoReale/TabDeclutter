# AGENT-RULES.md

Standing rules for any agent working in this repository. `TASKS.md` says what to do, `PLAN.md`
says what the product is, and this file says how to behave while doing it.

## The documents

| File | What it is | How to read it |
|---|---|---|
| `PLAN.md` | The product spec, ~74 KB. **Binding.** | Never read it whole. `grep -n '^#' PLAN.md` gives the section line numbers; read only the sections your task lists under **Spec**, plus §3 (design principles) the first time you touch product code in a session. |
| `TASKS.md` | The execution plan: one section per task, the invariants (§2) and the ledger (§12). | Your task's section is quoted in your prompt. Grep for anything else (the ledger row, the invariants). |
| `docs/DECISIONS.md` | Every choice the spec did not make for you. | Never read it whole: it grows with every task. `grep -n '^## ' docs/DECISIONS.md` lists the titles with their line numbers; read only the entries your task touches, by line range. |
| `docs/MANUAL-CHECKS.md` | Closed: no more manual checks (see Recording). | Never add to it and never tick anything in it. |

Code, identifiers, comments, commit messages and documentation are in **English**. User-facing
strings go through i18n (`en` and `it`); the Italian strings PLAN.md quotes (labels, reasons,
messages) are the `it` locale's text, and the `en` locale carries their English equivalents. The one
exception to English is the entries of `docs/MANUAL-CHECKS.md`: they are written in Italian because
they are shown to the owner word for word (see Recording).

## The gates

The gates are the `gates` array in `phasekit.json`, and only that array. A gate is green when its
`run` command, from the repository root, exits 0.

Run them with **`pnpm gates`**, in the foreground: one call that runs that same array in order,
stops at the first red gate, and prints one line per gate with its counts (tests, coverage), plus
only the lines that explain a failure and the path of the full log. Do not run the gates one by one:
every call costs the whole conversation again. phasekit runs the same array itself before it
merges, so `pnpm gates` and the merge cannot disagree.

- While you work, run only what you touched: one test file (`pnpm vitest run tests/unit/x.test.ts`),
  or named gates (`pnpm gates lint typecheck "unit tests"`). Run the full `pnpm gates` once the change
  is complete, and again only after changing something.
- When a gate fails, read the printed lines first, then `grep` or `tail` the full log it names.
  Do not rerun a gate to see its output again.
- Run the full `pnpm gates` before every commit.
- A task that introduces a new automated check (TASKS.md says so explicitly) adds it to the `gates`
  array **in the same commit**. Never edit any other field of `phasekit.json` (`autoSequence`, model,
  effort, paths).
- Never remove or weaken a gate. That includes: deleting, skipping (`.skip`, `.only`, `test.fixme`)
  or loosening a failing test; lowering a coverage threshold or a performance budget; editing fixture
  labels so that precision passes; adding a retry to hide a real failure. If a gate cannot be made
  green honestly, stop and report.

## Scope

- Do the task in your prompt and nothing else. Do not start the next one.
- Do not add features the spec does not list (PLAN.md §0.4: "few things, done well").
- **Dependencies.** Runtime: only `wxt`, `preact`, `@preact/signals`, `tldts` (or a lighter variant)
  unless the task names another one. Dev dependencies that a task's tooling needs (test runners,
  lint plugins, axe, visualizer, an SVG rasterizer) are allowed, each recorded in DECISIONS.md with
  the reason. Pin exact versions.
- When a browser API seems to behave differently from the spec, check the official docs
  (developer.chrome.com, developer.mozilla.org) before deciding. Then pick the simplest solution
  consistent with PLAN.md §3, and record it in DECISIONS.md.
- **Searching the web.** You have `WebSearch` and `WebFetch`. Use them when the repository cannot
  answer and a guess would cost more than a search: an API that does not behave as the spec says,
  an error you cannot explain from the code, a version or compatibility question, a behaviour that
  may have changed after your training. Prefer official documentation and the library's own source
  over forums, and cite the page in the DECISIONS.md entry it supports. Do not search for what
  PLAN.md, the code or the tests already say: every result is carried by every later request.

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

Keep each entry short: a title that names the decision (it is how later tasks find it), and one or
two sentences per bullet. No code listings, no narrative of what you tried. Every later task greps
this file.

`docs/MANUAL-CHECKS.md`: **closed to new entries.** On 2026-11-09 the owner decided there will be
no more manual checks: the sequence must simply keep going. Do not add entries to it. Where a task's
**Done when** asks for a manual check, cover the behaviour with an automated test (unit, `tests/ext`
or E2E on both browsers) instead. If something truly cannot be automated, record it as one line in
your DECISIONS.md entry ("not verified by hand: …") and carry on. Never stop or wait for a person
because of it. The existing `(setup)` entries stay for release time.

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
- Keep the context small: every tool call re-reads the whole conversation, so fewer, larger steps
  cost less than many small ones. Read the part of a file you need, pipe long output through
  `tail`, never read a lockfile, and do not re-read a file you have just written or edited.
- The shell is Git Bash on Windows. Quote paths, because the repository path contains spaces. For
  deletions, never use `rm` with a glob right after a variable or on a command-substitution target;
  prefer a literal path, a `"${VAR:?}"` guard, or Node's `fs.rmSync`. Never delete outside the
  repository.

## Reporting

End every run with:

1. The commit you made: hash and subject.
2. The exact gate results: per gate, numbers and not "all green" (tests passed/failed, coverage
   percentage, error counts), as the last `pnpm gates` printed them.
3. The DECISIONS.md entries you added.
4. Anything you noticed and did not act on.

## Verification honesty

Never report a check you did not run, and never describe an expected result as an observed one. If
a gate could not run, say so and say why. Every later task builds on what this one claims.
