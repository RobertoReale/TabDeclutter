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

- [ ] (setup) Dopo la pubblicazione su GitHub i controlli automatici sono verdi
  ⏱ 2 minuti · browser
  1. Apri https://github.com/RobertoReale/TabDeclutter/actions e guarda la riga più recente, «CI».
  Risultato atteso: ha la spunta verde. Se c'è una X rossa, scrivi a Claude «la CI su GitHub è rossa».

- [ ] (setup) Su Firefox, con la versione firmata, dopo il riavvio le schede non tornano «nuove»
  ⏱ 2 minuti · Firefox
  1. Con la versione firmata installata da almeno un giorno, apri il pannello e guarda l'età di due o tre schede.
  2. Chiudi Firefox e riaprilo con le stesse schede, poi riapri il pannello.
  Risultato atteso: le stesse schede mostrano la stessa età di prima, non «appena aperta».

## Fase M0 — Impalcatura

- [x] (M0.2) Il clic sull'icona apre il pannello, in Chrome e in Firefox
  1. In Chrome, con la build di prova caricata, clicca il pezzo di puzzle 🧩 in alto a destra nella barra: nell'elenco che si apre trova TabDeclutter e clicca la puntina 📌 accanto al nome, così la sua icona resta visibile nella barra. L'icona è un quadratino grigio con una lettera: le icone disegnate arrivano più avanti.
  2. Clicca l'icona di TabDeclutter nella barra.
  3. Richiudi il pannello con la X in alto nel pannello stesso, poi riclicca l'icona: deve riaprirsi.
  4. In Firefox, con la build di prova caricata, se non vedi l'icona di TabDeclutter nella barra clicca il pezzo di puzzle 🧩 e, nell'elenco, clicca la rotellina ⚙ accanto a TabDeclutter → «Aggiungi alla barra degli strumenti».
  5. Clicca l'icona di TabDeclutter nella barra.
  6. Clicca di nuovo la stessa icona.
  Risultato atteso: in Chrome si apre un pannello sul lato destro della finestra con una sola parola scritta dentro, «Ciao» se il browser è in italiano o «Hello» se è in un'altra lingua, e nient'altro (è il segnaposto: il pannello vero arriva con la fase M2). In Firefox si apre la barra laterale a sinistra con la stessa parola, e il secondo clic sull'icona la richiude. In nessuno dei due browser deve comparire una finestrella (popup) invece del pannello.

- [x] (M0.2) La scorciatoia Alt+Shift+D apre il pannello, in Chrome e in Firefox
  1. In Chrome, con la build di prova caricata e il pannello di TabDeclutter chiuso, premi `Alt+Shift+D`.
  2. Se non succede nulla, apri `chrome://extensions/shortcuts`, cerca TabDeclutter e controlla che accanto a «Attiva l'estensione» ci sia scritto `Alt+Shift+D`; se la casella è vuota perché un'altra estensione usa già quel tasto, scrivilo lì a mano e riprova.
  3. In Firefox, con la build di prova caricata e la barra laterale chiusa, premi `Alt+Shift+D`.
  4. Premi `Alt+Shift+D` una seconda volta.
  Risultato atteso: in entrambi i browser il pannello di TabDeclutter si apre. In Firefox la seconda pressione lo richiude. Se in Chrome la casella della scorciatoia era già occupata da un'altra estensione non è un problema di TabDeclutter: segnalalo comunque.

- [x] (M0.3) Nessun testo rimane in codice, e sono nella lingua del browser
  1. In Chrome, con la build di prova caricata, apri `chrome://extensions/`: leggi il nome e la descrizione di TabDeclutter.
  2. Appoggia il puntatore sull'icona di TabDeclutter nella barra, senza cliccare, e aspetta che compaia il suggerimento giallo.
  3. Apri `chrome://extensions/shortcuts` e leggi i nomi delle tre scorciatoie di TabDeclutter.
  4. Apri il pannello (clic sull'icona) e leggi i nomi delle tre voci in alto.
  5. In Firefox, con la build di prova caricata, apri `about:addons` → «Estensioni» e leggi il nome e la descrizione di TabDeclutter; poi appoggia il puntatore sulla sua icona nella barra e leggi il suggerimento; poi apri la barra laterale e leggi i nomi delle tre voci in alto.
  Risultato atteso: il nome è sempre «TabDeclutter». Da nessuna parte — nome, descrizione, suggerimento, nomi delle scorciatoie, pannello — deve comparire qualcosa come `__MSG_extName__` o `__MSG_...__`: se lo vedi, è un errore. Se il browser è in italiano, la descrizione comincia con «Suggerisce quali schede chiudere», il suggerimento sull'icona dice «TabDeclutter — apri il pannello», le due scorciatoie in più si chiamano «Chiudi tutti i duplicati» e «Pausa/riprendi protezione duplicati», e nel pannello le tre voci sono «Riordina», «Organizza» e «Archivio». Se il browser è in inglese (o in qualsiasi altra lingua) le stesse voci sono in inglese: «Suggests which tabs to close…», «TabDeclutter — open the panel», «Close all duplicate tabs», «Pause or resume duplicate protection», «Declutter», «Organize», «Archive».

- [x] (M0.3) L'altra lingua funziona anche lei
  1. Questa è la controprova della verifica precedente: serve a vedere l'altra delle due lingue. Fallo in un solo browser, quello che ti è più comodo, e poi rimetti la lingua di prima.
  2. In Chrome: apri `chrome://settings/languages`, aggiungi l'altra lingua se non c'è (inglese se Chrome è in italiano, italiano se è in inglese), apri il menù `⋮` accanto a quella lingua e scegli «Mostra Google Chrome in questa lingua», poi clicca «Riavvia».
  3. In Firefox: apri `about:preferences`, nella sezione «Lingua» clicca «Imposta alternative…», aggiungi e porta in cima l'altra lingua, conferma e riavvia Firefox quando te lo chiede.
  4. Ricontrolla le stesse cose del punto precedente: descrizione in `chrome://extensions/` o `about:addons`, suggerimento sull'icona, voci in alto nel pannello.
  5. Rimetti la lingua che usavi prima, con lo stesso percorso, e riavvia.
  Risultato atteso: tutti quei testi sono passati all'altra lingua — «Riordina» diventa «Declutter» o viceversa, e la descrizione cambia di conseguenza. Il nome resta «TabDeclutter» in entrambe. Se una sola di quelle voci resta nella lingua di prima, scrivi quale.

- [x] (M0.5) In Firefox la barra laterale è in italiano
  1. Il test automatico su Firefox controlla la barra laterale solo in inglese: per vedere l'italiano serve un Firefox in italiano, e un Firefox normale non sa cambiare lingua da solo. Se il tuo Firefox è già in italiano ti basta il punto 3.
  2. Apri `about:preferences`, nella sezione «Lingua» clicca «Imposta alternative…», aggiungi l'italiano e portalo in cima, conferma e riavvia Firefox quando te lo chiede.
  3. Con la build di prova caricata, apri la barra laterale di TabDeclutter (clic sulla sua icona nella barra degli strumenti) e leggi i nomi delle tre voci in alto.
  4. Se al punto 2 hai cambiato lingua, rimetti quella di prima con lo stesso percorso e riavvia.
  Risultato atteso: le tre voci sono «Riordina», «Organizza» e «Archivio», non «Declutter», «Organize», «Archive», e nessuna è `__MSG_...__`. Se le vedi in inglese con Firefox in italiano, scrivilo.

## Fase M2 — Il pannello

- [ ] (M2.2) Il pannello non propone di chiudere schede che vuoi tenere
  ⏱ 5 minuti · Chrome, con le tue schede vere
  1. Usa Chrome per almeno un giorno con la build di prova caricata.
  2. Apri il pannello di TabDeclutter e scorri le schede proposte da chiudere.
  Risultato atteso: nessuna è una scheda che vorresti tenere. Se ce n'è una, scrivi a Claude quale e perché.

- [ ] (M2.2) Dopo il riavvio di Chrome le schede non tornano «nuove»
  ⏱ 2 minuti · Chrome
  1. Apri il pannello e guarda l'età di due o tre schede.
  2. Chiudi Chrome del tutto, riaprilo con le stesse schede e riapri il pannello.
  Risultato atteso: le stesse schede mostrano la stessa età di prima, non «appena aperta».

- [ ] (M2.3) La lista si usa con la sola tastiera e lo screen reader la legge
  ⏱ 5 minuti · Chrome
  1. Con la build di prova caricata apri il pannello e, senza toccare il mouse, premi Tab finché il bordo di selezione non arriva sulla prima intestazione della lista («Duplicati (…)» o la prima che c'è).
  2. Scendi con ↓ fino in fondo alla lista, poi risali con ↑.
  3. Su un'intestazione di sezione premi Invio: la sezione si apre. Premi Invio di nuovo: si chiude.
  4. Su una riga di scheda premi Invio.
  5. Accendi il Narratore di Windows con Ctrl+Win+Invio, rifai i punti 1, 2 e 3 ascoltando che cosa dice, e spegnilo con la stessa combinazione.
  Risultato atteso: ↓ e ↑ si muovono di una riga per volta e passano da una sezione alla successiva senza premere Tab, e si vede sempre su quale riga sei. Invio su un'intestazione apre e chiude la sezione; Invio su una riga porta su quella scheda. Il Narratore, su un'intestazione, legge il nome della sezione con quante schede contiene e dice se è aperta o chiusa; su una riga legge titolo, sito e motivo. Se ↓ salta delle righe, se non si capisce dove sei, o se il Narratore non legge qualcosa, scrivi a Claude che cosa.
