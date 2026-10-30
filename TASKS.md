# TASKS.md — piano di esecuzione di TabDeclutter

> Questo è il file che phasekit esegue. Ogni task (`M1.4`, `M3b.2`…) è **una sessione, un branch
> `plan/phase-<id>`, un commit**. La specifica di prodotto è `PLAN.md` ed è vincolante: qui ci sono
> solo l'ordine, il perimetro di ogni task e la condizione osservabile che lo rende "fatto".
> Le regole di comportamento dell'agente sono in `AGENT-RULES.md`.

## 1. Come viene eseguito questo piano

### 1.1 I gates

I gates sono definiti **una volta sola**: l'array `gates` in `phasekit.json`. Ogni commit deve
lasciarli tutti verdi, e phasekit li riesegue prima di ogni merge su `main`.

All'inizio sono: install (`--frozen-lockfile`), lint, typecheck, unit test, build Chrome, build
Firefox, `web-ext lint`. Crescono man mano che il progetto si dota di nuovi controlli: M0.4 aggiunge
l'E2E Chromium, M0.5 l'E2E Firefox, M7.2 il budget del bundle. Un gate non si toglie e non si
indebolisce mai.

M0.1 è l'unico task che parte senza gates (li crea lui).

### 1.2 File di lavoro condivisi

- `docs/DECISIONS.md`: ogni scelta non scritta in PLAN.md (versioni, librerie, API che si comportano
  diversamente dalla specifica, tarature). Una voce per decisione, con il task che l'ha presa.
- `docs/MANUAL-CHECKS.md`: tutto ciò che non si può verificare in automatico (un riavvio vero del
  browser, uno screen reader, il modello AI sul PC reale). L'agente aggiunge le voci, scritte come
  istruzioni passo-passo per l'utente. A fine fase `tools/assistant.ps1` le mostra all'utente
  insieme a una build di prova. Non bloccano la sequenza.
- I problemi trovati nelle verifiche diventano task di correzione `F.n` (sezione 13), inseriti in
  `autoSequence` subito dopo il task in corso.

### 1.3 Ordine

Le fasi seguono le milestone di PLAN.md §13 (M0 → M7). Dentro ogni fase, i task sono ordinati per
dipendenza. Le fixture etichettate (M1.5) vengono **prima** dello scoring (M1.6), perché le
etichette devono riflettere il giudizio umano, non l'output dell'algoritmo.

## 2. Invarianti

Cose che non devono mai rompersi, con il motivo. Dove si può, sono imposte da un test o da una
regola di lint invece che dalla buona volontà.

1. **Zero richieste di rete dai contesti dell'estensione.** Principio PLAN §3.4 e requisito di
   entrambi gli store. Gli E2E falliscono se un contesto dell'estensione fa una richiesta esterna
   (fixture creata in M0.4).
2. **Nessuna scheda chiusa senza un gesto esplicito**, tranne la protezione duplicati in modalità
   "Chiudi automaticamente". PLAN §3.1: è la promessa del prodotto.
3. **Ogni chiusura finisce in archivio** ed è ripristinabile. PLAN §3.3.
4. **`src/core/` è TypeScript puro**: niente `browser.*`/`chrome.*`, dipendenze iniettate, `now`
   iniettato. Serve a testarlo al 100% e a condividerlo tra background e pannello (PLAN §5.2).
5. **`chrome.*` solo dentro `src/platform/`**, dietro feature detection. Il codice applicativo
   chiede a `capabilities.ts` e non controlla mai il nome del browser (PLAN §5.5). Imposto da
   ESLint (M0.1).
6. **Nessuno stato solo in memoria nel background, listener registrati in modo sincrono al
   top-level.** Il service worker di Chrome muore dopo circa 30 s di inattività (PLAN §5.2, §8.2).
7. **Titoli e URL delle schede sono input non fidato**: mai `innerHTML` o
   `dangerouslySetInnerHTML`. Nessun `eval`/`new Function`, nessun codice remoto. Requisito degli
   store (PLAN §12.1). Imposto da ESLint (M0.1).
8. **Permessi esattamente quelli di PLAN §5.4.** Niente `host_permissions`, niente content
   script. Ogni permesso in più è un motivo di rifiuto in revisione.
9. **Una sola definizione di "duplicato"**: `duplicateKey()` in `core/duplicates.ts`, usata sia
   da Riordina sia dal guard (PLAN §6.2).
10. **Ogni differenza Chrome/Firefox ha un test con capabilities mockate o una voce in
    `docs/MANUAL-CHECKS.md`** (PLAN §5.5).
11. **Ogni stringa visibile passa dall'i18n** e le chiavi `en`/`it` coincidono (test da M0.3).

## 3. PHASE M0 — Scaffolding

### M0.1 — Toolchain e scheletro del progetto

Crea il progetto vuoto ma con tutta la toolchain, così che tutti i gates iniziali di
`phasekit.json` esistano e siano verdi.

**Spec.** PLAN.md §5.1, §5.3, §12.3 (versioni pinnate, build riproducibile), §13 M0.

**Cosa fare.**
- `package.json`: `"type": "module"`, versione `0.1.0`, licenza MIT,
  `"packageManager": "pnpm@<versione di pnpm -v>"`, `engines.node`. `.nvmrc` con la versione
  **esatta** di `node -v` (serve alla build riproducibile per AMO). Lockfile committato.
- WXT (ultima stabile) con `srcDir: 'src'`. Preact + `@preact/signals` (integrazione via
  `@preact/preset-vite` o equivalente: scegli e annota). TypeScript `strict` più
  `noUncheckedIndexedAccess`.
- ESLint (flat config, typescript-eslint) + Prettier. Regole che impongono gli invarianti 5 e 7:
  vietato `chrome` fuori da `src/platform/`, vietati `innerHTML`, `outerHTML`,
  `dangerouslySetInnerHTML`, `eval`, `new Function`.
- Vitest con un primo test reale: `src/core/time.ts` (costanti `MINUTE`/`HOUR`/`DAY`, `clamp`)
  e il suo test. Niente `passWithNoTests`.
- Entrypoint `background` (vuoto, `defineBackground`) e `sidepanel` (Preact, un placeholder).
- Script: `dev`, `dev:firefox`, `build`, `build:firefox`, `zip`, `zip:firefox`, `lint` (eslint +
  prettier --check), `lint:firefox` (`web-ext lint -s .output/firefox-mv3`), `typecheck`
  (`wxt prepare` + `tsc --noEmit`), `test` (`vitest run`). `e2e` ed `e2e:firefox` arrivano in
  M0.4/M0.5: non creare script che non fanno niente.
- Il minimo di manifest necessario perché `web-ext lint` dia 0 errori (es. `gecko.id`); il
  manifest completo è M0.2.
- `LICENSE` (MIT, Roberto Reale, 2026), `README.md` essenziale (cos'è, come si builda).
- `.gitignore` esiste già: aggiungi solo quello che manca.

**Perimetro.** Solo configurazione e scheletro. Nessuna funzionalità del prodotto.

**Fatto quando.** Da albero pulito, ogni comando dell'array `gates` di `phasekit.json` termina
con exit 0, nell'ordine. `docs/DECISIONS.md` registra le versioni scelte (Node, pnpm, WXT,
Preact) e come è integrato Preact.

### M0.2 — Manifest per browser, capabilities e apertura del pannello

Il manifest generato deve coincidere con PLAN §5.4 su entrambi i browser, e il clic sull'icona
deve aprire il pannello.

**Spec.** PLAN.md §4.1 (punti di ingresso, solo apertura pannello e scorciatoia), §5.4, §5.5.

**Cosa fare.**
- `wxt.config.ts` con `manifest: ({ browser }) => …`: permessi, `optional_permissions`,
  `incognito`, `commands`, `side_panel` / `sidebar_action`, `minimum_chrome_version: "121"`,
  `gecko` (`strict_min_version: "140.0"`, `data_collection_permissions`). Per l'id usa
  `tabdeclutter@robertoreale`: è una scelta provvisoria, annotala in DECISIONS come "da
  confermare prima del primo invio ad AMO, poi immutabile".
  Estrai la funzione che costruisce il manifest in un modulo testabile.
- `src/platform/capabilities.ts` come in §5.5, scritto come factory testabile
  (`detectCapabilities(env)`) più l'istanza `caps`.
- `src/platform/panel.ts`: Chrome `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`;
  Firefox `action.onClicked` → `sidebarAction.toggle()` chiamato **in modo sincrono**.
  Registrazione dal background al top-level.

**Perimetro.** `wxt.config.ts`, `src/platform/{capabilities,panel}.ts`, entrypoint background,
test unitari.

**Fatto quando.**
- Un unit test verifica, per Chrome e per Firefox, che chiavi e permessi del manifest siano
  esattamente quelli di §5.4: nessun `host_permissions`, nessun `content_scripts`.
- Dopo la build, `.output/chrome-mv3/manifest.json` e `.output/firefox-mv3/manifest.json` sono
  stati ispezionati e coincidono con §5.4. Le differenze imposte da WXT sono annotate.
- `web-ext lint`: 0 errori. Gli eventuali warning sono annotati in DECISIONS.
- I test di `capabilities` coprono Chrome e Firefox mockati.
- Aggiunte a MANUAL-CHECKS: "clic sull'icona apre il pannello (Chrome, Firefox)" e
  "Alt+Shift+D apre il pannello (Chrome, Firefox)".

### M0.3 — i18n e pannello "Hello" localizzato

Tutte le stringhe passano da un helper tipizzato, e un test impedisce che `en` e `it` divergano.

**Spec.** PLAN.md §2.1 (UI bilingue), §4.6 (riga "Lingua"), §13 M0.

**Cosa fare.**
- `src/public/_locales/{en,it}/messages.json` con `extName`, `extDescription`, `actionTitle`,
  `cmdCloseDuplicates`, `cmdToggleGuard`, `hello`.
- Helper `t(key, ...subs)` tipizzato sulle chiavi di `en` (una chiave inesistente è un errore di
  compilazione).
- Unit test: stesse chiavi in `en` e `it`, stessi placeholder, sostituzione corretta.
- Il pannello mostra `t('hello')` e imposta `lang` sul documento.

**Perimetro.** `_locales`, helper i18n, pannello, test.

**Fatto quando.** I test di parità passano. Il manifest buildato usa `__MSG_*__` e la build
risolve le chiavi. Il pannello renderizza la stringa localizzata, verificato in E2E da M0.4.

### M0.4 — Harness E2E Chromium

Gli E2E diventano un gate: dopo questo task ogni merge verifica l'estensione vera, caricata in
Chromium.

**Spec.** PLAN.md §5.1 (Playwright), §14 (E2E), §13 M0 (accettazione), §11 (zero rete).

**Cosa fare.**
- Playwright con l'estensione caricata da `.output/chrome-mv3` in un persistent context.
  Usa il Chromium di Playwright, non Chrome brandizzato: le versioni recenti di Chrome ignorano
  `--load-extension`. Headless se supporta le estensioni (`channel: 'chromium'`); verifica e
  annota.
- Fixture riusabili:
  1. id dell'estensione (dal service worker) e apertura di `chrome-extension://<id>/sidepanel.html`
     in una scheda (il side panel vero non si apre senza gesto utente);
  2. fallisce il test se una pagina dell'estensione o il service worker scrive un errore in
     console;
  3. fallisce il test se un contesto dell'estensione fa una richiesta di rete verso un'origine
     che non sia l'estensione stessa (invariante 1).
- Primo test: il pannello mostra "Hello" localizzato in `en` e in `it`.
- Script `e2e`: builda Chrome e poi lancia Playwright, così non gira mai su una build vecchia.
- Aggiungi a `phasekit.json` il gate `{ "name": "e2e chromium", "cwd": ".", "run": "pnpm e2e",
  "retries": 1 }`.

**Perimetro.** Config Playwright, `tests/e2e/`, `package.json`, `phasekit.json` (solo
l'aggiunta del gate).

**Fatto quando.** `pnpm e2e` passa due volte di fila da albero pulito. Il gate è in
`phasekit.json`. Le scelte (headless, Chromium) sono in DECISIONS.

### M0.5 — Harness E2E Firefox

Lo stesso per Firefox: smoke test sull'estensione vera, via WebDriver BiDi.

**Spec.** PLAN.md §5.1 (Puppeteer + web-ext), §14 (E2E Firefox).

**Cosa fare.**
- Puppeteer con `browser: 'firefox'` e WebDriver BiDi. Installa l'estensione da
  `.output/firefox-mv3` (`browser.installExtension` o equivalente). Fissa l'UUID interno
  (preferenza `extensions.webextensions.uuids`) così i test aprono
  `moz-extension://<uuid>/sidepanel.html`.
- Firefox: in locale c'è Firefox 157 in `C:\Program Files\Mozilla Firefox\firefox.exe`, in CI
  si scarica. Rendi il percorso configurabile e annota la scelta.
- Runner dei test a scelta (config Vitest separata o altro), annotato.
- Primo test: il pannello mostra "Hello" localizzato; nessun errore in console.
- Script `e2e:firefox`: builda Firefox e poi lancia i test. Headless.
- Aggiungi a `phasekit.json` il gate `{ "name": "e2e firefox", "cwd": ".", "run":
  "pnpm e2e:firefox", "retries": 1 }`.

**Perimetro.** Harness Firefox, `tests/e2e-firefox/` (o simile), `package.json`,
`phasekit.json` (solo l'aggiunta del gate).

**Fatto quando.** `pnpm e2e:firefox` passa due volte di fila. Il gate è in `phasekit.json`.

### M0.6 — CI GitHub Actions

La CI esegue gli stessi controlli dei gates, così un push rotto si vede su GitHub.

**Spec.** PLAN.md §13 M0 (CI), §12.4.

**Cosa fare.** `.github/workflows/ci.yml` su push e pull request: Node da `.nvmrc`, pnpm dalla
versione di `packageManager`, poi gli stessi comandi dell'array `gates` di `phasekit.json`,
nello stesso ordine (Firefox installato in CI per l'E2E Firefox). `release.yml` è M7.5.

**Perimetro.** Solo `.github/workflows/ci.yml`.

**Fatto quando.** Il file è YAML valido (verifica con un validatore eseguito via `pnpm dlx`,
senza aggiungerlo alle dipendenze) e i suoi comandi coincidono con i gates. Aggiunta a
MANUAL-CHECKS: "CI verde al primo push su GitHub".

## 4. PHASE M1 — Core puro e tracker

### M1.1 — Tipi e normalizzazione URL

La base di tutto il core: i tipi condivisi e una normalizzazione URL corretta e testata.

**Spec.** PLAN.md §6.1 (`TabActivity`), §6.2, §8.3 (tabella "Confronto URL" → `MatchOptions`),
§10 (tipi delle chiavi di storage).

**Cosa fare.**
- `src/core/types.ts`: una forma di scheda indipendente dal browser (`TabInfo`, con `pinned`,
  `audible`, `active`, `discarded`, `hidden`, `groupId`, `cookieStoreId`, `incognito`,
  `openerTabId`, `pendingUrl`, `lastAccessed`…), `TabActivity`, `Settings`, `GuardSettings`,
  `MatchOptions`, `ArchivedTab`, con i valori di default in un unico modulo.
- `src/core/url.ts`: `normalizeUrl(url, options)` e `registrableDomain()` tramite tldts
  (dipendenza runtime ammessa; valuta la variante più leggera e annota). Gestisce URL non valide
  e gli schemi interni di entrambi i browser senza eccezioni.
- Coverage: `@vitest/coverage-v8` con soglia ≥ 95% (righe e branch) su `src/core/**`, imposta
  da `pnpm test`.

**Perimetro.** `src/core/{types,url}.ts`, config Vitest, test.

**Fatto quando.** Almeno 40 casi di test su `url.ts`: tracking param, `www.`, porte, slash
finale, hash SPA `#/`, query ordinate, `about:`/`chrome:`/`moz-extension:`, URL non valide.
`pnpm test` fallisce se la coverage di `core/` scende sotto il 95%.

### M1.2 — Classificazione del tipo di pagina

Ogni scheda riceve una classe (search, auth, error…) da regole su URL e titolo, senza leggere la
pagina.

**Spec.** PLAN.md §6.3, §5.5 (riga "Pagine interne").

**Cosa fare.** `src/core/rules.ts` (tutte le liste di host e pattern in un solo file dati) e
`src/core/classify.ts`. Copre le pagine interne di Chrome ed Edge e quelle di Firefox; le pagine
di TabDeclutter stesse sono riconoscibili (servono allo scoring come protezione). I titoli di
errore sono multilingua (IT/EN almeno).

**Perimetro.** `src/core/{rules,classify}.ts`, test.

**Fatto quando.** Test a tabella con almeno 5 casi per classe, inclusi falsi amici (una pagina
che contiene "login" nel testo del path ma non è un login, se le regole lo distinguono). Coverage
di `core/` ≥ 95%.

### M1.3 — Pattern della whitelist duplicati

La whitelist compatibile con Duplicate Tabs Closer, compilata una volta e mai fonte di crash.

**Spec.** PLAN.md §8.3 ("Whitelist duplicati").

**Cosa fare.** `src/core/patterns.ts`: `compile(patterns) → { match(url): boolean, errors:
{ line, message }[] }`. `*` = qualsiasi sequenza; righe `/…/` = regex; regex non valida = errore
per quella riga, ignorata. Limite di 500 caratteri per pattern. Esporta i default per browser.
Prima di scrivere, verifica la semantica esatta della sintassi di Duplicate Tabs Closer
(maiuscole, ancoraggi, flag) sul suo repository (github.com/Peuj/duplicate-tabs-closer) e annota
cosa hai trovato.

**Perimetro.** `src/core/patterns.ts`, test.

**Fatto quando.** Test su wildcard, regex, regex non valide, righe vuote o con spazi, limite di
lunghezza, default Chrome e Firefox, e almeno 3 pattern reali nella sintassi di Duplicate Tabs
Closer che si comportano come lì.

### M1.4 — Chiave di duplicato e scelta della scheda da tenere

Una sola definizione di duplicato e una sola regola di priorità, condivise da Riordina e dal
guard.

**Spec.** PLAN.md §6.2 (ultimo punto), §8.3 ("Confronto URL", "Priorità ed esclusioni"), §8.4
punto 3, §5.5 (container, schede nascoste).

**Cosa fare.** `src/core/duplicates.ts`:
- `duplicateKey(url, matchOptions, cookieStoreId?)`;
- `findDuplicateSets(tabs, options, isWhitelisted)`, che esclude le schede `hidden`;
- un comparatore di priorità che implementa §8.4.3 (fissata, scheda attiva navigata, HTTPS, età,
  finestra attiva), esportato in modo che M3b.1 lo riusi senza duplicarlo.

**Perimetro.** `src/core/duplicates.ts`, test.

**Fatto quando.** Ci sono test per ogni opzione di `MatchOptions`, per http/https equivalenti,
per i container (stessa URL in container diversi = non duplicato), per le schede nascoste, per
ogni regola di priorità e per le combinazioni in cui la prima regola che distingue vince.

### M1.5 — Fixture etichettate (prima dello scoring)

Fixture realistiche con un'etichetta "da suggerire sì/no" scritta con giudizio umano, prima che
esista l'algoritmo che le dovrà rispettare.

**Spec.** PLAN.md §6.5, §1 (cosa rende inutile una scheda), §3.1 (un falso positivo costa più di
un falso negativo).

**Cosa fare.**
- Script deterministico (PRNG con seed) in `scripts/` che genera `tests/fixtures/tabs-50.json`,
  `tabs-300.json` e `tabs-1000.json` da template curati: ricerche, login, documentazione, PR di
  GitHub, YouTube, notizie, pagine "per dopo", duplicati, fissate, audio, gruppi, più finestre,
  una finestra dimenticata, titoli in italiano e in inglese.
- Ogni scheda ha i campi di `TabInfo`, il record di attività e un `now` fisso. Le schede di
  `tabs-300` hanno anche `expected: 'suggest' | 'keep'` e una breve motivazione.
- Le etichette rispondono a "un utente attento la chiuderebbe?", in modo conservativo. **Non
  derivarle da regole di punteggio.**
- Un test valida lo schema delle fixture.

**Perimetro.** `scripts/`, `tests/fixtures/`, test di schema. Nessun codice di scoring.

**Fatto quando.** Le fixture esistono, sono rigenerabili in modo identico e lo schema è
validato. La distribuzione delle etichette (quante `suggest`, per tipo) è annotata in DECISIONS.
Aggiunta a MANUAL-CHECKS: "rivedere a campione 30 etichette di `tabs-300.json`".

### M1.6 — Punteggio di inutilità

Il cuore del prodotto: un punteggio spiegabile, deterministico e veloce.

**Spec.** PLAN.md §6.4 (tutto), §6.5, §4.3 (suggerimento a livello di finestra), §11 (budget).

**Cosa fare.**
- `src/core/scoring.config.ts`: tutti i pesi e le soglie.
- `src/core/scoring.ts`: `scoreTabs(tabs, activity, settings, now, context)` con i passi 1–3,
  i bucket, il motivo principale, tutti i motivi con i dati per il testo i18n, e il segnale di
  "finestra dimenticata" per la card di §4.3.
  Il `context` porta duplicati, keeps, domini protetti, whitelist, preferiti (opzionale) e
  l'origine dell'estensione.

**Perimetro.** `src/core/scoring*.ts`, test, benchmark.

**Fatto quando.**
- Ogni regola ha un test a tabella.
- Test di proprietà: una scheda protetta ha sempre score 0; il punteggio è monotono
  nell'inattività; stessi input danno stesso output.
- Precisione ≥ 0,9 sul bucket `close` di `tabs-300.json`. Se non ci arrivi, tara
  `scoring.config.ts` restando nei margini della spec. **Non cambiare mai le etichette.** Se non
  basta, fermati e riporta i numeri.
- Benchmark: mediana dello scoring di 1000 schede ≤ 15 ms, misurata dopo un warm-up.
- I valori finali di precisione e benchmark sono annotati in DECISIONS.

### M1.7 — Storage tipizzato e versionato

Ogni dato persistente ha un item tipizzato, con versione e default, così le migrazioni future
sono possibili.

**Spec.** PLAN.md §10.

**Cosa fare.** `src/platform/storage.ts` con WXT `storage.defineItem` per tutte le chiavi di §10
(`version: 1`, struttura delle migrazioni pronta, default). Helper per l'archivio (FIFO con cap,
una scrittura per azione), per i keeps con scadenza e per le esenzioni del guard in
`storage.session`.

**Perimetro.** `src/platform/storage.ts`, test con `fakeBrowser` di `wxt/testing`.

**Fatto quando.** Test su default, lettura e scrittura, cap FIFO dell'archivio, scadenze dei
keeps ed esenzioni con TTL.

### M1.8 — Tracker dell'attività delle schede

Il background registra quando ogni scheda è stata usata, e lo ricorda attraverso discard e
riavvii.

**Spec.** PLAN.md §6.1 (tutto), §5.5 (righe "Riconciliazione dopo riavvio" e "Discard"), §16
(flush su `onSuspend`).

**Cosa fare.**
- `src/core/reconcile.ts`: abbinamento puro dei record salvati alle schede attuali per URL
  (multiset, a parità vince l'ordine finestra/indice).
- `src/entrypoints/background/tracker.ts`: tutti gli eventi della tabella §6.1, scritture con
  debounce di 1–2 s coalescenti, flush dove la piattaforma lo consente (verifica cosa offre il
  service worker di Chrome e cosa l'event page di Firefox, e annota), bootstrap su `onInstalled`
  con `bootstrapped: true`. Su Firefox usa prima `sessions.setTabValue`/`getTabValue`.

**Perimetro.** `src/core/reconcile.ts`, tracker, registrazione nel background, test.

**Fatto quando.**
- Test con `fakeBrowser` per creazione, attivazione, foreground con cambi di focus,
  navigazione, `onReplaced`, rimozione, riconciliazione all'avvio (abbinati e scartati),
  bootstrap, e il percorso Firefox con i tab value mockati.
- Un test verifica che N eventi ravvicinati producano una sola scrittura.
- Aggiunte a MANUAL-CHECKS: "riavviando Chrome l'età delle schede si conserva", lo stesso su
  Firefox, e "una scheda sospesa da `chrome://discards` conserva il suo record".

## 5. PHASE M2 — Vista Riordina in sola lettura

### M2.1 — Design token, shell del pannello e stato reattivo

Lo scheletro visivo del pannello e lo stato che lo tiene aggiornato dal vivo.

**Spec.** PLAN.md §4.2 (header e navigazione), §4.7, §5.2 (Side Panel), §11 (signals, `key`
stabili).

**Cosa fare.**
- `styles/tokens.css` e `styles/base.css`: token, tema chiaro/scuro con `prefers-color-scheme`,
  scala di spaziatura, tipografia, `prefers-reduced-motion`.
- `App` con header (titolo, "N schede · M finestre", ⚙) e navigazione Riordina / Organizza /
  Archivio. Organizza e Archivio mostrano per ora un semplice stato vuoto.
- `state/tabs.ts`: carica schede, attività e impostazioni; ascolta `tabs.on*` con debounce di
  150 ms e `storage.onChanged`; calcola i punteggi con `core/`.

**Perimetro.** `sidepanel/` (App, styles, state), test.

**Fatto quando.** Un E2E Chromium verifica che i conteggi dell'header corrispondano alle schede e
finestre aperte e si aggiornino quando se ne apre una. Un E2E con `colorScheme: 'dark'` verifica
che il tema scuro si applichi. Nessun errore in console.

### M2.2 — Righe, sezioni e motivi

La vista Riordina mostra le schede suggerite, raggruppate per motivo e spiegate in linguaggio
umano.

**Spec.** PLAN.md §4.2, §4.3 (tranne selezione e azioni di massa), §6.4 ("Testi dei motivi"),
§5.5 (riga "Favicon"), §11 (`content-visibility`).

**Cosa fare.**
- Componenti `HealthBar`, `Section` (comprimibile; "Da valutare" chiusa di default), `TabRow`,
  `Chip`, `EmptyState`. Ordine delle sezioni come in §4.3. Età con `Intl.RelativeTimeFormat`,
  plurali con `Intl.PluralRules`.
- `src/platform/favicon.ts`: `_favicon` su Chrome; su Firefox `favIconUrl` solo se `data:`,
  altrimenti avatar con l'iniziale e un colore da hash del dominio.
- Azione "Vai": attiva la scheda e mette a fuoco la sua finestra.
- Card "finestra dimenticata".
- La trasformazione da schede con punteggio a sezioni è una funzione pura, testata.

**Perimetro.** Vista Riordina, componenti, `favicon.ts`, chiavi i18n, test.

**Fatto quando.**
- Unit test per la trasformazione in sezioni e per `favicon.ts` con capabilities mockate.
- E2E Chromium con schede seminate (pagine locali servite dal test, attività invecchiata
  scrivendo direttamente nello storage): compaiono le sezioni attese con i motivi corretti, e
  "Vai" attiva la scheda.
- Smoke E2E Firefox: la vista si apre e mostra le sezioni.

### M2.3 — Navigazione da tastiera e ARIA

La lista si usa tutta da tastiera ed è leggibile da uno screen reader.

**Spec.** PLAN.md §4.8 (solo navigazione, `Enter`, ruoli ARIA, live region, focus ring,
target ≥ 24 px; `Space`/`Del`/`K`/`Ctrl+A`/`Ctrl+Z` sono di M3.2).

**Cosa fare.** Roving tabindex su ↑/↓ tra le righe e tra le sezioni, `Enter` va alla scheda,
ruoli ARIA coerenti (`listbox`/`option` o `grid`: scegli e annota), `aria-live="polite"` sui
conteggi, focus ring visibile.

**Perimetro.** Componenti della vista Riordina, test.

**Fatto quando.** Un E2E Chromium percorre la lista solo con la tastiera, apre e chiude una
sezione e va a una scheda con `Enter`. I ruoli ARIA sono verificati nel DOM.

### M2.4 — Badge sull'icona

L'icona mostra quante schede sono "Da chiudere", senza polling.

**Spec.** PLAN.md §4.1 (Badge), §11 (debounce di 2 s, alarm ogni 30 min), §8.5 (lampeggio,
qui solo predisposto).

**Cosa fare.** `src/entrypoints/background/badge.ts`: conteggio del bucket `close` con lo stesso
`core/`, ricalcolo su eventi delle schede (debounce di 2 s) e su un alarm ogni 30 min, nascosto
a 0, colore neutro, rispetto dell'impostazione "Mostra badge". Esporta una funzione `flash()`
(cambio colore per 1,5 s) che userà il guard.

**Perimetro.** `badge.ts`, registrazione nel background, test.

**Fatto quando.** Test con `fakeBrowser` su conteggio, debounce, alarm, impostazione disattivata
e valore 0. Un E2E Chromium legge il testo del badge dal service worker.

### M2.5 — Budget di apertura del pannello

Con 300 schede il pannello deve mostrare la lista entro 150 ms.

**Spec.** PLAN.md §11, §13 M2 (accettazione).

**Cosa fare.** Misura il tempo da apertura del pannello a lista visibile con 300 schede. Il
metodo (300 schede vere nell'E2E, o un harness che renderizza il pannello con i dati della
fixture) va scelto e annotato. Se sei sopra il budget, ottimizza (signals, `content-visibility`,
lavoro rinviato). La virtualizzazione vera serve solo se nient'altro basta.

**Perimetro.** Codice del pannello che serve a rientrare nel budget, test di misura.

**Fatto quando.** Un test automatico misura e verifica ≤ 150 ms (mediana di più aperture) e
gira nei gates. Il numero misurato è annotato in DECISIONS.

## 6. PHASE M3 — Azioni, archivio, annulla

### M3.1 — Azioni sulle schede e sicurezze

Chiudere, annullare, mantenere, sospendere: tutte reversibili, tutte con le sicurezze di §9.

**Spec.** PLAN.md §9 (tutto), §8.6 (prima riga: esenzioni per le schede aperte
dall'estensione), §5.5 (righe "Tab groups" e "Discard").

**Cosa fare.**
- `src/core/actions.ts` (puro): costruzione delle voci `ArchivedTab` (niente favicon remote) e
  calcolo delle sicurezze (selezione che copre una finestra intera, scheda attiva della finestra
  corrente, più di 25 schede).
- `src/platform/tabs.ts`:
  - chiudi (archivia in batch, poi rimuovi);
  - annulla (`sessions.getRecentlyClosed` per URL → `restore`, altrimenti `tabs.create` con
    finestra e indice, poi reinserimento nel gruppo; su Firefox il gruppo si cerca per titolo);
  - mantieni (7 giorni o sempre), proteggi sito, sospendi, chiudi finestra, ripristina
    dall'archivio.
- Ogni scheda aperta o ripristinata dall'estensione viene registrata nelle esenzioni del guard.

**Perimetro.** `core/actions.ts`, `platform/tabs.ts`, test.

**Fatto quando.** Test puri sulle sicurezze. Test con `fakeBrowser` per ogni azione, inclusi
l'annulla senza voce in `getRecentlyClosed`, il gruppo che non esiste più e la scheda già
chiusa.

### M3.2 — Selezione, barra, toast e azioni di riga

L'utente seleziona, chiude e annulla dal pannello, con mouse o tastiera.

**Spec.** PLAN.md §4.3 (azioni di riga, header di sezione, barra di selezione, toast), §4.8
(`Space`, `Del`/`Backspace`, `K`, `Ctrl/Cmd+A`, `Ctrl/Cmd+Z`), §9 (Sicurezze: conferme inline,
mai `confirm()`).

**Cosa fare.**
- `state/selection.ts` e `state/undo.ts`.
- `SelectionBar` sticky (Chiudi N, Mantieni, Sospendi; "Raggruppa" arriva in M4.3).
- Conferme inline.
- `Toast` di 8 s: focusabile, non sparisce durante l'hover, `aria-live`.
- Azioni di riga su hover/focus.
- "Chiudi tutti (N)" e "Seleziona tutti" nelle sezioni.
- Scorciatoie da tastiera.

**Perimetro.** Componenti e state del pannello, i18n, test.

**Fatto quando.** Unit test su selezione e undo. Un E2E Chromium copre: chiusura di una
selezione, toast, Annulla; la conferma oltre 25 schede; la conferma per la scheda attiva; il
testo "Chiudi N schede e la finestra"; le scorciatoie.

### M3.3 — Vista Archivio e pulizia periodica

Tutto ciò che è stato chiuso si ritrova, si cerca e si ripristina; l'archivio non cresce senza
limite.

**Spec.** PLAN.md §4.5, §10 (cleanup ogni 6 h).

**Cosa fare.**
- `ArchiveView`: ricerca su titolo e URL; filtri per data e per origine; ripristino singolo e
  multiplo; elimina; svuota con conferma inline; esporta come lista Markdown di link negli
  appunti.
- Alarm di pulizia ogni 6 h nel background: archivio oltre conservazione o cap, keeps scaduti,
  record di attività orfani.

**Perimetro.** `ArchiveView`, pulizia nel background, i18n, test.

**Fatto quando.** Unit test su filtri, ricerca, export e pulizia (con `now` iniettato). Un E2E
Chromium copre ricerca, ripristino e svuota.

### M3.4 — Menu contestuali di pagina e scheda

"Mantieni sempre", "Proteggi sito" e "Consenti duplicati per questo sito" a un clic destro.

**Spec.** PLAN.md §4.1 (menu contestuale sulla pagina/scheda), §5.5 (riga "Menu contestuali").
I menu sull'icona legati al guard sono di M3b.3.

**Cosa fare.** `src/entrypoints/background/menus.ts`: le tre voci, contesti comuni (`page`, più
`tab` se esiste), registrazione su `onInstalled`, titoli i18n. "Consenti duplicati per questo
sito" aggiunge `*://<dominio>/*` alla whitelist.

**Perimetro.** `menus.ts`, registrazione nel background, test.

**Fatto quando.** Test con `fakeBrowser` per ogni voce. Aggiunta a MANUAL-CHECKS: "i menu
contestuali compaiono e funzionano su Chrome e Firefox".

### M3.5 — E2E delle azioni

L'accettazione di M3 verificata sull'estensione vera.

**Spec.** PLAN.md §13 M3 (accettazione), §14 (E2E: chiusura + annulla, mantieni, archivio).

**Cosa fare.**
- E2E Chromium:
  - chiudo 10 schede → Annulla → tornano tutte, stessa URL, stessa finestra;
  - l'archivio sopravvive a un riavvio del browser (rilancia il persistent context sullo stesso
    profilo);
  - "Mantieni" toglie la scheda dai suggerimenti, e la scheda ricompare quando il keep scade
    (simula il tempo scrivendo scadenze nello storage);
  - le sicurezze di §9.
- Smoke Firefox: chiusura + annulla.

**Perimetro.** Solo test (più le correzioni che i test rivelano, nello stesso commit).

**Fatto quando.** Tutti questi E2E passano nei gates.

## 7. PHASE M3b — Protezione duplicati

### M3b.1 — Decisione pura del guard

La funzione che decide quale scheda chiudere e quale tenere, coperta caso per caso.

**Spec.** PLAN.md §8.4 (tutto), §8.6 (filtri d'uscita), §8.3 (opzioni).

**Cosa fare.** `src/core/duplicate-guard.ts`: `resolveDuplicate(trigger, candidates, ctx)` come in
§8.4. Riusa `duplicateKey`, il comparatore di priorità di M1.4 e `patterns.ts`, senza
duplicarli.

**Perimetro.** `src/core/duplicate-guard.ts`, test.

**Fatto quando.** Almeno 30 casi di test: ogni filtro d'uscita, ogni regola di priorità e le loro
combinazioni, ambito finestra e tutte le finestre, fissate, scheda nuova vs scheda navigata
attiva, apertura in background, whitelist, regex non valida, `reloadKeptWith`, `move-activate`.

### M3b.2 — Guard live nel background

Il guard chiude i duplicati in tempo reale, senza mai chiuderne due a vicenda.

**Spec.** PLAN.md §8.1, §8.2, §8.5 (lampeggio del badge), §8.6 (tutti i casi limite), §5.5 (righe
`pendingUrl`, "Duplica scheda", container, schede nascoste), §11 (latenze).

**Cosa fare.** `src/entrypoints/background/guard.ts`:
- indice `Map<duplicateKey, Set<tabId>>` ricostruito al risveglio;
- coda seriale e una sola promise `ready`;
- `onCreated`/`onUpdated`/`onAttached`/`onReplaced`, con il percorso Firefox senza `pendingUrl`;
- esenzioni, grazia di 15 s all'avvio, pausa con alarm e `storage.session`;
- euristica "Duplica scheda" (solo Chrome);
- azioni dopo la chiusura, con l'eccezione dell'apertura in background;
- archivio con motivo `duplicate-auto` e riferimento alla scheda tenuta;
- `badge.flash()`.

**Perimetro.** `guard.ts`, registrazione nel background, test.

**Fatto quando.**
- Test con `fakeBrowser`: tutte le modalità; 20 aperture simultanee della stessa URL lasciano
  esattamente una scheda; esenzioni con TTL; grazia all'avvio; ritorno dalla pausa alla
  modalità precedente; Firefox senza `pendingUrl`; container; `onReplaced` che aggiorna l'indice
  senza chiudere nulla.
- Aggiunte a MANUAL-CHECKS: "'Duplica scheda' su Chrome stabile non viene chiusa (o il segnale
  inaffidabile è annotato in DECISIONS)" e "flussi di login con redirect non vengono interrotti".

### M3b.3 — Comandi e menu del guard

Scorciatoie e menu sull'icona per chiudere tutti i duplicati, mettere in pausa e riaprire
l'ultimo chiuso.

**Spec.** PLAN.md §4.1 (scorciatoie, menu sull'icona), §8.5 ("Ripristino rapido"), §8.7.

**Cosa fare.**
- Comandi `close-all-duplicates` (funziona anche in OFF e "Solo avvisi", archivia; l'annulla
  passa dal menu sull'icona) e `toggle-duplicate-guard`.
- Menu sull'icona:
  - "Riapri l'ultimo duplicato chiuso", con esenzione;
  - "…e consenti sempre duplicati per questo sito";
  - "Pausa protezione duplicati" 15 min / 1 h / fino al riavvio.

**Perimetro.** `menus.ts`, comandi nel background, i18n, test.

**Fatto quando.** Test con `fakeBrowser` per ogni comando e ogni voce di menu, inclusa la
riapertura che non viene richiusa dal guard.

### M3b.4 — Interfaccia del guard e whitelist

L'utente vede lo stato della protezione, la configura e incolla la whitelist che usa oggi.

**Spec.** PLAN.md §4.2 (chip "🛡 Duplicati" e contatore), §8.3 (tutta la sotto-pagina), §8.6
(avvisi: "Più recente", convivenza con Duplicate Tabs Closer), §8.7 ("Chiudi tutti" da
Riordina), §5.5 (opzioni nascoste su Firefox).

**Cosa fare.**
- `GuardChip`: stato, menu, contatore di 5 s.
- Una shell di impostazioni raggiungibile da ⚙ (il resto delle impostazioni è M6.1) con
  `DuplicateSettingsView`.
- `PatternListEditor`: validazione live per riga, anteprima "corrisponde a N schede aperte",
  spiegazione dell'import da Duplicate Tabs Closer, default per browser.
- Opzioni condizionate dalle capabilities: "Duplica scheda" solo su Chrome, container solo su
  Firefox.
- "Chiudi tutti i duplicati" nella sezione Duplicati di Riordina.

**Perimetro.** Componenti e viste del pannello, i18n, test.

**Fatto quando.** Unit test per l'editor (righe valide, non valide, anteprima). Un E2E Chromium
cambia la modalità dal chip e salva una whitelist. Unit test con capabilities mockate per le
opzioni nascoste.

### M3b.5 — E2E della protezione duplicati

L'accettazione di M3b, caso per caso, sull'estensione vera.

**Spec.** PLAN.md §13 M3b (accettazione, tutti i punti), §14 (E2E protezione duplicati).

**Cosa fare.**
- E2E Chromium per ogni punto di accettazione di M3b:
  - la seconda apertura si chiude in meno di 300 ms e la prima si attiva;
  - whitelist wildcard e regex;
  - pausa e ritorno alla modalità precedente;
  - Ctrl+clic senza cambio di focus;
  - Annulla non richiuso;
  - 20 aperture simultanee → ne resta una;
  - whitelist incollata in formato Duplicate Tabs Closer;
  - ambito finestra / tutte le finestre;
  - "Sposta e attiva";
  - "Più vecchia ricaricata";
  - regola della scheda attiva navigata.
- Smoke Firefox: guard su URL duplicata.

**Perimetro.** Solo test (più le correzioni che rivelano, nello stesso commit).

**Fatto quando.** Tutti questi E2E passano nei gates.

## 8. PHASE M4 — Organizza senza AI

### M4.1 — Raggruppamento per sito e per argomento

Proposte di gruppi deterministiche: per dominio e per argomento, senza AI.

**Spec.** PLAN.md §7.1, §7.2, §11 (clustering di 300 schede ≤ 50 ms).

**Cosa fare.** `src/core/cluster.ts`:
- per sito (minimo 3 schede, configurabile; nomi leggibili da una mappa; colore stabile da hash);
- per argomento: tokenizzazione con stopword IT/EN e rimozione dei suffissi del sito, TF-IDF con
  token di dominio, agglomerativo average linkage con soglia ~0,25, minimo 2, massimo 8 gruppi,
  "Altro";
- eseguito per finestra.

**Perimetro.** `src/core/cluster.ts`, test, benchmark.

**Fatto quando.** Test su determinismo, limiti (8 gruppi, minimo 2), nomi e colori stabili e
stopword. Benchmark: mediana ≤ 50 ms su `tabs-300`. Coverage di `core/` ≥ 95%.

### M4.2 — Applicazione e annullamento dei gruppi

I gruppi proposti diventano gruppi nativi, e l'annullamento rimette tutto esattamente com'era.

**Spec.** PLAN.md §7.4, §4.4 (punti 4–5 e ultimo), §5.5 (riga "Tab groups").

**Cosa fare.** In `src/platform/`:
- snapshot `{tabId, windowId, index, groupId}`;
- `tabs.group` per finestra + `tabGroups.update` (titolo, colore, collapsed);
- opzioni: ordina per gruppo, lascia fuori le fissate, includi i gruppi dell'utente;
- errori parziali riassunti in un messaggio;
- annulla: ungroup + indici e gruppi originali (su Firefox con fallback sul titolo).

**Perimetro.** Modulo platform per i gruppi, test.

**Fatto quando.** Test con `fakeBrowser`: applica → annulla ripristina esattamente ordine e
gruppi; scheda chiusa nel frattempo; gruppi dell'utente non toccati di default.

### M4.3 — Vista Organizza

Anteprima modificabile dei gruppi prima di applicarli.

**Spec.** PLAN.md §4.4 (tutto), §4.3 ("Raggruppa" nella barra di selezione), §11 (`import()`
dinamico).

**Cosa fare.**
- `OrganizeView` caricata con `import()`: ambito, modalità, anteprima `GroupPreview`.
- Modifiche nell'anteprima: rinomina inline, colore, deseleziona, "Sposta in…", unisci.
- Opzioni, Applica e toast con Annulla.
- "Raggruppa" dalla barra di selezione di Riordina porta la selezione nell'anteprima.

**Perimetro.** Vista, componenti, i18n, test.

**Fatto quando.** Unit test sulle modifiche all'anteprima (funzioni pure). Un E2E Chromium
copre: anteprima per sito → rinomina → Applica → gruppi nativi con titolo e colore → Annulla.

### M4.4 — Revisione dei cluster e E2E di Organizza

Il raggruppamento per argomento giudicato su dati realistici, e l'accettazione di M4 su entrambi
i browser.

**Spec.** PLAN.md §13 M4 (accettazione), §14 (E2E organizza).

**Cosa fare.**
- `docs/CLUSTER-REVIEW.md`: esegui il raggruppamento per argomento su `tabs-300` e giudica
  almeno 8 cluster (sensato / no / perché). Se il risultato è chiaramente scarso, tara la soglia
  in `cluster.ts` e annota.
- Completa gli E2E: Chromium "applica e annulla ripristinano esattamente ordine e gruppi";
  smoke Firefox "organizza per sito → annulla".

**Perimetro.** `docs/CLUSTER-REVIEW.md`, test, eventuale taratura.

**Fatto quando.** La revisione è scritta e gli E2E passano nei gates. Aggiunta a MANUAL-CHECKS:
"leggere CLUSTER-REVIEW.md e provare Organizza per argomento sulle proprie schede".

## 9. PHASE M5 — AI on-device

### M5.1 — Raggruppamento AI con LLM iniettato

La logica AI completa e testata con un modello finto: batching, schema, validazione, fallback.

**Spec.** PLAN.md §7.3 (prompt, schema, batch, validazione, nomi in italiano, "l'AI non decide
mai cosa chiudere").

**Cosa fare.** `src/core/ai-grouping.ts`:
- interfaccia LLM iniettata;
- input compatto `id|title|host`;
- `responseConstraint` con lo schema di §7.3;
- batch fino a ~40 con controllo del contesto e batch più piccolo su `QuotaExceededError`;
- oltre 40 schede, pre-clustering con `cluster.ts`;
- validazione (ID inventati scartati, mancanti in "Other", nessun duplicato) e fallback a §7.2.

La scelta sui nomi in italiano va annotata in DECISIONS.

**Perimetro.** `src/core/ai-grouping.ts`, test.

**Fatto quando.** Test con mock per: output valido, ID inventati, ID duplicati, JSON malformato,
quota superata, timeout, più di 40 schede.

### M5.2 — Adattatore Prompt API e integrazione

Su Chrome con Gemini Nano disponibile, Organizza per argomento usa l'AI; altrove non se ne
accorge nessuno.

**Spec.** PLAN.md §7.3 ("Rilevamento e stato", "Prestazioni"), §4.4 (badge "AI on-device"), §4.6
(riga AI), §5.5 (riga "AI on-device"), §11 (`import()`).

**Cosa fare.** Prima verifica l'API attuale su developer.chrome.com/docs/ai/prompt-api: le API
cambiano. Poi `src/platform/llm.ts`:
- stati di disponibilità;
- download solo su clic, con progresso;
- sessione lazy, riusata e distrutta alla chiusura del pannello;
- `AbortController`, timeout di 20 s con fallback.

Integra in Organizza e nello stato delle impostazioni. Con `caps.promptApi` falso l'opzione non
compare. Caricamento dinamico, così la build Firefox non lo paga.

**Perimetro.** `llm.ts`, vista Organizza, i18n, test.

**Fatto quando.** Test con `LanguageModel` mockato per ogni stato di disponibilità, timeout e
abort. Un E2E Chromium senza modello verifica che non compaiano errori e che si usi il fallback.
Aggiunta a MANUAL-CHECKS: "su questo PC, con il modello: gruppi per 40 schede in meno di 10 s
(oppure: hardware non supportato, fallback verificato)".

## 10. PHASE M6 — Impostazioni, rifinitura, accessibilità

### M6.1 — Impostazioni complete

Tutte le impostazioni di §4.6, inclusi i preferiti con permesso opzionale e la lingua.

**Spec.** PLAN.md §4.6, §6.4 (componente "Già nei preferiti"), §5.4 (`optional_permissions`).

**Cosa fare.**
- `SettingsView` completa.
- Il toggle "preferiti" chiede il permesso `bookmarks` dentro il gesto utente e attiva il
  segnale +10 nello scoring.
- Lingua automatica / IT / EN: `browser.i18n` non permette di cambiare lingua a runtime, quindi
  scegli il meccanismo (es. caricare il `messages.json` richiesto) e annotalo.

**Perimetro.** `SettingsView`, i18n, scoring (solo il collegamento ai preferiti), test.

**Fatto quando.** Unit test su ogni impostazione che cambia il comportamento del core. Un E2E
Chromium cambia lingua e soglia e ne vede l'effetto. Aggiunta a MANUAL-CHECKS: "toggle
preferiti: compare la richiesta di permesso (Chrome, Firefox)".

### M6.2 — Onboarding al primo avvio

Una sola schermata nel pannello che fa scegliere soglia e modalità del guard.

**Spec.** PLAN.md §17, §8.1 (default della modalità scelto in onboarding).

**Cosa fare.** Schermata unica al primo avvio, mai pagine aperte in automatico. Le scelte vengono
salvate nelle impostazioni. Il link "Hai una whitelist di Duplicate Tabs Closer?" apre l'editor.

**Perimetro.** Componente di onboarding, stato "onboarding completato", i18n, test.

**Fatto quando.** Un E2E Chromium copre: primo avvio → onboarding → scelte → "Inizia" → le
impostazioni riflettono le scelte → al riavvio del pannello l'onboarding non ricompare.

### M6.3 — Rifinitura visiva e icona definitiva

Stati vuoti, animazioni sobrie, movimento ridotto rispettato e un'icona leggibile a 16 px.

**Spec.** PLAN.md §4.3 (stato vuoto), §4.7 (movimento, icona).

**Cosa fare.**
- Animazioni di 150 ms e collasso in altezza alla chiusura, tutto disattivato con
  `prefers-reduced-motion`.
- Stati vuoti per tutte le viste.
- Icona: SVG sorgente più PNG 16/32/48/128 generati da uno script (dipendenza di sviluppo
  ammessa, da annotare), collegati al manifest.

**Perimetro.** CSS e componenti, `src/public/icon/`, script di generazione.

**Fatto quando.** Un E2E con `reducedMotion: 'reduce'` verifica che non ci siano transizioni. Le
icone sono generate in modo riproducibile e presenti nei due manifest.

### M6.4 — Audit di accessibilità e completezza i18n

Zero violazioni gravi di accessibilità e nessuna stringa dimenticata.

**Spec.** PLAN.md §13 M6 (accettazione), §4.8.

**Cosa fare.**
- `@axe-core/playwright` negli E2E Chromium su ogni vista (Riordina, Organizza, Archivio,
  Impostazioni, Protezione duplicati, Onboarding), in tema chiaro e scuro.
- Test: ogni chiave usata nel codice esiste in `en` e in `it`, nessuna chiave inutilizzata,
  nessuna stringa visibile scritta a mano (test o regola di lint: scegli e annota).

**Perimetro.** Test e correzioni di accessibilità.

**Fatto quando.** axe riporta zero violazioni "serious" e "critical" su tutte le viste, in
entrambi i temi. I test i18n passano. Aggiunte a MANUAL-CHECKS: "NVDA sulle azioni principali" e
"zoom al 200%".

## 11. PHASE M7 — Hardening e preparazione al rilascio

### M7.1 — E2E completi su entrambi i browser

Ogni flusso di §14 automatizzato, oppure esplicitamente nella checklist manuale.

**Spec.** PLAN.md §14 (E2E, E2E Firefox, unit per compatibilità, manuali).

**Cosa fare.** Confronta gli elenchi di §14 con i test esistenti e completa quelli che mancano.
Ciò che non si può automatizzare su Firefox va in MANUAL-CHECKS. Riunisci in MANUAL-CHECKS tutte
le voci manuali di §14 (Chrome e Firefox).

**Perimetro.** Test, MANUAL-CHECKS.

**Fatto quando.** Ogni voce di §14 corrisponde a un test che passa nei gates o a una voce in
MANUAL-CHECKS. L'elenco della corrispondenza è in `docs/TEST-COVERAGE.md`.

### M7.2 — Budget del bundle come gate

Le dimensioni del pacchetto diventano un controllo automatico.

**Spec.** PLAN.md §11 (budget JS), §13 M7 (`rollup-plugin-visualizer`).

**Cosa fare.**
- Report con `rollup-plugin-visualizer`.
- Script `size`: gzip del JS iniziale del pannello ≤ 60 KB (tldts escluso solo se annotato) e
  del background ≤ 15 KB, su entrambe le build.
- Aggiungi a `phasekit.json` il gate `{ "name": "bundle size", "cwd": ".", "run":
  "pnpm size" }`.

Se il budget è superato, ottimizza. Se è impossibile senza violare la spec, fermati e riporta.

**Perimetro.** Config di build, script `size`, `phasekit.json` (solo l'aggiunta del gate),
eventuali ottimizzazioni.

**Fatto quando.** `pnpm size` passa ed è un gate. Le misure sono annotate in DECISIONS.

### M7.3 — Documenti per gli store

Tutto il testo che serve per pubblicare, pronto da copiare nei form.

**Spec.** PLAN.md §12 (tutto), §8.6 (convivenza con Duplicate Tabs Closer).

**Cosa fare.**
- `docs/PRIVACY.md`.
- `docs/PERMISSIONS.md`: un permesso per riga, per browser, con il testo dell'avviso e la
  giustificazione.
- `docs/STORE_LISTING.md`: testi IT/EN per Chrome Web Store e AMO, riassunto AMO ≤ 250
  caratteri, single purpose.
- `docs/AMO_REVIEW.md`: sistema operativo, versione esatta di Node e pnpm, comandi di build,
  note per i revisori.
- `README.md` completo, `CHANGELOG.md`.

**Perimetro.** Solo documenti.

**Fatto quando.** I documenti esistono e sono coerenti con il manifest reale: un test o uno
script confronta l'elenco dei permessi in `PERMISSIONS.md` con i manifest buildati.

### M7.4 — Screenshot per gli store

Screenshot 1280×800 generati da script, rigenerabili a ogni versione.

**Spec.** PLAN.md §12.2 e §12.3 (materiali), §13 M7.

**Cosa fare.** Script che, con dati dimostrativi seminati, produce screenshot 1280×800 per
Riordina, Organizza, Protezione duplicati, Archivio e tema scuro: Chromium con Playwright,
Firefox con Puppeteer. Il pannello è stretto: componi lo screenshot (es. pannello a larghezza
reale dentro una cornice 1280×800) e annota il metodo. Output in `docs/store/`.

**Perimetro.** Script e immagini generate.

**Fatto quando.** Lo script gira da comando unico e produce le immagini alla dimensione
richiesta. Aggiunta a MANUAL-CHECKS: "rivedere gli screenshot prima dell'invio".

### M7.5 — Pacchetti e build riproducibile

Zip pronti per entrambi gli store, e la prova che AMO può ricostruire il pacchetto dai sorgenti.

**Spec.** PLAN.md §12.3 (sorgenti, build riproducibile, `minify: false` da valutare), §12.4.

**Cosa fare.**
- `pnpm zip` e `pnpm zip:firefox`. Lo zip dei sorgenti non contiene file minificati né
  generati (`.output/`, `node_modules/`, `.phasekit/`).
- Script che scompatta lo zip dei sorgenti in una cartella temporanea, esegue
  `pnpm install --frozen-lockfile && pnpm build:firefox` e confronta il risultato con lo zip
  dell'add-on.
- `release.yml` su tag `v*`, senza invio automatico agli store.
- Decidi su `minify: false` per Firefox e annota.

**Perimetro.** Config di zip, script di verifica, `.github/workflows/release.yml`.

**Fatto quando.** Lo script di riproducibilità passa in locale. `release.yml` è YAML valido.
**Nessun invio agli store** (è un passo manuale dell'utente, in MANUAL-CHECKS).

### M7.6 — Checklist di rilascio e audit finale

Il punto della situazione onesto: cosa è verificato, cosa resta all'utente.

**Spec.** PLAN.md §14 ("Checklist di rilascio"), §13 M7 (accettazione).

**Cosa fare.**
- `docs/RELEASE-CHECKLIST.md`: ogni voce di §14 con lo stato e la prova (comando eseguito e
  risultato) oppure il rimando a MANUAL-CHECKS.
- Audit: confronta `README.md`, `docs/` e `TASKS.md` con il codice e correggi ciò che è
  diventato falso.

**Perimetro.** Documenti.

**Fatto quando.** Ogni voce della checklist di §14 ha uno stato con una prova o un rimando. Non
resta nessuna affermazione nei documenti che il codice smentisca.

## 12. Ledger

Spuntato **nello stesso commit** del task, mai prima. `phasekit status` lo mostra accanto al
`git log`.

- [ ] M0.1 Toolchain e scheletro del progetto
- [ ] M0.2 Manifest per browser, capabilities e apertura del pannello
- [ ] M0.3 i18n e pannello "Hello" localizzato
- [ ] M0.4 Harness E2E Chromium
- [ ] M0.5 Harness E2E Firefox
- [ ] M0.6 CI GitHub Actions
- [ ] M1.1 Tipi e normalizzazione URL
- [ ] M1.2 Classificazione del tipo di pagina
- [ ] M1.3 Pattern della whitelist duplicati
- [ ] M1.4 Chiave di duplicato e scelta della scheda da tenere
- [ ] M1.5 Fixture etichettate (prima dello scoring)
- [ ] M1.6 Punteggio di inutilità
- [ ] M1.7 Storage tipizzato e versionato
- [ ] M1.8 Tracker dell'attività delle schede
- [ ] M2.1 Design token, shell del pannello e stato reattivo
- [ ] M2.2 Righe, sezioni e motivi
- [ ] M2.3 Navigazione da tastiera e ARIA
- [ ] M2.4 Badge sull'icona
- [ ] M2.5 Budget di apertura del pannello
- [ ] M3.1 Azioni sulle schede e sicurezze
- [ ] M3.2 Selezione, barra, toast e azioni di riga
- [ ] M3.3 Vista Archivio e pulizia periodica
- [ ] M3.4 Menu contestuali di pagina e scheda
- [ ] M3.5 E2E delle azioni
- [ ] M3b.1 Decisione pura del guard
- [ ] M3b.2 Guard live nel background
- [ ] M3b.3 Comandi e menu del guard
- [ ] M3b.4 Interfaccia del guard e whitelist
- [ ] M3b.5 E2E della protezione duplicati
- [ ] M4.1 Raggruppamento per sito e per argomento
- [ ] M4.2 Applicazione e annullamento dei gruppi
- [ ] M4.3 Vista Organizza
- [ ] M4.4 Revisione dei cluster e E2E di Organizza
- [ ] M5.1 Raggruppamento AI con LLM iniettato
- [ ] M5.2 Adattatore Prompt API e integrazione
- [ ] M6.1 Impostazioni complete
- [ ] M6.2 Onboarding al primo avvio
- [ ] M6.3 Rifinitura visiva e icona definitiva
- [ ] M6.4 Audit di accessibilità e completezza i18n
- [ ] M7.1 E2E completi su entrambi i browser
- [ ] M7.2 Budget del bundle come gate
- [ ] M7.3 Documenti per gli store
- [ ] M7.4 Screenshot per gli store
- [ ] M7.5 Pacchetti e build riproducibile
- [ ] M7.6 Checklist di rilascio e audit finale

## 13. PHASE F — Correzioni dalle verifiche manuali

Task aggiunti durante il lavoro, quando una verifica manuale trova un problema. Ognuno ha la
stessa forma degli altri: titolo `### F.<n> — …`, la verifica che l'ha fatto nascere, cosa
succede e cosa dovrebbe succedere (con le parole dell'utente), **Spec**, **Cosa fare**,
**Perimetro**, **Fatto quando**. Il "Fatto quando" include sempre un test automatico che
riproduce il problema, quando si può, e una nuova voce in MANUAL-CHECKS per riprovarlo a mano.
La riga del ledger va in fondo alla sezione 12 e il target in `autoSequence` subito dopo il task
in corso.
