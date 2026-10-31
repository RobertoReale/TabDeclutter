# Manual checks

What the automated tests cannot verify. Agents add the entries; only the owner ticks them, after
trying them. They do not block the automatic sequence: they can be done at any time, but it pays to
do them phase by phase, so a problem is found before anything is built on top of it.

The entries are in Italian, because `tools/assistant.ps1` shows them to the owner word for word.
Format: `- [ ] (<task>) <title>`, then numbered steps and the expected result (AGENT-RULES.md,
"Recording").

## Before publishing

- [ ] (setup) Confermare l'id Firefox `tabdeclutter@robertoreale` in `build/manifest.ts`, o cambiarlo → dopo il primo invio ad AMO non si può più cambiare
- [ ] (setup) Creare gli account sviluppatore (Chrome Web Store, AMO) e fare il primo invio a mano → PLAN.md §12.2, §12.3

## Fase M0 — Impalcatura

- [ ] (M0.2) Il clic sull'icona apre il pannello, in Chrome e in Firefox
  1. In Chrome, con la build di prova caricata, clicca il pezzo di puzzle 🧩 in alto a destra nella barra: nell'elenco che si apre trova TabDeclutter e clicca la puntina 📌 accanto al nome, così la sua icona resta visibile nella barra. L'icona è un quadratino grigio con una lettera: le icone disegnate arrivano più avanti.
  2. Clicca l'icona di TabDeclutter nella barra.
  3. Richiudi il pannello con la X in alto nel pannello stesso, poi riclicca l'icona: deve riaprirsi.
  4. In Firefox, con la build di prova caricata, se non vedi l'icona di TabDeclutter nella barra clicca il pezzo di puzzle 🧩 e, nell'elenco, clicca la rotellina ⚙ accanto a TabDeclutter → «Aggiungi alla barra degli strumenti».
  5. Clicca l'icona di TabDeclutter nella barra.
  6. Clicca di nuovo la stessa icona.
  Risultato atteso: in Chrome si apre un pannello sul lato destro della finestra con la scritta «TabDeclutter» e nient'altro (è il segnaposto: il pannello vero arriva con la fase M2). In Firefox si apre la barra laterale a sinistra con la stessa scritta, e il secondo clic sull'icona la richiude. In nessuno dei due browser deve comparire una finestrella (popup) invece del pannello.

- [ ] (M0.2) La scorciatoia Alt+Shift+D apre il pannello, in Chrome e in Firefox
  1. In Chrome, con la build di prova caricata e il pannello di TabDeclutter chiuso, premi `Alt+Shift+D`.
  2. Se non succede nulla, apri `chrome://extensions/shortcuts`, cerca TabDeclutter e controlla che accanto a «Attiva l'estensione» ci sia scritto `Alt+Shift+D`; se la casella è vuota perché un'altra estensione usa già quel tasto, scrivilo lì a mano e riprova.
  3. In Firefox, con la build di prova caricata e la barra laterale chiusa, premi `Alt+Shift+D`.
  4. Premi `Alt+Shift+D` una seconda volta.
  Risultato atteso: in entrambi i browser il pannello di TabDeclutter si apre. In Firefox la seconda pressione lo richiude. Se in Chrome la casella della scorciatoia era già occupata da un'altra estensione non è un problema di TabDeclutter: segnalalo comunque.
