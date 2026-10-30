# Come funziona, per te

L'estensione la costruisce un agente da solo, un task alla volta. Tu non devi ricordarti niente:
**quando serve qualcosa da te, è il sistema a chiamarti.**

## Come vieni chiamato

Ogni 10 minuti un'attività pianificata (`tabdeclutter-assistant`) controlla il lavoro. Quando c'è
qualcosa per te:

1. senti un suono e vedi una notifica di Windows;
2. ti si apre nel browser la pagina **"TabDeclutter – cosa fare"** (è anche sul Desktop);
3. la pagina ti dice cosa fare, passo per passo. Quasi sempre: aprire Claude Code nella cartella
   TabDeclutter e scrivere una frase, già scritta lì per te.

Ti chiama quando:

- **si è fermato e aspetta una risposta.** Te lo spiega Claude, ti propone la risposta, la invia
  lui e fa ripartire tutto;
- **finisce una fase** (M0, M1…) che ha verifiche manuali. Trovi una build di prova pronta in
  `C:\Users\Admin\TabDeclutter-prova` e le istruzioni per ogni prova. Poi dici a Claude com'è
  andata, a parole tue: lui spunta le verifiche e, se qualcosa non va, aggiunge un task di
  correzione che l'agente fa subito;
- **il processo si è interrotto** e non è ripartito da solo;
- **è tutto finito.** Restano i passi della pubblicazione, che fai con Claude.

Se lasci qualcosa in sospeso te lo ricorda: uno stop ogni 3 ore, le verifiche una volta al giorno,
solo tra le 9 e le 22.

## Le frasi da scrivere a Claude

Apri Claude Code (in VS Code) nella cartella TabDeclutter:

| Vuoi… | Scrivi |
|---|---|
| far partire tutto la prima volta | «Avvia la sequenza» |
| sapere a che punto è e se devi fare qualcosa | «Cosa devo fare?» |
| rispondere a uno stop | «La sequenza si è fermata, cosa devo fare?» |
| dire com'è andata una verifica | «Ho fatto le verifiche della fase M1: …» |
| provare l'estensione quando vuoi | «Voglio provare l'estensione» |
| fermare tutto per un po' | «Metti in pausa» / «Riprendi la sequenza» |
| cambiare qualcosa nel piano | descrivilo a parole tue |

## Le uniche regole

- **Non modificare file nella cartella TabDeclutter** mentre l'agente lavora. Se vuoi cambiare
  qualcosa, chiedilo a Claude: lo fa in modo sicuro.
- Il PC deve restare acceso. Lo standby è bloccato finché la sequenza lavora; dopo un riavvio
  riparte da solo.
- La pubblicazione sugli store la fai tu: l'agente prepara pacchetti e testi, ma non invia niente.

## Per curiosità (non serve)

In PowerShell, dalla cartella TabDeclutter:

| Comando | Cosa mostra |
|---|---|
| `phasekit dashboard -Watch` | avanzamento e stima del tempo rimanente |
| `phasekit logs -Follow` | cosa sta facendo l'agente in questo momento |
| `phasekit steps` | l'elenco dei task |
| `pwsh tools/assistant.ps1 -Open` | riapre la pagina "cosa fare" aggiornata |

A lavoro finito, per togliere le attività pianificate: `pwsh tools/assistant.ps1 -Uninstall`.
