# CLAUDE.md

TabDeclutter is a Chrome + Firefox (MV3) extension, built with WXT, Preact and TypeScript, that
suggests which tabs to close, organizes the rest into native tab groups, and blocks duplicate tabs
in real time. Everything stays on the device.

This repository is built by unattended agent sessions driven by
[phasekit](https://github.com/RobertoReale/phasekit). One task means one session, one
`plan/phase-<id>` branch and one commit.

- `PLAN.md`: the product spec (Italian). Binding.
- `TASKS.md`: the execution plan, the invariants (§2) and the progress ledger (§12).
- `AGENT-RULES.md`: how to behave while working here. **Read it before changing anything**,
  including in an interactive session.
- `PROMPTS.md`: the prompt each unattended session receives.
- `phasekit.json`: the gates (the only definition of "green") and the task sequence.
- `RUNNING.md`: how the owner starts, watches and answers the unattended sequence.

While `phasekit auto` is running, do not edit files in this working tree from an interactive
session. The runner needs a clean tree and the right branch checked out.
