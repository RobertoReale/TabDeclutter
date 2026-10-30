# Manual checks

What the automated tests cannot verify. Agents add the entries; only the owner ticks them, after
trying them. They do not block the automatic sequence: they can be done at any time, but it pays to
do them phase by phase, so a problem is found before anything is built on top of it.

The entries are in Italian, because `tools/assistant.ps1` shows them to the owner word for word.
Format: `- [ ] (<task>) <title>`, then numbered steps and the expected result (AGENT-RULES.md,
"Recording").

## Before publishing

- [ ] (setup) Confermare l'id Firefox `tabdeclutter@robertoreale` in `wxt.config.ts`, o cambiarlo → dopo il primo invio ad AMO non si può più cambiare
- [ ] (setup) Creare gli account sviluppatore (Chrome Web Store, AMO) e fare il primo invio a mano → PLAN.md §12.2, §12.3
