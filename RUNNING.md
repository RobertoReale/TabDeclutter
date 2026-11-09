# How it works, for you

The extension is built by an agent on its own, one task at a time. You do not have to remember
anything: **when something is needed from you, the system calls you.**

## How you are called

Every 10 minutes a scheduled task (`tabdeclutter-assistant`) checks on the work. When there is
something for you:

1. you hear a sound and see a Windows notification;
2. the page **"TabDeclutter – cosa fare"** opens in your browser (it is also on the Desktop);
3. the page tells you what to do, step by step. Almost always: open Claude Code in the
   TabDeclutter folder and type a sentence, already written there for you.

It calls you when:

- **it has stopped and is waiting for an answer.** Claude explains the question to you, proposes
  the answer, sends it and restarts everything;
- **the process has died** and has not restarted on its own;
- **everything is finished.** What remains are the publishing steps, which you do with Claude.

Since 2026-11-09 there are no manual checks: the agents cover everything with automated tests.

If you leave something pending it reminds you: a stop every 3 hours, only between 9:00 and 22:00.

## The sentences to type to Claude

Open Claude Code (in VS Code) in the TabDeclutter folder:

| You want to… | Type |
|---|---|
| start everything the first time | «Avvia la sequenza» |
| know where things stand and whether you have to do something | «Cosa devo fare?» |
| answer a stop | «La sequenza si è fermata, cosa devo fare?» |
| try the extension whenever you like | «Voglio provare l'estensione» |
| stop everything for a while | «Metti in pausa» / «Riprendi la sequenza» |
| change something in the plan | describe it in your own words |

## The only rules

- **Do not edit files in the TabDeclutter folder** while the agent is working. If you want to
  change something, ask Claude: it does it safely.
- The PC must stay on. Standby is blocked while the sequence is working; after a reboot it starts
  again on its own.
- Publishing to the stores is up to you: the agent prepares packages and texts, but sends nothing.

## If you are curious (not needed)

In PowerShell, from the TabDeclutter folder:

| Command | What it shows |
|---|---|
| `phasekit dashboard -Watch` | progress and an estimate of the time left |
| `phasekit logs -Follow` | what the agent is doing right now |
| `phasekit steps` | the list of tasks |
| `pwsh tools/assistant.ps1 -Open` | reopens the up-to-date "cosa fare" page |

When the work is finished, to remove the scheduled tasks: `pwsh tools/assistant.ps1 -Uninstall`.
