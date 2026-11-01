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
  4. Apri il pannello (clic sull'icona) e leggi la parola che c'è scritta dentro.
  5. In Firefox, con la build di prova caricata, apri `about:addons` → «Estensioni» e leggi il nome e la descrizione di TabDeclutter; poi appoggia il puntatore sulla sua icona nella barra e leggi il suggerimento; poi apri la barra laterale e leggi la parola che c'è scritta dentro.
  Risultato atteso: il nome è sempre «TabDeclutter». Da nessuna parte — nome, descrizione, suggerimento, nomi delle scorciatoie, pannello — deve comparire qualcosa come `__MSG_extName__` o `__MSG_...__`: se lo vedi, è un errore. Se il browser è in italiano, la descrizione comincia con «Suggerisce quali schede chiudere», il suggerimento sull'icona dice «TabDeclutter — apri il pannello», le due scorciatoie in più si chiamano «Chiudi tutti i duplicati» e «Pausa/riprendi protezione duplicati», e nel pannello c'è scritto «Ciao». Se il browser è in inglese (o in qualsiasi altra lingua) le stesse voci sono in inglese: «Suggests which tabs to close…», «TabDeclutter — open the panel», «Close all duplicate tabs», «Pause or resume duplicate protection», «Hello».

- [x] (M0.3) L'altra lingua funziona anche lei
  1. Questa è la controprova della verifica precedente: serve a vedere l'altra delle due lingue. Fallo in un solo browser, quello che ti è più comodo, e poi rimetti la lingua di prima.
  2. In Chrome: apri `chrome://settings/languages`, aggiungi l'altra lingua se non c'è (inglese se Chrome è in italiano, italiano se è in inglese), apri il menù `⋮` accanto a quella lingua e scegli «Mostra Google Chrome in questa lingua», poi clicca «Riavvia».
  3. In Firefox: apri `about:preferences`, nella sezione «Lingua» clicca «Imposta alternative…», aggiungi e porta in cima l'altra lingua, conferma e riavvia Firefox quando te lo chiede.
  4. Ricontrolla le stesse cose del punto precedente: descrizione in `chrome://extensions/` o `about:addons`, suggerimento sull'icona, parola dentro il pannello.
  5. Rimetti la lingua che usavi prima, con lo stesso percorso, e riavvia.
  Risultato atteso: tutti quei testi sono passati all'altra lingua — «Ciao» diventa «Hello» o viceversa, e la descrizione cambia di conseguenza. Il nome resta «TabDeclutter» in entrambe. Se una sola di quelle voci resta nella lingua di prima, scrivi quale.

- [x] (M0.5) In Firefox la barra laterale è in italiano
  1. Il test automatico su Firefox controlla la barra laterale solo in inglese: per vedere l'italiano serve un Firefox in italiano, e un Firefox normale non sa cambiare lingua da solo. Se il tuo Firefox è già in italiano ti basta il punto 3.
  2. Apri `about:preferences`, nella sezione «Lingua» clicca «Imposta alternative…», aggiungi l'italiano e portalo in cima, conferma e riavvia Firefox quando te lo chiede.
  3. Con la build di prova caricata, apri la barra laterale di TabDeclutter (clic sulla sua icona nella barra degli strumenti) e leggi la parola che c'è scritta dentro.
  4. Se al punto 2 hai cambiato lingua, rimetti quella di prima con lo stesso percorso e riavvia.
  Risultato atteso: nella barra laterale c'è scritto «Ciao», non «Hello» e non `__MSG_hello__`. Se vedi «Hello» con Firefox in italiano, scrivilo.

- [ ] (M0.6) CI verde al primo push su GitHub
  1. Questa verifica si fa solo quando il progetto è su GitHub: finché il codice sta solo sul tuo PC non c'è niente da guardare. Se non c'è ancora, chiedilo all'assistente («pubblica il repository su GitHub»): è l'unica cosa del progetto che esce dal PC, quindi serve che lo chieda tu.
  2. Dopo il primo push, apri la pagina del repository su GitHub e clicca la linguetta «Actions» in alto.
  3. Nell'elenco clicca la riga più recente, chiamata «CI», e poi il riquadro «gates»: compare la lista dei passaggi. Aspetta che finisca — tra cinque e venti minuti, perché scarica due browser e li avvia davvero.
  4. Se accanto a un passaggio c'è una X rossa, clicca quel passaggio per aprire il registro e copia le ultime dieci righe.
  Risultato atteso: la riga «CI» ha il segno di spunta verde e tutti i passaggi sono verdi (install, lint, typecheck, unit tests, perf budgets, build chrome, build firefox, web-ext lint, e2e chromium, e2e firefox). Gli stessi controlli passano sul tuo PC prima di ogni commit, quindi un rosso qui è quasi sempre una differenza dell'ambiente di GitHub e non un difetto del prodotto: riportalo con le righe che hai copiato e col nome del passaggio rosso.

- [ ] (M1.5) Controllo a campione di 30 etichette delle schede di prova
  1. Questa verifica non si fa nel browser e non serve installare niente: dentro il progetto ci sono 300 schede finte, e per ognuna è già stata scritta a mano la risposta alla domanda «un utente attento la chiuderebbe?». Serve il tuo giudizio su 30 di quelle risposte.
  2. Scrivi all'assistente: «mostrami 30 etichette di tabs-300». Ti risponde con un elenco numerato: per ogni scheda il titolo, l'indirizzo, da quanto tempo non viene guardata, quante volte è stata aperta, la risposta scelta («da chiudere» oppure «da tenere») e la ragione in una riga.
  3. Leggi una riga alla volta e chiediti solo questo: se fosse una tua scheda, la chiuderesti senza pensarci? Se sì, la risposta giusta è «da chiudere»; se ci pensi anche solo un attimo, è «da tenere».
  4. Dì all'assistente i numeri delle righe su cui non sei d'accordo, con una parola sul perché. Ci vogliono circa quindici minuti.
  Risultato atteso: su 30 esempi sei d'accordo almeno 27 volte. Soprattutto: nessuna scheda marcata «da chiudere» ti sembra una che poi ti dispiacerebbe non ritrovare. È quello l'errore che conta, perché il prodotto preferisce lasciar aperta una scheda inutile piuttosto che chiuderne una utile.

## Fase M1 — Il motore delle regole

- [ ] (M1.6) Le schede che il punteggio propone di chiudere ti convincono
  1. Questa verifica non si fa nel browser: il punteggio adesso funziona, ma non ha ancora una finestra in cui guardarlo. Serve il tuo giudizio su quello che propone, perché l'unico errore che conta davvero — proporre una scheda che poi ti dispiacerebbe non ritrovare — lo riconosce solo una persona.
  2. Scrivi all'assistente: «mostrami cosa propone il punteggio su tabs-300». Ti risponde con due elenchi. Nel primo le 6 schede che il punteggio propone di chiudere mentre l'etichetta scritta a mano le teneva; nel secondo venti schede prese a caso tra le altre che propone di chiudere. Per ognuna: titolo, indirizzo, da quanto non viene guardata e la ragione in una riga, come la vedresti nel pannello.
  3. Parti dal secondo elenco, che è il prodotto normale: leggi una riga alla volta e chiediti se, vedendo quella riga con quella ragione accanto, cliccheresti «chiudi» senza pensarci. Segna le righe che ti sembrano sbagliate.
  4. Poi guarda il primo elenco: sono sei pagine di risultati di ricerca lasciate aperte da giorni. Qui va bene anche dare ragione al punteggio e non all'etichetta — dillo all'assistente, perché sono le etichette il bersaglio del punteggio e vanno corrette prima che qualcosa ci venga costruito sopra. Dieci minuti in tutto.
  Risultato atteso: nel secondo elenco al massimo due righe su venti ti sembrano sbagliate, e nessuna è una scheda che ti dispiacerebbe non ritrovare. Se una lo è, riportala con una parola sul perché: vale più di dieci righe giuste.

- [ ] (M1.8) Riavviando Chrome l'età delle schede si conserva
  1. Ci vogliono dieci minuti, quasi tutti di attesa. L'estensione ha cominciato a tenere il conto di quando usi ogni scheda, ma il pannello che lo mostrerà arriva con la fase M2: per adesso quei dati si guardano in una finestra di Chrome, con i passi qui sotto. Se non hai la build di prova, chiedila all'assistente («voglio provare l'estensione»).
  2. Con la build di prova caricata in Chrome, apri tre schede su tre siti diversi e lasciale aperte almeno cinque minuti, tornando a guardarne una o due ogni tanto.
  3. Apri `chrome://extensions/`, attiva l'interruttore «Modalità sviluppatore» in alto a destra, trova il riquadro di TabDeclutter e clicca la scritta blu «service worker» (a volte è «service worker (inattivo)»): si apre la finestra degli strumenti per sviluppatori.
  4. In quella finestra clicca la linguetta «Application» in alto (se non la vedi è nascosta dietro il simbolo `»`), poi nella colonna di sinistra apri «Extension storage» → «Local» e clicca la riga `activity`.
  5. In basso compare una voce per ogni scheda aperta. Scegline una e annota su un foglio l'indirizzo scritto accanto a `url` e i due numeri scritti accanto a `createdAt` e `foregroundMs`.
  6. Chiudi Chrome del tutto, con tutte le sue finestre, e riaprilo. Se non ti ripropone le schede di prima, riaprile tu sugli stessi tre siti.
  7. Rifai i passi 3 e 4 e cerca, tra le voci, quella con l'indirizzo che avevi annotato.
  Risultato atteso: quella voce c'è ancora, `createdAt` è lo stesso numero di prima e `foregroundMs` non è tornato a zero: l'estensione ha riconosciuto la scheda anche se Chrome le ha dato un numero nuovo. Se invece la voce ha una riga in più chiamata `bootstrappedAt` e `createdAt` è un numero più grande di quello che avevi annotato, l'età è stata dimenticata al riavvio: scrivilo, con i due numeri.

- [ ] (M1.8) Riavviando Firefox l'età delle schede si conserva
  1. Come la verifica precedente, in Firefox, dieci minuti quasi tutti di attesa. Qui c'è una complicazione: la build di prova si carica come componente aggiuntivo «temporaneo», e Firefox lo rimuove quando si chiude, quindi dopo il riavvio va ricaricato a mano (passo 6) e i dati potrebbero essere stati buttati via con lui. Interessa sapere quale dei due casi succede.
  2. Con la build di prova caricata in Firefox, apri tre schede su tre siti diversi e lasciale aperte almeno cinque minuti, tornando a guardarne una o due ogni tanto.
  3. Apri `about:debugging#/runtime/this-firefox`, trova TabDeclutter nell'elenco e clicca «Ispeziona»: si apre la finestra degli strumenti per sviluppatori.
  4. In quella finestra clicca la linguetta «Archivio» («Storage» se Firefox è in inglese), poi nella colonna di sinistra apri «Extension Storage» → la voce che comincia con `moz-extension://` e clicca la riga `activity`.
  5. Scegli una delle voci che compaiono e annota su un foglio l'indirizzo scritto accanto a `url` e i numeri scritti accanto a `createdAt` e `foregroundMs`.
  6. Chiudi Firefox del tutto e riaprilo. Riapri le tre schede sugli stessi siti se non torna da sola, poi apri `about:debugging#/runtime/this-firefox`, clicca «Carica componente aggiuntivo temporaneo…» e scegli il file `manifest.json` nella cartella `%USERPROFILE%\TabDeclutter-prova\firefox`.
  7. Rifai i passi 3 e 4 e guarda le voci.
  Risultato atteso: uno di questi due, e va bene anche il secondo — serve sapere quale. Primo caso: c'è la voce con l'indirizzo che avevi annotato, con lo stesso `createdAt`, ed è quello che vogliamo. Secondo caso: le voci ci sono ma hanno tutte una riga `bootstrappedAt` e un `createdAt` nuovo, oppure l'elenco è vuoto: è quello che Firefox fa con un componente aggiuntivo temporaneo, non è un difetto del prodotto, e la verifica andrà rifatta sulla versione firmata prima della pubblicazione. Scrivi quale dei due hai visto.

- [ ] (M1.8) Una scheda sospesa da `chrome://discards` conserva il suo record
  1. Cinque minuti, in Chrome. Quando la memoria è poca Chrome «sospende» una scheda: la pagina viene scaricata e, al ritorno, ricaricata con un numero nuovo. L'estensione deve seguirla, altrimenti una scheda vecchia sembrerebbe appena aperta. Questa verifica provoca la sospensione a mano.
  2. Con la build di prova caricata, apri due schede su due siti diversi e tienile aperte qualche minuto.
  3. Guarda cosa ha registrato l'estensione con i passi 3 e 4 della verifica «Riavviando Chrome l'età delle schede si conserva», e annota l'indirizzo e il `createdAt` della prima delle due schede.
  4. Apri una terza scheda su `chrome://discards`: è un elenco di tutte le schede aperte. Trova la riga della scheda che hai annotato (la riconosci dal titolo) e, in fondo a destra in quella riga, clicca «Urgent Discard».
  5. Torna sulla scheda sospesa: Chrome la ricarica da sola.
  6. Riguarda i dati come al passo 3.
  Risultato atteso: per quell'indirizzo c'è una sola voce, non due, e il suo `createdAt` è lo stesso numero che avevi annotato, senza la riga `bootstrappedAt`. Se invece ci sono due voci con lo stesso indirizzo, o il `createdAt` è cambiato, scrivilo.
