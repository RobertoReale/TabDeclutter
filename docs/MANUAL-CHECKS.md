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

- [x] (M2.2) Il pannello non propone di chiudere schede che vuoi tenere
  ⏱ 5 minuti · Chrome, con le tue schede vere
  1. Usa Chrome per almeno un giorno con la build di prova caricata.
  2. Apri il pannello di TabDeclutter e scorri le schede proposte da chiudere.
  Risultato atteso: nessuna è una scheda che vorresti tenere. Se ce n'è una, scrivi a Claude quale e perché.

- [x] (M2.2) Dopo il riavvio di Chrome le schede non tornano «nuove»
  ⏱ 2 minuti · Chrome
  1. Apri il pannello e guarda l'età di due o tre schede.
  2. Chiudi Chrome del tutto, riaprilo con le stesse schede e riapri il pannello.
  Risultato atteso: le stesse schede mostrano la stessa età di prima, non «appena aperta».

- [x] (M2.3) La lista si usa con la sola tastiera e lo screen reader la legge
  ⏱ 5 minuti · Chrome
  1. Con la build di prova caricata apri il pannello e, senza toccare il mouse, premi Tab finché il bordo di selezione non arriva sulla prima intestazione della lista («Duplicati (…)» o la prima che c'è).
  2. Scendi con ↓ fino in fondo alla lista, poi risali con ↑.
  3. Su un'intestazione di sezione premi Invio: la sezione si apre. Premi Invio di nuovo: si chiude.
  4. Su una riga di scheda premi Invio.
  5. Accendi il Narratore di Windows con Ctrl+Win+Invio, rifai i punti 1, 2 e 3 ascoltando che cosa dice, e spegnilo con la stessa combinazione.
  Risultato atteso: ↓ e ↑ si muovono di una riga per volta e passano da una sezione alla successiva senza premere Tab, e si vede sempre su quale riga sei. Invio su un'intestazione apre e chiude la sezione; Invio su una riga porta su quella scheda. Il Narratore, su un'intestazione, legge il nome della sezione con quante schede contiene e dice se è aperta o chiusa; su una riga legge titolo, sito e motivo. Se ↓ salta delle righe, se non si capisce dove sei, o se il Narratore non legge qualcosa, scrivi a Claude che cosa.

- [x] (M2.4) Il numero sull'icona si legge, non allarma e si aggiorna da solo
  ⏱ 3 minuti · Chrome, con le tue schede vere
  1. Con la build di prova caricata, guarda l'icona di TabDeclutter nella barra degli strumenti e leggi il numero sopra (se non c'è nessun numero, va bene: è una risposta anche quella).
  2. Apri il pannello e leggi la scritta in alto accanto alla barra, «… da rivedere».
  3. Chiudi a mano una delle schede che il pannello propone, poi aspetta cinque secondi senza toccare nulla e guarda di nuovo l'icona.
  Risultato atteso: il numero si legge a colpo d'occhio e non sembra un allarme (è grigio, non rosso); non è mai più grande del numero del punto 2, perché sull'icona vanno solo le schede da chiudere e nel pannello anche quelle da rivedere; al punto 3 cambia da solo entro pochi secondi, senza riaprire il pannello. Se il pannello dice «Tutto in ordine», sull'icona non deve esserci nessun numero. Se il numero è più grande di quello del pannello, o se dopo il punto 3 resta quello di prima, scrivi a Claude i due numeri.

- [x] (M2.5) La misura del pannello con 300 schede, a portatile attaccato → fatta da Claude il 2026-11-06 con la corrente: mediane 141.7, 81.9, 85.6 ms, entro 150
  ⏱ 2 minuti · il tuo computer, con il cavo della corrente
  1. Il test che cronometra l'apertura del pannello esiste e gira da solo, ma su questo portatile a batteria Windows dimezza il processore: il numero misurato finora (270 ms contro i 150 del progetto) dice quanto era lenta la macchina, non quanto è lento il pannello.
  2. Attacca il portatile alla corrente e lascialo attaccato.
  3. Scrivi a Claude: «misura l'apertura del pannello con la corrente attaccata».
  Risultato atteso: Claude ti dice un numero in millisecondi e se sta entro 150. Se ci sta, questa verifica è chiusa; se non ci sta, lui apre una fix task per velocizzare il pannello.

## Fase M3 — Le azioni

- [ ] (M3.2) Chiudere un gruppo di schede, e riaverle indietro con Annulla
  ⏱ 5 minuti · Chrome, con le tue schede vere
  1. Con la build di prova caricata apri il pannello e clicca su tre righe che non ti servono più: si spuntano e in basso compare la striscia con «Chiudi 3».
  2. Clicca «Chiudi 3». Le schede si chiudono e in basso appare per qualche secondo un riquadro che dice «3 schede chiuse» con «Annulla».
  3. Senza fretta, appoggia il mouse sul riquadro e tienilo lì: non deve sparire finché il mouse è sopra. Togli il mouse e conta: dopo circa otto secondi va via.
  4. Rifai i punti 1 e 2 con altre tre schede e questa volta clicca «Annulla».
  Risultato atteso: al punto 2 si chiudono esattamente le tre schede che avevi spuntato e nessun'altra; al punto 3 il riquadro resta finché ci tieni sopra il mouse e otto secondi ti bastano per leggerlo e decidere; al punto 4 le tre schede tornano, con la stessa pagina di prima. Se otto secondi ti sembrano troppo pochi o troppi, se il riquadro copre delle righe che ti servivano, o se una scheda torna vuota o nel posto sbagliato, scrivi a Claude che cosa è successo.

- [ ] (M3.2) Il pannello chiede prima di chiudere tante schede o quella che stai usando
  ⏱ 4 minuti · Chrome, con le tue schede vere
  1. Nel pannello, su una sezione con molte schede, clicca «Seleziona tutti» e poi il pulsante «Chiudi …» della striscia in basso. Se le schede spuntate sono più di 25, al posto dei pulsanti compare la domanda «Chiudi N schede?» con «Conferma» e «Annulla» — se la sezione più grande non arriva a 25 schede, salta al punto 3 e scrivilo a Claude.
  2. Clicca «Annulla»: non deve chiudersi niente e le spunte devono restare. Poi premi Esc per togliere le spunte.
  3. Se il pannello ti propone una finestra intera («Hai N schede in una finestra che non apri da…»), clicca «Chiudi finestra»: compare la domanda «Chiudere anche la scheda che stai usando?». Clicca «Annulla».
  Risultato atteso: la domanda appare dentro il pannello, nella striscia in basso, e mai come finestrella di sistema del browser; «Annulla» non chiude niente e lascia le spunte dov'erano; dopo il punto 3 la striscia dice «Chiudi N schede e la finestra», così sai che va via anche la finestra. Se una domanda non appare quando dovrebbe, o se «Annulla» chiude qualcosa, scrivi a Claude che cosa hai fatto.

- [ ] (M3.2) Si chiude e si annulla con la sola tastiera, e lo screen reader lo dice
  ⏱ 6 minuti · Chrome
  1. Apri il pannello e, senza toccare il mouse, premi Tab finché il bordo non arriva sulla prima intestazione della lista.
  2. Premi Ctrl+A: si spuntano tutte le schede di quella sezione. Premi Esc: le spunte vanno via.
  3. Scendi con ↓ su una riga che non ti serve e premi la barra spaziatrice: si spunta solo quella. Premi Canc: la scheda si chiude.
  4. Subito, finché il riquadro «… chiusa» è ancora in basso, premi Ctrl+Z: la scheda torna.
  5. Scendi con ↓ su una riga che vuoi tenere e premi K: la riga esce dalla lista, ma la scheda resta aperta nel browser.
  6. Accendi il Narratore di Windows con Ctrl+Win+Invio, rifai i punti 3 e 4 ascoltando che cosa dice, e spegnilo con la stessa combinazione.
  Risultato atteso: ogni tasto fa una cosa sola e si capisce sempre su quale riga sei; la barra spaziatrice spunta e non apre nulla; Canc chiude solo quello che è spuntato; Ctrl+Z riporta la scheda senza che tu debba andare col mouse sul riquadro «Annulla»; K non chiude niente. Al punto 6 il Narratore annuncia da solo «1 scheda chiusa» subito dopo Canc, senza che tu debba cercarlo. Se un tasto non fa niente, se ne fa due cose insieme, o se il Narratore non annuncia la chiusura, scrivi a Claude quale tasto.

- [ ] (M3.3) «Esporta» mette davvero la lista negli appunti, in Chrome e in Firefox
  ⏱ 4 minuti · Chrome e Firefox
  1. TabDeclutter non chiede il permesso «appunti»: scrive negli appunti solo nell'istante in cui clicchi il pulsante, e questo è l'unico modo di sapere se i due browser lo concedono davvero. I test automatici non possono verificarlo.
  2. In Chrome, con la build di prova caricata, chiudi due o tre schede dal pannello (spuntale e clicca «Chiudi …»), poi apri «Archivio» in alto.
  3. Clicca «Esporta»: sotto la lista deve comparire per qualche secondo la scritta «Copiato negli appunti».
  4. Apri una scheda nuova, vai su un posto dove si può scrivere (per esempio il campo di ricerca di Google, o il Blocco note di Windows) e premi Ctrl+V.
  5. Scrivi «archivio» nella casella di ricerca dell'Archivio, in modo che resti una riga sola, clicca «Esporta» e riincolla da un'altra parte.
  6. Ripeti i punti da 2 a 4 in Firefox, nella barra laterale.
  Risultato atteso: quello che si incolla è un elenco, una riga per scheda, della forma `- [Titolo della pagina](https://indirizzo…)` — tante righe quante erano le schede nella lista. Al punto 5 si incolla una riga sola: «Esporta» copia quello che la ricerca ha lasciato sullo schermo, non tutto l'archivio. In Firefox succede la stessa cosa. Se non compare «Copiato negli appunti», se Ctrl+V incolla qualcosa di diverso (o quello che avevi copiato prima), o se uno dei due browser chiede un permesso, scrivi a Claude quale browser e che cosa hai visto.

- [ ] (M3.4) I menu contestuali compaiono e funzionano su Chrome e Firefox
  ⏱ 5 minuti · Chrome e Firefox
  1. In Chrome, con la build di prova caricata, apri un sito qualsiasi, clicca col tasto destro in mezzo alla pagina e cerca le tre voci di TabDeclutter: «Mantieni sempre questa scheda», «Proteggi sempre questo sito», «Consenti duplicati per questo sito».
  2. Apri il pannello e trova una scheda che ti propone di chiudere. Vai su quella scheda, clicca col destro sulla pagina e scegli «Mantieni sempre questa scheda»: torna al pannello, la riga non deve più essere proposta.
  3. Apri due volte lo stesso indirizzo in due schede: il pannello le mette fra i doppioni. Su una delle due, tasto destro e «Consenti duplicati per questo sito»: le due righe devono sparire dai doppioni. Poi, sempre col destro, scegli «Proteggi sempre questo sito»: nessuna scheda di quel sito deve più essere proposta.
  4. In Firefox, nella build di prova, rifai il punto 1 e prova anche il tasto destro **sulla linguetta** della scheda in alto: le tre voci devono esserci anche lì, e cliccarne una deve avere lo stesso effetto del punto 2.
  Risultato atteso: le tre voci compaiono nel menu del tasto destro sulla pagina in entrambi i browser, e in Firefox anche sul menu della linguetta; il pannello si aggiorna da solo dopo ogni clic, senza riaprirlo; nessuna voce chiude mai niente. In Chrome il menu della linguetta non ha le voci di TabDeclutter: è normale, Chrome non lo permette alle estensioni. Se una voce manca, se compare ma non cambia niente nel pannello, o se un clic chiude una scheda, scrivi a Claude quale voce e quale browser.

## Fase M3b — La protezione duplicati

- [ ] (M3b.2) «Duplica scheda» di Chrome non viene chiusa dalla protezione
  ⏱ 4 minuti · Chrome, con la protezione su «Chiudi automaticamente»
  1. Quando la protezione è su «Chiudi automaticamente», TabDeclutter chiude da solo la seconda scheda sulla stessa pagina. Ma se il doppione lo hai fatto tu con «Duplica» di Chrome, lo volevi, e va lasciato stare. L'estensione lo capisce solo da tre indizi che Chrome le passa (quale scheda l'ha aperta, che sta subito accanto, che ha già l'indirizzo): i test automatici li simulano, e solo il Chrome vero può dire se arrivano davvero. **Questa è la verifica da cui dipende tutto il resto della protezione: se gli indizi non arrivano, chiudiamo una scheda che l'utente ha chiesto.**
  2. Nella build di prova apri il pannello e metti la protezione duplicati su «Chiudi automaticamente» (il pulsante 🛡 in alto, oppure ⚙ → «Protezione duplicati»). Se non trovi né l'uno né l'altro, questa verifica non si può ancora fare: scrivi a Claude «la protezione duplicati non si può ancora accendere dal pannello» e lascia la casella vuota.
  3. Apri un sito qualsiasi, aspetta che la pagina sia caricata, poi clicca col tasto destro **sulla linguetta** in alto e scegli «Duplica». Conta le schede: devono restare tutte e due, e devono restarci anche dopo dieci secondi.
  4. Rifallo su una pagina interna a un sito (non la home: un articolo, una ricerca, qualcosa con un indirizzo lungo).
  5. Adesso il contrario, per vedere che la protezione è accesa: copia l'indirizzo di quella pagina, apri una scheda nuova con Ctrl+T, incolla e premi Invio.
  Risultato atteso: ai punti 3 e 4 le due schede duplicate restano aperte entrambe, e l'icona dell'estensione non lampeggia; al punto 5 invece una delle due si chiude subito da sola e l'icona lampeggia, perché quello è un doppione aperto a mano. Se al punto 3 o 4 la scheda duplicata si chiude, scrivi a Claude «Duplica scheda su Chrome viene chiusa»: non è una cosa che puoi sistemare tu, e lui o corregge gli indizi o mette per iscritto che Chrome non li dà più. Se al punto 5 non si chiude niente, scrivilo: vuol dire che la protezione non era accesa e i punti 3 e 4 non dimostrano nulla.

- [ ] (M3b.2) I login con più passaggi non vengono interrotti dalla protezione
  ⏱ 5 minuti · Chrome e Firefox, con la protezione su «Chiudi automaticamente»
  1. Un accesso a un sito passa per più indirizzi di fila (il sito, poi Google o Microsoft, poi di nuovo il sito) e a volte apre una seconda scheda sulla stessa pagina. La protezione deve stare ferma durante tutto il giro: una scheda chiusa a metà di un login ti fa perdere l'accesso, ed è il danno peggiore che questa funzione può fare. TabDeclutter riconosce le pagine di accesso dall'indirizzo, e l'elenco degli indirizzi da riconoscere si verifica solo sui siti veri.
  2. Con la protezione su «Chiudi automaticamente» (vedi la verifica qui sopra), esci da un sito dove entri con «Accedi con Google» o «Accedi con Microsoft» — vanno benissimo quelli che usi di solito — e rifai l'accesso dall'inizio, senza chiudere nessuna scheda a mano.
  3. Rifai il giro aprendo la pagina di accesso **due volte**, in due schede: lasciale aperte entrambe e completa l'accesso in una delle due.
  4. Ripeti i punti 2 e 3 in Firefox, nella barra laterale.
  5. Se durante questi giri una scheda sparisce, apri «Archivio» nel pannello: la riga dice quale indirizzo è stato chiuso e quando.
  Risultato atteso: l'accesso arriva in fondo e ti ritrovi dentro al sito, in entrambi i browser; nessuna scheda sparisce durante il giro, nemmeno al punto 3 con due pagine di accesso identiche aperte insieme; se al punto 3 una scheda si chiude dopo che l'accesso è finito e sei già dentro, va bene — quello non è più un login. Se perdi una scheda a metà accesso, scrivi a Claude il sito, il punto in cui è sparita e l'indirizzo che vedi nell'Archivio: serve a lui per aggiungere quell'indirizzo alle pagine da non toccare.
