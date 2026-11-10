# PROMPTS.md

`phasekit run <task>` sends the fenced block under `## task` with `{{TASK}}` and `{{SECTION}}`
replaced by the task id and its section from TASKS.md. Every target in this plan is a single task
(it has a dot in its id), so this is the only block phasekit uses for runs. `resume` and `audit` are
for a person to paste into an interactive session.

---

## task

```
Read AGENT-RULES.md in full before anything else. It is short, and every rule in it applies.

Your task is quoted at the end of this prompt. Do not read TASKS.md or PLAN.md whole: PLAN.md is
the binding product spec (~74 KB). Run `grep -n '^#' PLAN.md` once and read only the
sections your task lists under **Spec**. Grep TASKS.md for the ledger and the invariants (§2).

CHECK FIRST, and report each item as pass or fail:
  1. The working tree is clean and you are on the branch plan/phase-{{TASK}}.
  2. `pnpm gates`, run once in the foreground, ends with every gate green (it runs the `gates`
     array of phasekit.json in order; see AGENT-RULES.md, The gates). If this prompt opens
     with an ALREADY VERIFIED note, phasekit measured exactly this tree green: report the item
     as passed by that note and do not run the gates now.
  3. The target immediately before {{TASK}} in the `autoSequence` array of phasekit.json is
     ticked in the TASKS.md ledger AND has a matching commit in `git log`. (Skip this item if
     {{TASK}} is the first entry.) Use autoSequence, not ledger order: fix tasks (F.n) are
     inserted into the sequence where they must run.
If any item fails, STOP and report. Do not repair it silently and do not continue.

THEN: carry out task {{TASK}} and nothing else. Respect the invariants in TASKS.md §2 and the
principles in PLAN.md §3. Where the spec leaves a reversible choice open, decide, record it in
docs/DECISIONS.md and carry on. Stop only for the cases AGENT-RULES.md lists.

NEVER end your turn waiting on something. This runs unattended: there is no next turn. No
notification will reach you, no monitor will fire, nothing will wake you up. Ending the turn ends
the process and takes every background task you started down with it. So run the builds, the
test suites and the gates in the FOREGROUND and let the call block, however long it takes. If you
do start something in the background, poll it to completion inside the same turn: polling means
calling again until it answers, not waiting to be told. A task whose last words are "I'll report
the result when the run completes" ends with its work uncommitted.

Finish with exactly one commit that contains the change, the documentation it invalidated, any
new DECISIONS.md entries, and the ticked ledger row for {{TASK}}. All gates
must be green immediately before that commit. Then write the report AGENT-RULES.md asks for and
stop.

--- the task, quoted from TASKS.md ---

{{SECTION}}
```

---

## resume

Paste into an interactive session when you are not sure where a sequence stopped. It changes
nothing.

```
Read AGENT-RULES.md. Look at the ledger in TASKS.md §12, run the gates from phasekit.json, read
.phasekit/logs/auto-stopped.txt if it exists, and check whether the last ticked task is actually
reflected in the code and in git log. A ticked box with no matching commit means a session ended
early; uncommitted edits in `git status` mean one ended mid-task. Tell me which task is genuinely
next, why the sequence stopped if it did, and what you would answer it. Change nothing.
```

---

## audit

```
Read AGENT-RULES.md and TASKS.md, then check README.md and docs/ against the code. Report what is
stale or untrue, any invariant in TASKS.md §2 with nothing enforcing it, and every ticked ledger
row with no commit behind it. Change nothing.
```
