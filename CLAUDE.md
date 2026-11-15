# CLAUDE.md

TabDeclutter is a Chrome + Firefox (MV3) extension, built with WXT, Preact and TypeScript, that
suggests which tabs to close, organizes the rest into native tab groups, and blocks duplicate tabs
in real time. Everything stays on the device.

This repository is built by unattended agent sessions driven by
[phasekit](https://github.com/RobertoReale/phasekit). One task means one session, one
`plan/phase-<id>` branch and one commit.

- `PLAN.md`: the product spec. Binding.
- `TASKS.md`: the execution plan, the invariants (§2), the ledger (§12) and the fix tasks (§13).
- `AGENT-RULES.md`: how to behave while working here. Unattended sessions must read it first.
- `PROMPTS.md`: the prompt each unattended session receives.
- `phasekit.json`: the gates (the only definition of "green") and the task sequence.
- `tools/assistant.ps1`: the owner's assistant (see below).
- `RUNNING.md`: the owner's short guide.

## If you are an interactive session talking to the owner

The owner (Roberto) does not drive the build and does not want to remember commands or checks.
The build runs on its own; a scheduled task (`tabdeclutter-assistant`, every 10 min) watches it,
and when something needs him it plays a sound, shows a notification and opens
`Desktop\TabDeclutter - cosa fare.html`. That page sends him to you with a sentence to type. Your
job is to turn that sentence into the right action, so he only ever does the part a person must
do: answer a real product question.

**Since 2026-11-09 he wants no more manual checks and wants the sequence simply to keep going.**
Never propose a manual check. When a stop has a technical answer (a flaky test, the machine, a gate),
decide it yourself, send it with `-Answer` and only tell him afterwards. Ask him only for a genuine
product choice.

**Since 2026-11-15 the build may use both of his Claude accounts** (`main` = `~/.claude`, `b` =
`~/.claude-b`). When the runner waits out a usage limit, the assistant's check switches runs to an
account that is not limited (`phasekit account <name>`) and logs it in `.phasekit/assistant.log`
(`account: …`). The limits it has seen are in `.phasekit/assistant-state.json` (`limitedUntil`).

Speak to him in **Italian, plainly, briefly**. He is not reading the code. Run every tool from the
repository root with `pwsh -NoProfile -File tools/assistant.ps1 <mode>`.

**Always start with `-Report`.** It prints the state (`status=` running / answering / stopped /
paused / dead / idle / not-started / finished), the current task, what he has to do and, for a stop,
phasekit's note and the agent's last message. Then act on what he asked:

| He says something like | You do |
|---|---|
| "cosa devo fare?", "a che punto siamo?" | `-Report`, then explain in two or three sentences what is happening and what, if anything, is his to do. |
| "avvia", "fai ripartire", "riprendi" | If `status=stopped`, handle the stop first (next row): restarting would only reach the same question again. Otherwise `-Start`. If the assistant task does not exist (`Get-ScheduledTask tabdeclutter-assistant`), run `-Install` first. |
| "si è fermata, cosa devo fare?" | Read the stop in `-Report`. If you need more, look at the branch (`git log --oneline main..plan/phase-<task>`, `git status`, `git diff --stat`) and the tail of the newest `.phasekit/logs/phase-<task>-*.log`. Explain the question in plain words. **If the answer is technical and PLAN.md or TASKS.md decides it, propose the answer yourself.** Only a real product choice goes to him as a question, with your recommendation. Once he agrees, write the answer (English, precise, actionable) to a file in your scratchpad and run `-Answer <task> -File <file>`. That hands it to the same conversation and then restarts the sequence. Tell him it is done and that he will be called again if needed. |
| "ho fatto le verifiche della fase X", "X non funziona" | Record the outcome on main with the edit procedure below. Tick (`- [x]`) every check of that phase he confirmed. For each problem: add a fix task `F.<n>` (TASKS.md §13 format, his words included) and its ledger row at the end of §12. Insert `F.<n>` in `autoSequence` right after `current=` (or after the stopped/next target if nothing is running). Change the failed check's line to `- [x] (…) … → problema, vedi F.<n>`. If a check could not be done because the instructions were wrong or impossible, that is a problem too: a fix task that rewrites the check. |
| "voglio provare l'estensione" | `-Build` (a stable build of main in `%USERPROFILE%\TabDeclutter-prova`), then tell him how to load it (the page explains it too: `-Open`). |
| "metti in pausa" | `pwsh -NoProfile -File ../phasekit/bin/phasekit.ps1 pause`. To resume later: `-Start`. |
| a change of plans ("aggiungi…", "togli…") | Edit TASKS.md (and `autoSequence`) with the edit procedure. Respect PLAN.md §2.2 (out of scope) and point out any conflict before doing it. |

**Editing anything in this repository while a sequence exists.** The working tree belongs to the
runner: it is on a task branch, possibly mid-task. Never edit, commit, build or run gates there
directly. Use:

1. `-BeginEdit`: pauses the runner and prints `EDIT_DIR=…`, a checkout of `main` (the repo itself if
   main is checked out, otherwise a separate worktree).
2. Edit the files **in EDIT_DIR**.
3. `-EndEdit -Message "<conventional commit message>"`: commits to main and resumes the runner if
   it was running.

Never add `Co-authored-by` or any attribution to Claude in commits. Never push, create a GitHub
repository or publish to a store unless he asks. One standing exception he asked for (2026-11-01):
when the sequence finishes, `tools/assistant.ps1` creates `RobertoReale/TabDeclutter` on GitHub as
a **public** repository and pushes main (task branches stay local). The store submission is still
his to ask for.
