# TabDeclutter: piano di progettazione e implementazione

> Documento da consegnare a Claude (o a un altro sviluppatore) per costruire l'estensione da zero.
> Descrive **cosa** costruire, **perché** e **come**, con criteri di accettazione per ogni fase.
> Identificatori, codice e nomi di file sono in inglese; la UI è bilingue (IT/EN).

---

## 0. Come usare questo documento (istruzioni per chi implementa)

1. Leggi tutto il documento prima di scrivere codice. Le sezioni 3 (principi) e 6 (algoritmo) sono vincolanti.
2. Implementa **una milestone alla volta** (sezione 13), nell'ordine. Ogni milestone deve chiudersi con test verdi e con i suoi criteri di accettazione soddisfatti, prima di passare alla successiva.
3. Se una API del browser si comporta diversamente da come è descritta qui (le API Chrome cambiano), verifica sulla documentazione ufficiale (developer.chrome.com), scegli la soluzione più semplice coerente con i principi e annota la decisione in `docs/DECISIONS.md`.
4. Non aggiungere funzionalità non elencate. L'estensione deve fare **poche cose, fatte bene**.

---

## 1. Problema e obiettivo

Chi lavora molto nel browser accumula decine (o centinaia) di schede. Molte diventano inutili: ricerche già concluse, duplicati, pagine aperte "per dopo" e mai rilette, pagine di login o di errore. Chiuderle a mano è noioso e si ha paura di perdere qualcosa.

**TabDeclutter** fa tre cose:

1. **Declutter (Riordina)**: individua in modo spiegabile le schede probabilmente inutili e le **suggerisce** visivamente, raggruppate per motivo ("Duplicati", "Non aperte da 9 giorni", "Pagine di ricerca"…). L'utente le chiude con un clic, e ogni chiusura è **reversibile** (archivio + annulla).
2. **Organize (Organizza)**: propone un'organizzazione delle schede rimaste in **gruppi di schede nativi di Chrome** (per sito o per argomento). Mostra un'anteprima modificabile e la applica solo dopo conferma.
3. **Duplicate Guard (Protezione duplicati)**: **impedisce in tempo reale** di aprire una scheda già aperta. Quando apri una URL già presente, la nuova scheda viene chiusa e si torna a quella esistente, salvo che la URL sia in whitelist. Sostituisce del tutto l'estensione *Duplicate Tabs Closer*, che l'utente oggi usa insieme alle altre: **una sola estensione al posto di due** (sezione 8).

### 1.1 Cosa esiste già e perché ha senso farla

| Strumento | Cosa fa | Limite |
|---|---|---|
| **Tab Wrangler** (open source, GPLv3) | Chiude automaticamente le schede inattive dopo N minuti e le mette in un "Tab Corral" ripristinabile | Agisce **alla cieca e da solo**: usa solo il tempo di inattività e non suggerisce né spiega niente |
| **Duplicate Tabs Closer** (open source) | Chiude automaticamente i duplicati, con priorità configurabili e whitelist (wildcard/regex) | Gestisce solo i duplicati: serve una seconda estensione per tutto il resto |
| **Chrome "Organizza schede simili"** (nativo, dal 2024) | Propone gruppi con nome ed emoji | Solo raggruppamento: non individua le schede inutili. Funziona bene per dominio e peggio per argomento |
| **Estensioni "AI tab manager"** (TabAutopilot, Tabnxt, ecc.) | Raggruppamento AI, snooze, sessioni, workspace | Spesso pesanti e piene di funzioni. Molte usano server/LLM remoti, quindi le URL lasciano il dispositivo. Le recensioni indipendenti le giudicano "sperimentali o poco affidabili" |

**Spazio libero**: uno strumento leggero e locale che **suggerisce e spiega** (senza agire in automatico), mette tutto in revisione con una sola schermata, rende ogni azione annullabile e poi aiuta a organizzare quello che resta. Nessun server, nessun account.

---

## 2. Ambito

### 2.1 In ambito (v1)
- **Due target di prima classe, pubblicati entrambi**:
  - **Chrome Web Store**: Chrome ≥ 121 (funziona anche su Edge/Brave/Vivaldi con lo stesso pacchetto);
  - **Firefox Add-ons (AMO)**: Firefox desktop ≥ 140, Manifest V3.
  Un'unica codebase, due build generate da WXT (sezione 5.5). Ogni funzionalità va implementata e testata su **entrambi** i browser. Le uniche differenze ammesse sono quelle elencate nella tabella della sezione 5.5.
- Pannello laterale (Side Panel) come interfaccia principale.
- Tracciamento locale dell'attività delle schede.
- Punteggio di "inutilità" spiegabile con regole deterministiche.
- Chiusura singola o di massa, "Mantieni", "Sospendi" (discard), archivio con ripristino, annulla.
- Organizzazione in gruppi: per dominio (deterministica), per argomento (euristica locale), con AI on-device opzionale (Gemini Nano tramite Prompt API).
- **Protezione duplicati in tempo reale** con le funzioni di Duplicate Tabs Closer usate davvero: modalità (solo segnala / chiudi automaticamente), comportamento sulla scheda rimasta, priorità (più vecchia / più recente / più vecchia + ricarica, HTTPS, fissate, scheda attiva, finestra attiva), ambito (finestra / tutte le finestre), regole di confronto URL, salta schede vuote, whitelist con `*` e `/regex/` (sezione 8).
- Badge sull'icona con il numero di schede suggerite.
- Impostazioni essenziali, i18n IT/EN, tema chiaro/scuro, accessibilità da tastiera.

### 2.2 Fuori ambito (v1), da NON implementare
- Chiusura automatica senza conferma, **tranne** la protezione duplicati quando l'utente la imposta su "Chiudi automaticamente".
- Funzioni avanzate di Duplicate Tabs Closer poco usate: duplicati per somiglianza del titolo, regole URL "Group/Normalize/Path depth", container Firefox, integrazione Tree Style Tab, temi multipli, layout a due colonne.
- Sincronizzazione cloud, account, backend, LLM remoti (OpenAI/Gemini API ecc.).
- Content script / lettura del contenuto delle pagine (niente `<all_urls>`).
- Sessioni/workspace salvati, snooze con sveglia, ricerca nella cronologia.
- Embedding con modelli scaricati (transformers.js): valutabile in v2 (sezione 15).
- Firefox per Android (niente tab groups né sidebar, `favIconUrl` non supportato) e Safari.

---

## 3. Principi di design (vincolanti)

1. **Suggerisci, non agire.** Nessuna scheda viene chiusa senza un gesto esplicito dell'utente. **Unica eccezione**: la protezione duplicati in modalità "Chiudi automaticamente", che è una regola scelta esplicitamente dall'utente e chiude solo duplicati esatti secondo le regole configurate. Anche queste chiusure finiscono in archivio e sono ripristinabili.
2. **Ogni suggerimento ha un motivo leggibile.** Niente punteggi opachi: l'utente vede "Duplicato di una scheda aperta", "Non la apri da 12 giorni", "Risultati di ricerca".
3. **Tutto è reversibile.** Ogni chiusura finisce in archivio. Le chiusure di massa hanno un "Annulla" immediato.
4. **Privacy totale.** Zero richieste di rete, zero analytics, nessun dato fuori dal dispositivo. L'AI, se presente, è solo on-device.
5. **Il core funziona senza AI.** L'AI migliora solo nomi e raggruppamenti per argomento ed è un'aggiunta opzionale. Gemini Nano richiede hardware alto (16 GB RAM o più di 4 GB VRAM, 22 GB liberi) e non supporta ufficialmente l'italiano, quindi non può essere un requisito.
6. **Leggerezza.** Service worker guidato da eventi (nessun polling), UI piccola, nessuna dipendenza pesante.
7. **Permessi minimi.** Ogni permesso deve essere giustificato in `docs/PERMISSIONS.md`.

---

## 4. Esperienza utente

### 4.1 Punti di ingresso
- **Clic sull'icona dell'estensione**: apre il pannello laterale. Nessun popup separato: un'unica superficie, meno codice.
  - Chrome: `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`;
  - Firefox: `browser.action.onClicked` → `browser.sidebarAction.toggle()`, chiamato **in modo sincrono** nel listener (Firefox lo permette solo dentro un gesto utente, prima di qualsiasi `await`).
- **Scorciatoia da tastiera**: `Alt+Shift+D` apre il pannello (`_execute_action` su Chrome, `_execute_sidebar_action` su Firefox).
- **Altre scorciatoie** (senza tasto predefinito, assegnabili da `chrome://extensions/shortcuts`): "Chiudi tutti i duplicati", "Pausa/riprendi protezione duplicati".
- **Menu contestuale sulla pagina/scheda**: "Mantieni sempre questa scheda", "Proteggi sempre questo sito", "Consenti duplicati per questo sito" (aggiunge `*://dominio/*` alla whitelist duplicati).
- **Menu contestuale sull'icona** (`contexts: ['action']`): "Riapri l'ultimo duplicato chiuso", "Pausa protezione duplicati (15 min / 1 h / fino al riavvio)".
- **Badge**: numero di schede nel bucket "Da chiudere" (es. `14`), colore neutro. Si può disattivare. Se il numero è 0 il badge non compare.

### 4.2 Struttura del pannello

```
┌─────────────────────────────────────────┐
│ TabDeclutter                       ⚙    │  header
│ 87 schede · 4 finestre   🛡 Duplicati: ON ▾│  chip stato protezione
│ ███████████░░░░░  23 da rivedere         │  "health bar"
├─────────────────────────────────────────┤
│ [ Riordina ]  [ Organizza ]  [ Archivio ]│  tab di navigazione
├─────────────────────────────────────────┤
│ ▾ Duplicati (4)            [Chiudi tutti]│
│   ☐ 🟦 GitHub – PR #812     github.com   │
│        Duplicato · 3 g                   │
│ ▾ Non aperte da più di 7 giorni (12)  [Chiudi tutti]│
│   ☐ 🟧 Come configurare …   blog.xyz     │
│        12 g fa · aperta 1 volta          │
│ ▸ Pagine di ricerca (5)                  │
│ ▸ Da valutare (9)                        │
├─────────────────────────────────────────┤
│ 17 selezionate   [Mantieni] [Chiudi 17] │  barra di selezione (sticky)
└─────────────────────────────────────────┘
```

**Chip "🛡 Duplicati"** nell'header: mostra lo stato (ON = chiusura automatica, Solo avvisi, In pausa fino alle 15:40, OFF). Il clic apre un menu con: cambio modalità, pausa (15 min / 1 h / fino al riavvio), "Chiudi tutti i duplicati ora (N)", "Impostazioni duplicati…". Sotto il chip compare per 5 s un contatore discreto "1 duplicato chiuso oggi · Vedi" quando ne viene chiuso uno.

### 4.3 Vista "Riordina" (Declutter)
- Le schede suggerite sono raggruppate per **motivo principale** (sezione 6.4), in sezioni comprimibili ordinate per "confidenza" (Duplicati, poi Pagine transitorie, poi Vecchie e mai rilette, poi Inattive, poi Da valutare).
- **Riga scheda** (densa, una o due righe):
  - checkbox, favicon 16 px (sezione 5.5: `_favicon` su Chrome, `favIconUrl` o avatar con iniziale su Firefox), titolo su una riga con ellissi, dominio in grigio;
  - chip con età ("12 g") e motivi secondari ("aperta 1 volta", "già nei preferiti");
  - azioni che compaiono su hover/focus: **Vai** (attiva scheda e finestra), **Mantieni** (escludi per 7 giorni), **Chiudi**.
- **Header di sezione**: conteggio, "Seleziona tutti", "Chiudi tutti (N)".
- **Suggerimento a livello di finestra**: se tutte le schede di una finestra sono "Da chiudere", mostra una card "Finestra con 12 schede non toccata da 3 settimane, [Chiudi finestra]".
- **Barra di selezione sticky** in basso, visibile solo se c'è una selezione: "Chiudi N", "Mantieni", "Sospendi" (libera memoria senza chiudere), "Raggruppa".
- **Toast di annullamento** dopo ogni chiusura: "17 schede chiuse · Annulla" (8 s, focusabile, non sparisce durante l'hover).
- **Stato vuoto**: illustrazione semplice + "Tutto in ordine. Nessuna scheda da rivedere."
- Il bucket "Da valutare" è chiuso di default; "Da chiudere" è aperto.

### 4.4 Vista "Organizza"
1. L'utente sceglie l'ambito: **Finestra corrente** (default) o **Tutte le finestre**.
2. Sceglie la modalità: **Per sito** (immediata) o **Per argomento** (euristica locale, oppure AI se disponibile; badge "AI on-device" quando attiva).
3. **Anteprima**: elenco dei gruppi proposti con nome modificabile inline, colore (palette dei gruppi Chrome), schede contenute. Si può deselezionare un gruppo, spostare una scheda tra gruppi (menu "Sposta in…", niente drag & drop in v1), unire due gruppi.
4. Opzioni: "Ordina le schede nella finestra per gruppo", "Comprimi i gruppi", "Lascia fuori le schede fissate".
5. **Applica** crea i gruppi nativi (`chrome.tabs.group` + `chrome.tabGroups.update`). Toast con "Annulla" che fa `ungroup` e ripristina gli indici originali (snapshot preso prima).
- Le schede già in un gruppo creato dall'utente **non vengono toccate** di default (opzione per includerle).

### 4.5 Vista "Archivio"
- Elenco delle schede chiuse tramite TabDeclutter: titolo, dominio, data di chiusura, motivo.
- Ricerca testuale (titolo + URL), filtro per data ("Oggi", "Ultimi 7 giorni", "Più vecchie") e per origine ("Chiuse da me", "Duplicati chiusi automaticamente").
- Azioni: Ripristina (singolo/multiplo), Elimina dall'archivio, Svuota archivio (con conferma inline, non `confirm()`), Esporta (copia come lista Markdown di link negli appunti).
- Conservazione: 30 giorni o 1000 voci (configurabile), pulizia tramite `chrome.alarms`.

### 4.6 Impostazioni (pannello ⚙ dentro il Side Panel, niente pagina options separata)
| Impostazione | Default | Note |
|---|---|---|
| Considera "vecchia" una scheda dopo | 7 giorni | 1 / 3 / 7 / 14 / 30 |
| Periodo di grazia per schede nuove | 2 ore | le schede aperte da poco non vengono mai suggerite |
| Siti protetti | lista vuota | pattern di dominio, es. `mail.google.com`, `*.atlassian.net` |
| Includi schede in gruppi | sì, con peso ridotto | |
| Ignora parametri `#hash` per i duplicati | sì | |
| Mostra badge | sì | |
| Usa AI on-device se disponibile | sì | mostra stato: disponibile / da scaricare / non supportata |
| Conservazione archivio | 30 giorni | |
| Lingua | automatica | IT/EN |
| **Sezione "Protezione duplicati"** | vedi sezione 8.3 | sotto-pagina dedicata con tutte le opzioni |

### 4.7 Linee guida visive
- **Stile**: pulito, denso ma arioso, simile alla UI nativa di Chrome (Material 3 "leggero"), senza librerie di componenti.
- **Tipografia**: `system-ui`, 13 px base, 12 px per i metadati, 15 px per i titoli di sezione, numeri tabulari per età/conteggi.
- **Colori**: design token in CSS custom properties. Neutri per lo sfondo e un solo accento (blu `#1a73e8` light / `#8ab4f8` dark). Colori semantici usati con parsimonia: rosso solo per "Elimina definitivamente", ambra per "Da valutare". Contrasto WCAG AA.
- **Tema**: `prefers-color-scheme` light/dark automatico.
- **Spaziatura**: scala 4 px (4/8/12/16/24).
- **Movimento**: comparsa/scomparsa delle righe a 150 ms ease-out, collasso altezza alla chiusura. Tutto disattivato con `prefers-reduced-motion`.
- **Icona estensione**: forma semplice e riconoscibile a 16 px (es. scheda stilizzata con una scintilla o una scopa minimal). SVG sorgente + PNG 16/32/48/128.
- **Larghezza**: il pannello va da circa 320 px a 600 px+. Layout fluido, nessun overflow orizzontale.

### 4.8 Accessibilità e tastiera
- Lista navigabile con frecce ↑/↓ (pattern roving tabindex), `Space` seleziona, `Enter` va alla scheda, `Del`/`Backspace` chiude, `K` mantiene, `Ctrl/Cmd+A` seleziona la sezione, `Ctrl/Cmd+Z` annulla l'ultima azione.
- Ruoli ARIA corretti (`listbox`/`option` o `grid`), `aria-live="polite"` per toast e conteggi.
- Focus ring visibile, target cliccabili di almeno 24 px.

---

## 5. Architettura tecnica

### 5.1 Stack
| Scelta | Motivo |
|---|---|
| **WXT** (ultima versione stabile, richiede Node 22) | Framework MV3 mantenuto attivamente e basato su Vite, con HMR per parte e build cross-browser. Plasmo è in maintenance mode |
| **TypeScript** strict | Correttezza, refactoring sicuro |
| **Preact + @preact/signals** | Circa 4 KB, API React familiare, reattività fine senza re-render inutili |
| **CSS puro con custom properties** (CSS Modules o un file per componente) | Nessun runtime CSS, bundle minimo |
| **tldts** (o equivalente leggero) | Calcolo corretto del dominio registrabile (eTLD+1) per raggruppare `docs.google.com` e `mail.google.com` in modo sensato |
| **Vitest** | Test unitari della logica pura |
| **Playwright** | E2E con l'estensione caricata in Chromium |
| **Puppeteer (WebDriver BiDi) + web-ext** | E2E di base su Firefox (`webExtension.install`), `web-ext lint` per la validazione AMO e `web-ext run` per lo sviluppo manuale |
| **ESLint + Prettier** | Qualità e coerenza |
| **pnpm** | Gestore pacchetti |

Nessun'altra dipendenza runtime senza una giustificazione in `docs/DECISIONS.md`.

### 5.2 Componenti

```
┌───────────────────────────┐        chrome.storage.local         ┌──────────────────────────────┐
│ Background service worker │ ─────── (activity, settings, ─────▶ │ Side Panel (Preact)          │
│ - activity tracker        │          archive, keeps)             │ - legge tabs + activity      │
│ - duplicate guard (live)  │                                      │                              │
│ - badge updater           │ ◀────── storage.onChanged ────────── │ - calcola punteggi (core/)   │
│ - context menus, commands │                                      │ - esegue azioni sulle tabs   │
│ - alarms (cleanup)        │                                      │ - AI on-device (Prompt API)  │
└───────────────────────────┘                                      └──────────────────────────────┘
              ▲                                                                ▲
              └──────────────── src/core/ (TypeScript puro, testato) ──────────┘
        scoring · url-normalize · classify · cluster · duplicate-guard · patterns · types
```

- **`core/`** è codice puro senza API del browser (dipendenze iniettate), condiviso da background e pannello e testato al 100% con Vitest.
- **Namespace unico `browser.*`** (fornito da WXT) in tutto il codice. `chrome.*` è consentito **solo** dentro `platform/` per le API esclusive di Chrome, sempre dietro feature detection (sezione 5.5).
- **Background (service worker)**: tracciamento eventi, **protezione duplicati** (deve funzionare anche a pannello chiuso, quindi vive qui), badge, menu e alarm. Nessuno stato tenuto solo in variabili globali, perché il service worker viene terminato dopo circa 30 s di inattività. Ogni handler rilegge lo stato da storage (con una cache in memoria invalidata su `storage.onChanged`).
- **Side Panel**: tutta la UI e tutte le azioni. Il pannello chiama direttamente `chrome.tabs`/`chrome.tabGroups` senza passare messaggi al background, così c'è meno codice e meno punti di rottura. Ascolta `chrome.tabs.on*` per aggiornarsi dal vivo (con debounce di 150 ms).
- **AI**: eseguita nel Side Panel (contesto documento, aperto quando serve) e non nel service worker, così il ciclo di vita resta semplice. Nessun offscreen document necessario.

### 5.3 Struttura del repository

```
tabdeclutter/
├─ wxt.config.ts
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ entrypoints/
│  │  ├─ background/
│  │  │  ├─ index.ts         # registrazione listener (sincrona, top-level)
│  │  │  ├─ tracker.ts       # attività schede (sezione 6.1)
│  │  │  ├─ guard.ts         # protezione duplicati live (sezione 8)
│  │  │  ├─ badge.ts
│  │  │  └─ menus.ts         # menu contestuali + commands
│  │  └─ sidepanel/
│  │     ├─ index.html
│  │     ├─ main.tsx
│  │     ├─ App.tsx
│  │     ├─ views/ (DeclutterView.tsx, OrganizeView.tsx, ArchiveView.tsx, SettingsView.tsx, DuplicateSettingsView.tsx)
│  │     ├─ components/ (TabRow.tsx, Section.tsx, SelectionBar.tsx, Toast.tsx, HealthBar.tsx, GuardChip.tsx, PatternListEditor.tsx, GroupPreview.tsx, EmptyState.tsx, Chip.tsx, Icon.tsx)
│  │     ├─ state/ (tabs.ts, selection.ts, undo.ts, ai.ts): signals e store
│  │     └─ styles/ (tokens.css, base.css)
│  ├─ core/
│  │  ├─ types.ts
│  │  ├─ url.ts              # normalizzazione URL, eTLD+1
│  │  ├─ classify.ts         # tipo di pagina (search, auth, blank, error…)
│  │  ├─ scoring.ts          # punteggio + motivi
│  │  ├─ duplicates.ts       # chiave di confronto + insiemi di duplicati (usato da Riordina e Guard)
│  │  ├─ duplicate-guard.ts  # decisione pura: quale scheda chiudere, quale tenere, cosa fare dopo
│  │  ├─ patterns.ts         # whitelist: wildcard `*` e `/regex/`, compilazione e validazione
│  │  ├─ cluster.ts          # raggruppamento per sito/argomento (senza AI)
│  │  ├─ ai-grouping.ts      # prompt + schema + merge (dipende da un'interfaccia LLM iniettata)
│  │  └─ time.ts
│  ├─ platform/              # wrapper sottili e tipizzati sulle API del browser
│  │  ├─ capabilities.ts     # feature detection Chrome/Firefox (sezione 5.5)
│  │  ├─ panel.ts            # apertura pannello: sidePanel (Chrome) / sidebarAction (Firefox)
│  │  ├─ storage.ts          # item tipizzati con versione e migrazioni (WXT storage.defineItem)
│  │  ├─ tabs.ts
│  │  ├─ favicon.ts
│  │  └─ llm.ts              # adattatore Prompt API → interfaccia core
│  └─ public/
│     ├─ icon/ (16, 32, 48, 128 png + svg)
│     └─ _locales/ (en/messages.json, it/messages.json)
├─ tests/
│  ├─ unit/ (url.test.ts, classify.test.ts, scoring.test.ts, duplicates.test.ts, duplicate-guard.test.ts, patterns.test.ts, cluster.test.ts, ai-grouping.test.ts)
│  ├─ fixtures/ (tabs-50.json, tabs-300.json, tabs-1000.json)
│  └─ e2e/ (declutter.spec.ts, organize.spec.ts, archive.spec.ts, duplicate-guard.spec.ts)
├─ docs/ (DECISIONS.md, PERMISSIONS.md, PRIVACY.md, STORE_LISTING.md, AMO_REVIEW.md)
├─ LICENSE (MIT) · CHANGELOG.md · README.md · .nvmrc
└─ .github/workflows/ (ci.yml, release.yml)
```

### 5.4 Manifest (generato da WXT, contenuto atteso)

Il manifest **non** si scrive a mano. È generato da `wxt.config.ts`, che lo specializza per browser con `manifest: ({ browser }) => ({ … })`.

**Build Chrome** (`.output/chrome-mv3/manifest.json`):

```jsonc
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "description": "__MSG_extDescription__",
  "default_locale": "en",
  "minimum_chrome_version": "121",          // Tab.lastAccessed
  "permissions": [
    "tabs",          // URL e titolo delle schede (avviso: "Leggere la cronologia di navigazione")
    "tabGroups",     // creare/modificare gruppi
    "storage",       // attività, archivio, impostazioni
    "sidePanel",     // interfaccia principale
    "alarms",        // pulizia archivio, refresh badge
    "favicon",       // icone delle schede da cache locale, nessuna richiesta di rete
    "sessions",      // ripristino con cronologia/scroll per "Annulla"
    "contextMenus"
  ],
  "optional_permissions": ["bookmarks"],    // segnale "già nei preferiti", richiesto solo se l'utente lo attiva
  "incognito": "not_allowed",
  "action": { "default_title": "__MSG_actionTitle__" },
  "side_panel": { "default_path": "sidepanel.html" },
  "commands": {
    "_execute_action": { "suggested_key": { "default": "Alt+Shift+D" } },
    "close-all-duplicates": { "description": "__MSG_cmdCloseDuplicates__" },
    "toggle-duplicate-guard": { "description": "__MSG_cmdToggleGuard__" }
  }
}
```
**Build Firefox** (`.output/firefox-mv3/manifest.json`), differenze rispetto a Chrome:

```jsonc
{
  "manifest_version": 3,
  "browser_specific_settings": {
    "gecko": {
      "id": "tabdeclutter@<dominio-o-nome-utente>",   // FISSO per sempre: identifica l'add-on su AMO
      "strict_min_version": "140.0",                  // tabGroups (139) + consenso dati integrato (140)
      "data_collection_permissions": { "required": ["none"] }   // obbligatorio per i nuovi add-on AMO
    }
  },
  "background": { "scripts": ["background.js"] },     // event page (WXT lo genera; niente service_worker)
  "permissions": ["tabs", "tabGroups", "storage", "alarms", "sessions", "menus"],
  // niente "sidePanel" né "favicon" (non esistono su Firefox)
  "optional_permissions": ["bookmarks"],
  "incognito": "not_allowed",
  "sidebar_action": {
    "default_panel": "sidepanel.html",
    "default_title": "__MSG_extName__",
    "open_at_install": false
  },
  "commands": {
    "_execute_sidebar_action": { "suggested_key": { "default": "Alt+Shift+D" } },
    "close-all-duplicates": { "description": "__MSG_cmdCloseDuplicates__" },
    "toggle-duplicate-guard": { "description": "__MSG_cmdToggleGuard__" }
  }
}
```

- La protezione duplicati **non richiede permessi aggiuntivi**: `tabs` basta (`tab.pendingUrl` dove esiste, `onCreated`, `onUpdated`, `remove`, `move`, `update`). Niente `webNavigation`.
- **Niente** `host_permissions`, niente content script, niente `<all_urls>`, su entrambi i browser.
- CSP di default MV3. Nessun codice remoto, nessun `eval`, nessun `new Function`: requisiti di entrambi gli store.

### 5.5 Compatibilità Chrome + Firefox

**Regola**: il codice applicativo chiede a `platform/capabilities.ts` cosa è disponibile e **non controlla mai il nome del browser**. Le build si separano solo dove WXT lo richiede (manifest, `import.meta.env.BROWSER` per l'apertura del pannello).

```ts
// platform/capabilities.ts: valutato una volta all'avvio di ogni contesto
export const caps = {
  sidePanel:        typeof chrome !== 'undefined' && !!chrome.sidePanel,     // Chrome
  sidebarAction:    !!browser.sidebarAction,                                 // Firefox
  faviconApi:       import.meta.env.BROWSER === 'chrome',                    // _favicon (Chrome)
  promptApi:        'LanguageModel' in globalThis,                           // Gemini Nano (Chrome)
  tabGroups:        !!browser.tabGroups,
  containers:       !!browser.contextualIdentities,                          // Firefox
  sessionTabValues: typeof browser.sessions?.setTabValue === 'function',     // Firefox
  duplicateCommandDetection: import.meta.env.BROWSER === 'chrome',
};
```

| Area | Chrome | Firefox | Cosa fare |
|---|---|---|---|
| Pannello | `side_panel` + `sidePanel` | `sidebar_action` + `sidebarAction` | Un solo entrypoint WXT `sidepanel`. Apertura tramite `platform/panel.ts` |
| Background | Service worker | Event page (non persistente) | Stesso codice. Nessuno stato solo in memoria, listener registrati al top-level (vale per entrambi) |
| Favicon | `/_favicon/?pageUrl=…&size=32` (cache locale) | `tab.favIconUrl` | Su Firefox: usa `favIconUrl` solo se `data:`. Altrimenti **avatar con iniziale del dominio** colorata (hash del dominio), per rispettare "zero richieste di rete". Nell'archivio non salvare favicon remote |
| `pendingUrl` | Sì (Chrome 79+) | Non affidabile o assente | Guard: su Firefox si decide al primo `onUpdated` con `changeInfo.url`. Latenza leggermente maggiore, accettabile |
| Tab groups | `tabs.group` + `tabGroups.update` | Stesse API (Firefox 138/139+), senza `tabGroups.create` (vale anche su Chrome) | Stesso codice. Su Firefox `sessions` non espone `groupId` e gli ID dei gruppi cambiano al riavvio: l'annullamento usa il titolo del gruppo come fallback |
| Colori gruppi | `grey…orange` | Stessi 9 nomi | Nessuna differenza |
| Riconciliazione dopo riavvio | Abbinamento per URL (sezione 6.1) | `sessions.setTabValue(tabId, 'td', {createdAt…})` **persiste attraverso i riavvii** | Su Firefox usa i tab value (affidabili), con l'abbinamento per URL come fallback |
| Discard | Cambia `tabId` (`onReplaced`) | `tabId` stabile | Il codice gestisce `onReplaced` se arriva, nessuna differenza logica |
| Container (Multi-Account) | — | `tab.cookieStoreId` | Due schede con la stessa URL **in container diversi non sono duplicati** (sono sessioni/account diversi). La chiave di duplicato include `cookieStoreId` se presente |
| Schede nascoste (`tab.hidden`) | — | Sì (altre estensioni le nascondono) | Escluse da Riordina, Organizza e Guard |
| "Duplica scheda" intenzionale | Euristica (sezione 8.6) | Non rilevabile in modo affidabile | Opzione nascosta su Firefox (come fa Duplicate Tabs Closer) |
| AI on-device | Prompt API / Gemini Nano | Non disponibile | Organizza per argomento usa l'euristica TF-IDF (sezione 7.2). L'opzione AI non viene mostrata |
| Menu contestuali | `contextMenus` | `menus` (alias `contextMenus` disponibile) | Usare `browser.contextMenus` con i soli `contexts` comuni: `page`, `tab` (solo Firefox, aggiunto se presente), `action` |
| Pagine interne | `chrome://`, `chrome-extension://` | `about:`, `moz-extension://` | `core/classify.ts` e i default della whitelist coprono entrambi (`about:newtab`, `about:home`, `about:blank`, `about:addons`…) |
| i18n | `_locales` | `_locales` | Identico |
| `storage.session` | Sì | Sì (Firefox 115+) | Identico |

Tutte le differenze sopra devono avere un test (unit con capabilities mockate) o una voce nella checklist manuale Firefox (sezione 14).

---

## 6. Il cuore: rilevare le schede inutili

### 6.1 Dati raccolti per ogni scheda

Fonte: API `chrome.tabs` + tracker proprio. Il tracker serve perché `Tab.lastAccessed` diventa `undefined` quando una scheda viene sospesa (discarded), non è presente negli oggetti tab passati agli eventi, e l'ID della scheda cambia al discard (`onReplaced`).

```ts
// core/types.ts
interface TabActivity {
  tabId: number;
  url: string;              // ultimo URL noto (per la riconciliazione dopo un riavvio)
  createdAt: number;        // ms epoch
  lastActiveAt: number;     // ultima volta in primo piano
  activations: number;      // quante volte è stata attivata
  foregroundMs: number;     // tempo cumulativo in primo piano (approssimato)
}
```

Eventi tracciati nel background:
| Evento | Azione |
|---|---|
| `tabs.onCreated` | crea il record (`createdAt = now`) |
| `tabs.onActivated` | chiude il "periodo di foreground" della scheda precedente, `activations++`, `lastActiveAt = now` |
| `windows.onFocusChanged` | sospende/riprende il conteggio del foreground (`WINDOW_ID_NONE` = browser non in primo piano) |
| `tabs.onUpdated` (url cambiato) | aggiorna `url`. Una navigazione in una scheda attiva conta come attività |
| `tabs.onReplaced` | migra il record dal vecchio al nuovo `tabId` (discard/prerender) |
| `tabs.onRemoved` | elimina il record |
| `runtime.onStartup` | **riconciliazione**: gli ID cambiano al riavvio del browser. Abbina i record salvati alle schede attuali per URL (multiset, a parità di URL vince l'ordine di finestra/indice). I record non abbinati si scartano. **Su Firefox** si usa prima `sessions.getTabValue`, che sopravvive al riavvio (sezione 5.5) |
| `runtime.onInstalled` | inizializza i record per tutte le schede esistenti usando `tab.lastAccessed` se presente, altrimenti `now` (e segna `bootstrapped: true` per non suggerirle subito) |

- Valore effettivo usato: `lastActive = max(record.lastActiveAt, tab.lastAccessed ?? 0)`.
- Scritture su `storage.local` con **debounce di 1–2 s** e coalescenza. Mai una scrittura per evento.
- Il foreground è approssimato: niente polling. Se il sistema va in idle si può usare opzionalmente `chrome.idle` (non in v1, per evitare un permesso in più).

### 6.2 Normalizzazione URL (`core/url.ts`)
- Host minuscolo, rimozione di `www.`, porta di default rimossa.
- Rimozione dei parametri di tracking: `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`, `_ga`, `si` (YouTube share), `spm`.
- Parametri di query ordinati alfabeticamente. Hash rimosso (configurabile, con eccezione per le SPA con routing in hash: se il path è `/` e l'hash inizia con `#/` va mantenuto).
- Slash finale rimosso (tranne per la root).
- `registrableDomain()` tramite tldts.
- Test con almeno 40 casi.
- **Chiave di duplicato unica** (`core/duplicates.ts` → `duplicateKey(url, matchOptions)`): la stessa funzione e le stesse opzioni di confronto (sezione 8.3) valgono **sia** per la sezione "Duplicati" di Riordina **sia** per la protezione live. Una sola definizione di "duplicato" in tutta l'estensione, quindi nessun comportamento incoerente.

### 6.3 Classificazione del tipo di pagina (`core/classify.ts`)
Regole basate solo su URL e titolo, nessun accesso al contenuto:

| Classe | Esempi di regola |
|---|---|
| `blank` | `chrome://newtab`, `about:blank`, `edge://newtab`, URL vuoto |
| `search` | host di motori noti (google.*, bing.com, duckduckgo.com, ecosia.org, search.brave.com, yahoo, yandex, startpage, kagi) con path `/search` o parametro `q`/`p`/`query`; anche le ricerche interne di siti noti (YouTube `/results`, Amazon `/s`, GitHub `/search`) |
| `auth` | path con `login`, `signin`, `sign-in`, `oauth`, `callback`, `sso`, `auth`, `logout`; host `accounts.google.com`, `login.microsoftonline.com` |
| `error` | titolo che corrisponde a pattern multilingua: "404", "Not Found", "Pagina non trovata", "This site can't be reached", "Impossibile raggiungere il sito", "Access denied", ecc. **Confidenza bassa**: solo come motivo secondario |
| `browser-internal` | `chrome://`, `edge://`, `chrome-extension://` (escluse le pagine di TabDeclutter): `downloads`, `settings`, `extensions`, `history` |
| `file` | `file://` (es. PDF già scaricato) |
| `media` | URL di immagini/PDF diretti (`.png`, `.jpg`, `.pdf`…) |
| `content` | tutto il resto (default) |

Le liste di host e pattern vivono in un unico file dati (`core/rules.ts`) facile da estendere.

### 6.4 Punteggio (`core/scoring.ts`)

Funzione pura: `scoreTabs(tabs, activity, settings, now, context) → ScoredTab[]`.

```ts
interface ScoredTab {
  tabId: number;
  score: number;                 // 0–100
  bucket: 'close' | 'review' | 'keep';
  primaryReason: ReasonCode;     // determina la sezione nella UI
  reasons: Reason[];             // tutti i motivi, con dati per il testo i18n
  protectedBy?: ProtectionCode;  // se protetta, il motivo
}
```

**Passo 1: protezioni (score = 0, bucket `keep`, mai suggerita):**
- scheda **fissata** (pinned);
- scheda che **riproduce audio** (`audible`) o in condivisione schermo/registrazione;
- scheda **attiva** in qualsiasi finestra;
- aperta da meno del **periodo di grazia** (default 2 h) o inizializzata al primo avvio (`bootstrapped`) da meno di 24 h;
- dominio nella lista dei **siti protetti**;
- marcata **"Mantieni"** e non ancora scaduta (chiave: URL normalizzato, scadenza 7 giorni o "per sempre");
- pagine di TabDeclutter stesse.

**Passo 2: regole forti (sovrascrivono):**
- **Duplicato** (stessa `duplicateKey`): per ogni insieme di duplicati la scheda da **mantenere** si sceglie con le stesse regole di priorità della protezione live (sezione 8.4). Le altre ricevono `score = 95`, motivo `duplicate`. Le URL in whitelist duplicati non vengono mai segnalate come duplicato.
- **Pagina vuota** (`blank`) non attiva: `score = 90`, motivo `blank`.

**Passo 3: punteggio additivo (troncato a 100):**

| Componente | Peso | Formula |
|---|---|---|
| Inattività | 0–55 | `55 * clamp(log(1 + idleH / 24) / log(1 + staleDays), 0, 1)`: cresce in fretta nei primi giorni e satura a `staleDays` |
| Pagina transitoria (`search`, `auth`, `error`, `browser-internal`) | +25 (`error` +15) | solo se inattiva da più di 1 h |
| Basso coinvolgimento | +15 | `activations ≤ 1` e `foregroundMs < 15 s` (aperta "per dopo" e mai letta) |
| Quasi-duplicato | +15 | stesso path e host, query diversa, oppure stessa pagina con hash diverso |
| Già nei preferiti (permesso opzionale) | +10 | "La ritrovi nei preferiti" |
| Già sospesa da Chrome (`discarded`) | +5 | Chrome stesso l'ha giudicata poco importante |
| In un gruppo creato dall'utente | ×0.6 | moltiplicatore finale (se l'opzione "includi gruppi" è attiva) |
| Finestra "dimenticata" (tutte le schede inattive da più di `staleDays`) | +10 | |

**Bucket**: `score ≥ 70` → `close` ("Da chiudere"), `40–69` → `review` ("Da valutare"), `< 40` → `keep` (non mostrata).

**Motivo principale** (sezione UI), in ordine di priorità: `duplicate` > `blank` > `transient` (search/auth/error) > `stale-unread` (inattiva e basso coinvolgimento) > `stale` (inattiva) > `review`.

**Testi dei motivi (i18n)**, esempi:
- "Duplicato di un'altra scheda aperta"
- "Non la apri da 12 giorni"
- "Aperta 1 volta, letta per pochi secondi"
- "Risultati di ricerca già consultati"
- "Pagina di accesso/reindirizzamento"
- "Già salvata nei preferiti"

**Requisiti non funzionali dello scoring:**
- Complessità O(n) (più O(n) per il raggruppamento dei duplicati tramite mappa). 1000 schede in meno di 15 ms su hardware medio (test di benchmark in Vitest).
- Deterministico: stessi input producono stesso output (`now` iniettato).
- Pesi e soglie centralizzati in `core/scoring.config.ts` per poterli tarare.

### 6.5 Taratura
- Creare fixture realistiche (`tests/fixtures/tabs-300.json`) con etichetta attesa per ogni scheda ("dovrebbe essere suggerita" sì/no).
- Un test di regressione calcola **precisione** (tra le suggerite in `close`, quante sono davvero inutili) con target ≥ 0,9. Un falso positivo costa più di un falso negativo: meglio suggerire meno ma giusto.

---

## 7. Organizzazione automatica

### 7.1 Per sito (deterministica)
- Raggruppa per `registrableDomain`. Crea un gruppo solo se il dominio ha **almeno 3 schede** (configurabile). Le altre restano fuori dai gruppi.
- Nome del gruppo: nome leggibile del sito (es. `github.com` → "GitHub"), da una piccola mappa di nomi noti con fallback al dominio senza TLD capitalizzato.
- Colore stabile: hash del dominio → uno dei colori `chrome.tabGroups.Color` (`grey, blue, red, yellow, green, pink, purple, cyan, orange`).

### 7.2 Per argomento senza AI (`core/cluster.ts`)
Algoritmo leggero e deterministico:
1. **Tokenizzazione** di titolo + path URL: minuscolo, split su non-alfanumerici, rimozione di stopword IT/EN (lista inclusa), token di lunghezza ≥ 3, rimozione dei suffissi del sito nel titolo (" - YouTube", " | Medium").
2. **Vettori TF-IDF** calcolati sull'insieme delle schede aperte, con un token extra per il dominio a peso moderato.
3. **Clustering agglomerativo** con similarità coseno e average linkage, soglia ~0,25 (configurabile). Con n ≤ 500 il costo O(n²) è accettabile (meno di 50 ms).
4. Cluster con meno di 2 schede finiscono in "Altro" (non raggruppate).
5. **Nome del gruppo**: i 1–2 token con TF-IDF più alto nel cluster, capitalizzati (es. "Rust · Async").
6. Limite: al massimo 8 gruppi. I cluster più piccoli vengono fusi in "Altro".

### 7.3 Per argomento con AI on-device (opzionale, `core/ai-grouping.ts` + `platform/llm.ts`)
**API**: Prompt API di Chrome (`LanguageModel`, Gemini Nano), stabile nelle estensioni da Chrome 138. **Solo Chrome**: su Firefox `caps.promptApi` è falso, l'opzione AI non compare e si usa sempre 7.2. Il modulo AI viene caricato con `import()` dinamico, così nella build Firefox non pesa sull'avvio.

**Rilevamento e stato:**
```ts
if (!('LanguageModel' in self)) → 'unsupported'
await LanguageModel.availability({ expectedInputs:[{type:'text',languages:['en']}], expectedOutputs:[{type:'text',languages:['en']}] })
// 'unavailable' | 'downloadable' | 'downloading' | 'available'
```
- `downloadable`: nelle impostazioni/vista Organizza mostra "Attiva AI on-device (download unico di diversi GB gestito da Chrome)". Il download parte **solo su clic esplicito** (serve user activation) e il progresso si mostra con `monitor` → `downloadprogress`.
- `unavailable` o `unsupported`: l'opzione AI è nascosta e si usa l'algoritmo 7.2 senza messaggi invasivi (solo una nota nelle impostazioni).

**Prompt** (in inglese, perché le lingue supportate ufficialmente sono en/ja/es/de/fr; i titoli in italiano vengono comunque passati come dati):
- System prompt: "You organize browser tabs into a small number of topical groups. Group by the user's task or topic, not by website. Use short group names (1–3 words). Prefer 3–8 groups. Tabs that fit nowhere go to 'Other'."
- Input: lista compatta `id|title|host` (titolo troncato a 80 caratteri).
- **Output vincolato** con `responseConstraint` (JSON Schema):
  ```json
  { "type":"object","properties":{"groups":{"type":"array","maxItems":8,"items":{"type":"object",
    "properties":{"name":{"type":"string","maxLength":24},"tabIds":{"type":"array","items":{"type":"integer"}}},
    "required":["name","tabIds"]}}},"required":["groups"] }
  ```
- **Batch**: massimo ~40 schede per prompt, controllando `session.contextUsage`/`contextWindow` e gestendo `QuotaExceededError` con un batch più piccolo. Per più di 40 schede: pre-clustering con 7.2 in macro-cluster, poi AI per affinare e nominare ciascun macro-cluster.
- **Validazione** dell'output: ogni ID deve esistere ed essere assegnato una sola volta. Gli ID mancanti vanno in "Other", quelli inventati si scartano. Se il parse fallisce, fallback a 7.2.
- **Nomi in italiano**: se la UI è in italiano, chiedere nomi brevi in inglese oppure tradurre con il **Translator API** solo se disponibile. Approccio v1: chiedere nomi in inglese e consentire la modifica inline nell'anteprima. Annotare la scelta in `DECISIONS.md`.
- **Prestazioni**: sessione creata lazy alla prima richiesta, riusata, distrutta alla chiusura del pannello. Spinner con "Annulla" (`AbortController` → `signal`). Timeout di 20 s, poi fallback.
- L'AI non decide **mai** cosa chiudere: serve solo a raggruppare e nominare.

### 7.4 Applicazione dei gruppi
- Snapshot pre-applicazione `{tabId, windowId, index, groupId}[]` per l'annullamento.
- Per ogni gruppo: `chrome.tabs.group({ tabIds, createProperties:{ windowId } })` → `chrome.tabGroups.update(groupId, { title, color, collapsed })`.
- Le schede di finestre diverse non vengono spostate tra finestre: un gruppo per finestra, cioè il clustering è eseguito per finestra quando l'ambito è "Tutte le finestre". In alternativa si offre l'opzione esplicita "Unisci tutto nella finestra corrente".
- Gestire gli errori (scheda chiusa nel frattempo): applicare quello che si può e riportare un messaggio sintetico.

---

## 8. Protezione duplicati in tempo reale (Duplicate Guard)

Obiettivo: replicare in TabDeclutter le funzioni di *Duplicate Tabs Closer* che servono davvero, con comportamento prevedibile, così l'utente può disinstallare l'altra estensione.

### 8.1 Modalità
| Modalità | Comportamento |
|---|---|
| **OFF** | Nessun controllo live. I duplicati compaiono comunque in Riordina → "Duplicati" |
| **Solo avvisi** | Nessuna chiusura. Badge e sezione "Duplicati" aggiornati in tempo reale |
| **Chiudi automaticamente** | Appena una scheda diventa duplicato di un'altra (in base a regole e priorità) viene chiusa la scheda "perdente" |
| **In pausa** | Stato temporaneo (15 min / 1 h / fino al riavvio), poi torna alla modalità precedente. Gestito con `chrome.alarms` e stato in `storage.session` |

Default al primo avvio: **scelto dall'utente nell'onboarding** (sezione 17), con "Chiudi automaticamente" preselezionato.

### 8.2 Quando scatta il controllo (background)
| Evento | Caso |
|---|---|
| `tabs.onCreated` | Nuova scheda: usa `tab.pendingUrl ?? tab.url`. Se vuota, `chrome://newtab` o `about:newtab`/`about:blank` (caso tipico su Firefox, dove manca `pendingUrl`), aspetta il primo `onUpdated` con `url` |
| `tabs.onUpdated` con `changeInfo.url` | Navigazione di una scheda esistente verso una URL già aperta altrove, oppure nuova scheda che riceve la sua URL |
| `tabs.onAttached` | Scheda spostata in un'altra finestra (rilevante con ambito "finestra") |

- **Indice in memoria** `Map<duplicateKey, Set<tabId>>`, ricostruito con un `tabs.query({})` al risveglio del service worker (meno di 5 ms per 500 schede) e aggiornato incrementalmente sugli eventi. Chiave calcolata su `url || pendingUrl`.
- **Coda seriale**: tutti gli eventi del guard passano da una coda promise-based. Due schede uguali aperte nello stesso istante non devono mai chiudersi a vicenda (ne resta sempre esattamente una).
- **Latenza target**: decisione e chiusura entro 50 ms dall'evento, così l'utente quasi non vede la scheda duplicata.
- **Listener registrati in modo sincrono al top-level** del service worker (requisito MV3). Impostazioni e indice vengono caricati con una sola promise `ready` attesa da ogni handler.

### 8.3 Impostazioni (sotto-pagina "Protezione duplicati")

**Comportamento**
| Opzione | Valori | Default |
|---|---|---|
| Quando viene rilevato un duplicato | OFF / Solo avvisi / Chiudi automaticamente | scelto in onboarding |
| Sulla scheda rimasta | Nessuna azione / **Attivala** / Spostala nella posizione della scheda chiusa e attivala | Attivala |
| Ambito | **Stessa finestra** / Tutte le finestre | Tutte le finestre |

**Priorità ed esclusioni** (decidono quale scheda resta, sezione 8.4)
| Opzione | Default |
|---|---|
| Quale tenere: **Più vecchia** / Più recente / Più vecchia ricaricata con la nuova URL | Più vecchia |
| Preferisci la scheda HTTPS (e considera `http`/`https` equivalenti) | ✔ |
| Mantieni la scheda fissata | ✔ |
| Mantieni la scheda attiva (quella su cui stai lavorando) | ✔ |
| Preferisci la finestra attiva (solo con ambito "Tutte le finestre") | ✔ |
| Ignora schede vuote (`about:blank`, nuova scheda) | ✔ (sempre vero per `chrome://newtab`) |
| Ignora pagine di login/OAuth (classe `auth`, sezione 6.3), per non rompere i flussi di accesso | ✔ |
| Consenti duplicati creati intenzionalmente con "Duplica scheda" di Chrome | ✔ (vedi 8.6). **Solo Chrome**: nascosta su Firefox |
| Considera i container separati (solo Firefox): la stessa URL in container diversi non è un duplicato | ✔ |

**Confronto URL** (definisce cosa conta come duplicato, condiviso con Riordina)
| Opzione | Default |
|---|---|
| Ignora maiuscole/minuscole nella URL | ✘ |
| Ignora `www.` | ✔ |
| Ignora `#hash` (con eccezione per le route SPA `#/…`) | ✔ |
| Ignora parametri di tracking (`utm_*`, `fbclid`…) | ✔ |
| Ignora tutti i parametri di query | ✘ |
| Ignora il path (confronta solo il dominio) | ✘ (con avviso: "molto aggressivo") |

**Whitelist duplicati** (URL per cui i duplicati sono sempre consentiti)
- Editor a righe (`PatternListEditor`): un pattern per riga, `*` = qualsiasi sequenza di caratteri, righe racchiuse in `/…/` = espressione regolare. È **compatibile con la sintassi di Duplicate Tabs Closer**, quindi l'utente può incollare la whitelist che usa oggi. È anche presente il pulsante "Importa da Duplicate Tabs Closer", che spiega di copiare e incollare il testo: un'estensione non può leggere i dati di un'altra.
- Validazione live riga per riga: le regex non valide vengono evidenziate con il messaggio d'errore e ignorate (mai un crash). Lunghezza massima 500 caratteri per pattern.
- Anteprima: "Questa regola corrisponde a 3 schede aperte" sotto ogni riga (aiuta a capire se il pattern è giusto).
- Default precompilati per browser:
  - Chrome: `chrome://newtab`, `about:blank`, `chrome://extensions*`, `chrome-extension://*`;
  - Firefox: `about:newtab`, `about:home`, `about:blank`, `about:addons`, `moz-extension://*`.
- Pattern compilati una volta sola (`core/patterns.ts` → `compile(patterns) → (url) => boolean`) e ricompilati solo su `storage.onChanged`.

### 8.4 Algoritmo di decisione (`core/duplicate-guard.ts`, funzione pura)

```ts
resolveDuplicate(trigger: TabInfo, candidates: TabInfo[], ctx: {
  settings: GuardSettings; activeTabIds: Set<number>; focusedWindowId: number; now: number;
}) → null | { closeTabId: number; keepTabId: number; after: 'none' | 'activate' | 'move-activate'; reloadKeptWith?: string }
```

1. **Filtri d'uscita (return `null`)**: modalità ≠ "Chiudi automaticamente" (o in pausa). URL in whitelist, vuota, `auth` (se attivo), `chrome://`/`chrome-extension://`. Scheda in incognito. Scheda creata dall'estensione stessa (8.6). Duplicato intenzionale (8.6). Nessun candidato con la stessa `duplicateKey` nell'ambito.
2. Se ci sono più candidati, si confronta il trigger con il **candidato migliore** (stesse regole sotto) e si chiude sempre **una sola** scheda per evento.
3. **Ordine di priorità** per scegliere quale scheda tenere (la prima regola che distingue vince):
   1. scheda **fissata**;
   2. scheda **attiva** su cui l'utente sta lavorando: vale solo quando *una scheda esistente viene navigata* (es. digito nella barra degli indirizzi una URL già aperta altrove) e quella scheda è attiva. In quel caso resta lei e si chiude l'altra. **Una scheda appena creata non conta come "attiva"** per questa regola, altrimenti ogni link aperto in primo piano chiuderebbe la scheda vecchia (comportamento poco intuitivo di altre estensioni);
   3. scheda **HTTPS** (se l'opzione è attiva);
   4. regola di **età**: più vecchia (`createdAt` minore) / più recente / più vecchia + `reloadKeptWith = trigger.url` (la scheda vecchia carica la URL nuova, utile quando la differenza è solo in parti ignorate come query o hash);
   5. **finestra attiva** (solo ambito "Tutte le finestre").
4. **Azione dopo la chiusura**:
   - "Attivala": `tabs.update(keep, { active: true })` + `windows.update(keep.windowId, { focused: true })`. **Eccezione**: se la scheda chiusa era stata aperta **in background** (es. clic con rotella o Ctrl+clic, cioè `active === false` alla creazione), non si sposta il focus: l'utente non voleva cambiare scheda;
   - "Sposta e attiva": `tabs.move(keep, { windowId: closed.windowId, index: closed.index })` e poi attiva;
   - `reloadKeptWith`: `tabs.update(keep, { url })`.
5. La scheda chiusa va in **archivio** con motivo `duplicate-auto` e riferimento alla scheda mantenuta, così è ripristinabile.

Tutta la tabella di casi va coperta da test unitari (almeno 30 casi: ogni regola, ogni combinazione di priorità, ambiti, finestre, fissate, attiva/background, whitelist, regex invalida).

### 8.5 Feedback all'utente (non invasivo)
- **Nessuna notifica di sistema** di default: chiudere un duplicato è un'operazione frequente e notificarla ogni volta sarebbe rumore. L'utente vede comunque il risultato, perché la scheda esistente viene attivata.
- Il badge lampeggia brevemente (cambio colore per 1,5 s) a ogni chiusura automatica.
- Nel pannello (se aperto) compare il contatore della sezione 4.2. L'archivio ha il filtro "Duplicati chiusi automaticamente".
- **Ripristino rapido**: menu sull'icona "Riapri l'ultimo duplicato chiuso", che riapre la scheda e la **esenta** dal guard (vedi 8.6), più l'opzione "…e consenti sempre duplicati per questo sito".

### 8.6 Casi limite da gestire esplicitamente
| Caso | Comportamento |
|---|---|
| Schede aperte/ripristinate **dall'estensione** (Annulla, Ripristina, "Riapri duplicato") | Registrate in un set di esenzione (`storage.session`, TTL 10 s, per tabId e per URL). Il guard le ignora |
| **Avvio del browser** con ripristino della sessione | Periodo di grazia di 15 s dopo `runtime.onStartup`: niente chiusure automatiche. I duplicati eventuali compaiono in Riordina |
| **"Duplica scheda"** di Chrome (intenzionale; su Firefox non gestito, vedi 5.5) | Euristica: nuova scheda con `openerTabId` = scheda con la stessa URL, `index = opener.index + 1` e URL già impostata alla creazione (non `pendingUrl` da un link). Esenta la scheda finché non naviga altrove. **Da verificare empiricamente** su Chrome stabile: se il segnale non è affidabile, documentarlo in `DECISIONS.md` e affidarsi a "Riapri l'ultimo duplicato" |
| **Redirect** (A → B già aperta) | Si valuta ogni `changeInfo.url`. Le pagine `auth` sono escluse per non interrompere i login |
| `tabs.onReplaced` (discard/prerender) | Aggiorna l'indice senza valutare duplicati |
| Scheda chiusa nel frattempo (`tabs.remove` fallisce) | Ignora l'errore e ricostruisce l'indice |
| Chiusura dell'**ultima scheda di una finestra** | Consentita: è un duplicato di una scheda esistente altrove, che viene attivata |
| Schede con modifiche non salvate (form, editor) | Con "Più vecchia" la scheda chiusa è quasi sempre quella nuova, appena aperta, quindi è sicuro. Con "Più recente" mostra un avviso nelle impostazioni ("può chiudere schede su cui stavi lavorando") |
| Coesistenza con Duplicate Tabs Closer | Nell'onboarding e nelle impostazioni: "Se usi ancora Duplicate Tabs Closer, disattivalo per evitare conflitti". Non si può rilevare in modo affidabile, quindi è solo un testo informativo |

### 8.7 Azione manuale "Chiudi tutti i duplicati"
- Dal chip, dalla scorciatoia o da Riordina → "Duplicati" → "Chiudi tutti".
- Funziona anche in modalità OFF/Solo avvisi. Applica le stesse priorità, archivia e mostra il toast con Annulla (se il pannello è aperto). Dalla scorciatoia, l'annullamento passa dal menu sull'icona.

---

## 9. Azioni, archivio e annullamento

| Azione | Implementazione |
|---|---|
| **Chiudi** | 1) salva `ArchivedTab` in archivio; 2) `chrome.tabs.remove(ids)`; 3) toast con "Annulla" |
| **Annulla chiusura** | per ogni scheda: cerca in `chrome.sessions.getRecentlyClosed()` (massimo 25 voci) una voce con URL corrispondente → `sessions.restore(sessionId)` (mantiene cronologia e scroll). Altrimenti `tabs.create({ url, windowId, index })` e reinserimento nel gruppo originale se esiste ancora. Infine rimozione dall'archivio |
| **Mantieni** | aggiunge l'URL normalizzato a `keeps` con scadenza (7 giorni default; "Sempre" dal menu della riga) |
| **Proteggi sito** | aggiunge il dominio alla lista dei siti protetti |
| **Sospendi** | `chrome.tabs.discard(id)` (non attiva, non già sospesa). Utile per chi non vuole chiudere |
| **Chiudi finestra** | archivia tutte le schede e chiama `chrome.windows.remove` |
| **Ripristina da archivio** | come "Annulla" (fallback `tabs.create` nella finestra corrente) |

- **Sicurezze**:
  - se la selezione include *tutte* le schede di una finestra, il bottone diventa "Chiudi N schede e la finestra" (testo esplicito);
  - mai chiudere la scheda attiva della finestra corrente senza una conferma inline;
  - chiusure di massa oltre 25 schede: conferma inline nella barra ("Chiudi 42 schede? [Conferma] [Annulla]").
- `ArchivedTab = { id, url, title, favIconUrl?, closedAt, reason, windowId, groupTitle? }`.

---

## 10. Persistenza (`platform/storage.ts`)

Tutto su `chrome.storage.local` tramite item tipizzati e versionati (WXT `storage.defineItem` con `version` e `migrations`).

| Chiave | Tipo | Dimensione stimata |
|---|---|---|
| `local:activity` | `Record<tabId, TabActivity>` | 1000 schede × circa 150 B = 150 KB |
| `local:keeps` | `Record<normalizedUrl, expiresAt \| null>` | piccola |
| `local:protectedDomains` | `string[]` | piccola |
| `local:archive` | `ArchivedTab[]` (FIFO, cap 1000) | circa 400 KB al massimo |
| `local:settings` | `Settings` (incluse `GuardSettings` e `MatchOptions`) | piccola |
| `local:duplicateWhitelist` | `string[]` (pattern grezzi, come scritti dall'utente) | piccola |
| `session:guardState` | `{ pausedUntil?: number; resumeMode?: Mode; exemptions: {tabId?, url?, until}[]; lastAutoClosedId?: string }` | piccola, si azzera al riavvio |

- La quota di `storage.local` (10 MB) è sufficiente: **non** richiedere `unlimitedStorage`.
- Le scritture dell'archivio sono batch (una scrittura per azione, non per scheda).
- Cleanup via `chrome.alarms` ogni 6 h: archivio scaduto, `keeps` scaduti, record di activity orfani.

---

## 11. Prestazioni: budget e tecniche

| Metrica | Budget |
|---|---|
| JS del side panel (gzip) | ≤ 60 KB (escluso tldts, se usato: valutare la variante leggera) |
| JS del background (gzip) | ≤ 15 KB |
| Apertura pannello → lista visibile con 300 schede | ≤ 150 ms |
| Scoring di 1000 schede | ≤ 15 ms |
| Clustering di 300 schede (senza AI) | ≤ 50 ms |
| Duplicate Guard: dall'evento alla chiusura (SW già attivo) | ≤ 50 ms |
| Duplicate Guard: dall'evento alla chiusura (SW da risvegliare) | ≤ 300 ms |
| Memoria del service worker | trascurabile: termina quando inattivo |
| Richieste di rete | **0** |

Tecniche:
- Service worker **solo a eventi**, nessun `setInterval`. Il badge si ricalcola su eventi delle tabs (debounce di 2 s) e su un alarm ogni 30 min (perché l'età cresce col tempo).
- Nel pannello, `content-visibility: auto` + `contain-intrinsic-size` sulle righe come virtualizzazione "gratuita". Virtualizzazione vera solo se i test con 1000 schede superano il budget.
- Favicon su Chrome via `chrome-extension://<id>/_favicon/?pageUrl=…&size=32`: cache del browser, nessuna richiesta di rete, nessun problema di CSP. Su Firefox: `favIconUrl` se `data:`, altrimenti avatar con iniziale (sezione 5.5).
- Budget di prestazioni verificati su **entrambi** i browser. Su Firefox la latenza del guard senza `pendingUrl` può arrivare a ≤ 150 ms (SW attivo).
- Signals per aggiornare solo le righe cambiate. Liste con `key` stabile (`tabId`).
- Calcoli pesanti (clustering, AI) solo su richiesta, mai all'apertura del pannello.
- Code splitting: vista Organizza e modulo AI caricati con `import()` dinamico.

---

## 12. Privacy, sicurezza e pubblicazione su Chrome Web Store e Firefox Add-ons

### 12.1 Regole comuni (valide per entrambi gli store)
- `docs/PRIVACY.md`: nessun dato raccolto o trasmesso, tutto resta nello storage locale del browser, nessuna analytics, nessun codice remoto. La stessa privacy policy è linkata in entrambi gli store (ospitata ad es. su GitHub Pages del repo).
- **Single purpose**: "Aiutare l'utente a ridurre, deduplicare e organizzare le schede aperte". Riordina, Organizza e Protezione duplicati sono tutte parti di questo scopo, quindi è conforme alla policy del Chrome Web Store.
- Giustificazione di ogni permesso, per browser, in `docs/PERMISSIONS.md`. Serve per i form di entrambi gli store e per spiegare gli avvisi: Chrome "Leggere la cronologia di navigazione", Firefox "Accedere alle schede del browser".
- Nessun `eval`/`new Function`, nessun codice remoto, nessun `innerHTML` con dati delle schede (i titoli sono input non fidato: rendering solo come testo).
- **Licenza**: MIT (file `LICENSE`).
- Incognito: `not_allowed` in v1. Disinstallazione: nessun `setUninstallURL`.
- **Una sola versione** (`package.json` → manifest) per entrambi gli store, SemVer, `CHANGELOG.md`.

### 12.2 Chrome Web Store
- Account sviluppatore (quota una tantum) e verifica dell'email.
- Pacchetto: `pnpm zip` → `.output/tabdeclutter-<ver>-chrome.zip`.
- Scheda "Privacy practices": single purpose, giustificazione per permesso, certificazione "non raccolgo dati utente", link alla privacy policy.
- Materiali: icona 128×128, almeno 1 screenshot 1280×800 (consigliati 3–5: Riordina, Organizza, Protezione duplicati, Archivio, tema scuro), small promo tile 440×280, descrizione IT/EN.
- Lo stesso zip si può pubblicare anche su **Microsoft Edge Add-ons** senza modifiche (opzionale).

### 12.3 Firefox Add-ons (AMO)
- Account Mozilla (gratuito). Prima pubblicazione **manuale** dal Developer Hub, le successive anche da CI.
- Pacchetto: `pnpm zip:firefox` → `wxt zip -b firefox` produce **due** file: `…-firefox.zip` (add-on) e `…-sources.zip` (sorgenti).
- **Sorgenti obbligatori**: il bundle è generato da Vite, quindi AMO richiede il codice sorgente e istruzioni per ricostruirlo identico. Di conseguenza:
  - `README.md` (o `docs/AMO_REVIEW.md`) con sistema operativo, versione esatta di Node e pnpm, e i comandi `pnpm install --frozen-lockfile && pnpm build:firefox`;
  - lockfile committato, versioni pinnate (`packageManager` in `package.json`, `.nvmrc`);
  - lo zip dei sorgenti **non deve contenere codice minificato o generato**: nessun file vendorizzato minificato, niente `.output/`;
  - build **riproducibile**: uno script CI ricostruisce dallo zip dei sorgenti e confronta (diff) il risultato con lo zip dell'add-on;
  - valutare `minify: false` per la build Firefox: semplifica la revisione umana, a costo di un pacchetto un po' più grande.
- `browser_specific_settings.gecko.id` fisso e `data_collection_permissions: { required: ["none"] }`: senza questa chiave AMO **rifiuta** l'invio.
- `web-ext lint` sull'output Firefox deve dare **0 errori** (in CI). I warning vanno valutati e documentati.
- Materiali: icona, screenshot, riassunto (≤ 250 caratteri), descrizione IT/EN, categoria "Schede", licenza MIT, link alla privacy policy, note per i revisori (cosa fa, perché `tabs`, come testarlo).

### 12.4 Automazione rilascio (CI)
- Workflow `release.yml` su tag `v*`: lint, typecheck, unit test, E2E Chrome, smoke E2E Firefox, `web-ext lint`, poi `wxt zip` e `wxt zip -b firefox`. Gli zip vengono allegati alla GitHub Release.
- Invio automatico opzionale con `wxt submit` (`--chrome-zip`, `--firefox-zip`, `--firefox-sources-zip`), con secret `CHROME_*` e `FIREFOX_JWT_ISSUER`/`FIREFOX_JWT_SECRET`/`FIREFOX_EXTENSION_ID`. Si attiva solo dopo la prima pubblicazione manuale su ciascuno store.

---

## 13. Milestone di implementazione

Ogni milestone termina con: build verde **per Chrome e per Firefox**, lint pulito (incluso `web-ext lint`), test verdi, criteri di accettazione verificati **su entrambi i browser**, breve nota in `docs/DECISIONS.md` per eventuali scelte.

### M0. Scaffolding (½–1 giorno)
- WXT + Preact + TS strict + Vitest + Playwright + Puppeteer/web-ext + ESLint/Prettier + pnpm. Node e pnpm pinnati (`.nvmrc`, `packageManager`).
- Script `package.json`: `dev`, `dev:firefox`, `build`, `build:firefox`, `zip`, `zip:firefox`, `lint`, `lint:firefox` (`web-ext lint -s .output/firefox-mv3`), `test`, `e2e`, `e2e:firefox`.
- `wxt.config.ts` con manifest specializzato per browser (sezione 5.4), `platform/capabilities.ts` e `platform/panel.ts`.
- Entrypoint `background` e `sidepanel` vuoti. Clic sull'icona → apre il pannello su **entrambi** i browser.
- i18n di base (`_locales/en`, `_locales/it`) e helper `t(key, ...subs)`.
- CI GitHub Actions: install, lint, typecheck, unit, build Chrome + Firefox, `web-ext lint`.
- **Accettazione**: `pnpm dev` apre Chrome e `pnpm dev:firefox` apre Firefox con l'estensione, e in entrambi il pannello mostra "Hello" localizzato. `web-ext lint` con 0 errori. CI verde.

### M1. Core puro e tracker (1–2 giorni)
- `core/url.ts`, `core/classify.ts`, `core/duplicates.ts`, `core/scoring.ts` con test esaustivi.
- Tracker nel background (sezione 6.1), con onStartup/onInstalled/onReplaced e scritture con debounce.
- Fixture `tabs-50/300/1000.json` e benchmark.
- **Accettazione**: copertura ≥ 95% su `core/`. Benchmark entro budget. Riavviando il browser, l'età delle schede si conserva (verifica manuale documentata).

### M2. Vista Riordina in sola lettura (1–2 giorni)
- Design token, layout, HealthBar, sezioni per motivo, TabRow con favicon, chip ed età relativa localizzata (`Intl.RelativeTimeFormat`).
- Aggiornamento live sugli eventi delle tabs. Azione "Vai alla scheda".
- Badge nel background.
- **Accettazione**: con 300 schede il pannello è visibile entro 150 ms. Light/dark corretti. Navigazione da tastiera completa. Nessun errore in console.

### M3. Azioni, archivio, annulla (1–2 giorni)
- Selezione multipla, SelectionBar, Chiudi/Mantieni/Sospendi/Chiudi finestra, toast di annullamento, vista Archivio con ricerca e ripristino, menu contestuali, alarm di cleanup.
- **Accettazione**: E2E: chiudo 10 schede → Annulla → tornano tutte (con la stessa URL, nella stessa finestra). Archivio persistente dopo il riavvio. Le sicurezze della sezione 9 funzionano.

### M3b. Protezione duplicati (1–2 giorni)
- `core/patterns.ts`, `core/duplicate-guard.ts` (funzioni pure + test), `background/guard.ts` (indice, coda seriale, esenzioni, grazia all'avvio, pausa con alarm), `DuplicateSettingsView` con `PatternListEditor`, `GuardChip`, comandi e menu contestuali, "Chiudi tutti i duplicati".
- **Accettazione**:
  - E2E: apro la stessa URL due volte → la seconda si chiude in meno di 300 ms e la prima diventa attiva;
  - URL in whitelist (wildcard e regex) → restano entrambe;
  - in pausa → restano entrambe, e alla fine della pausa la modalità torna quella di prima;
  - apertura in background (Ctrl+clic) → nessun cambio di focus;
  - scheda ripristinata da Annulla → non viene chiusa;
  - 20 aperture simultanee della stessa URL → ne resta esattamente una;
  - la whitelist incollata da Duplicate Tabs Closer funziona identica.

### M4. Organizza senza AI (1–2 giorni)
- Per sito + per argomento (TF-IDF + agglomerativo), anteprima modificabile, applica, annulla.
- **Accettazione**: su `tabs-300.json` i cluster per argomento sono sensati (revisione manuale di un campione, salvata in `docs/`). Applica e annulla ripristinano esattamente ordine e gruppi originali.

### M5. AI on-device (1 giorno)
- `platform/llm.ts` (rilevamento, download con progresso, sessione, abort, timeout), `core/ai-grouping.ts` (batch, schema, validazione, merge) con LLM mockato nei test.
- **Accettazione**: sui dispositivi senza modello la UI non mostra errori e usa il fallback. Con il modello i gruppi sono prodotti in meno di 10 s per 40 schede. Output invalido → fallback automatico (testato con mock).

### M6. Impostazioni, rifinitura, accessibilità (1–2 giorni)
- SettingsView completa, permesso opzionale `bookmarks` richiesto al toggle, stati vuoti, animazioni, `prefers-reduced-motion`, audit con axe (Playwright + @axe-core/playwright), traduzioni complete.
- Icona definitiva.
- **Accettazione**: zero violazioni axe "serious/critical". Tutte le stringhe localizzate (test che confronta le chiavi en/it).

### M7. Hardening e rilascio su entrambi gli store (1–2 giorni)
- Test E2E completi, test manuale con 1000 schede e 10 finestre su Chrome **e** Firefox, verifica del budget del bundle (`rollup-plugin-visualizer`), screenshot per entrambi gli store, `STORE_LISTING.md` (testi Chrome e AMO), `PRIVACY.md`, `PERMISSIONS.md`, `AMO_REVIEW.md` (istruzioni di build per i revisori).
- Zip di produzione: `wxt zip` (Chrome) e `wxt zip -b firefox` (add-on + sorgenti). Verifica della build riproducibile dallo zip dei sorgenti.
- Workflow `release.yml` (sezione 12.4).
- **Accettazione**: checklist di rilascio (sezione 14) tutta spuntata. Pacchetti pronti per l'invio a Chrome Web Store e AMO.

---

## 14. Strategia di test e checklist di rilascio

**Unit (Vitest)**: normalizzazione URL, classificazione, duplicati, scoring (tabella di casi + proprietà: le schede protette hanno sempre score 0; il punteggio è monotono nell'inattività), clustering (deterministico, limiti 8 gruppi e minimo 2), ai-grouping (mock: output valido, ID inventati, duplicati, JSON malformato, quota superata).

**E2E (Playwright, Chromium con estensione caricata da `.output/chrome-mv3`)**:
- apertura pannello e rendering delle sezioni con schede seminate;
- chiusura + annulla;
- mantieni → la scheda sparisce dai suggerimenti e non ricompare per 7 giorni (con tempo simulato);
- organizza per sito → gruppi creati con titolo e colore → annulla;
- archivio: ricerca, ripristino, svuota;
- protezione duplicati: tutti i casi di accettazione di M3b, più ambito "Stessa finestra" vs "Tutte le finestre", "Sposta e attiva", "Più vecchia ricaricata", navigazione di una scheda attiva verso una URL già aperta (regola "scheda attiva").

**E2E Firefox (Puppeteer con WebDriver BiDi, estensione caricata da `.output/firefox-mv3`)**: smoke test degli stessi flussi principali (apertura sidebar, chiusura + annulla, guard su URL duplicata, organizza per sito). Se un flusso non è automatizzabile su Firefox, entra nella checklist manuale.

**Unit specifici per compatibilità**: `capabilities` mockate (Chrome/Firefox) per favicon, guard senza `pendingUrl`, chiave di duplicato con `cookieStoreId`, schede `hidden`, opzioni nascoste su Firefox, default della whitelist per browser.

**Manuale (Chrome)**: riavvio del browser (persistenza dell'età), discard da `chrome://discards` (onReplaced), più finestre, schede fissate/audio, tema scuro, zoom 200%, screen reader (NVDA/VoiceOver) sulle azioni principali.

**Manuale (Firefox)**: apertura sidebar da icona e scorciatoia, riavvio con ripristino della sessione (età conservata tramite `sessions.setTabValue`), container Multi-Account (stessa URL in container diversi, nessuna chiusura), tab groups (creazione/annullamento), favicon/avatar, `about:` pages, tema scuro, schede scaricate dalla memoria (`about:unloads`).

**Checklist di rilascio**
- [ ] Build Chrome e Firefox generate dallo stesso commit, stessa versione
- [ ] `web-ext lint` con 0 errori. `data_collection_permissions` e `gecko.id` presenti
- [ ] Zip dei sorgenti AMO senza file minificati. Build riproducibile verificata
- [ ] Tutti i flussi verificati su Chrome **e** Firefox
- [ ] Zero richieste di rete (verificato da DevTools → Network sul pannello e sul service worker)
- [ ] Permessi = quelli della sezione 5.4, ognuno giustificato
- [ ] Budget di prestazioni rispettati
- [ ] Nessun errore/warning in console
- [ ] i18n en/it complete
- [ ] axe pulito
- [ ] PRIVACY.md, PERMISSIONS.md, STORE_LISTING.md e AMO_REVIEW.md pronti, con screenshot 1280×800 per entrambi gli store

---

## 15. Possibili evoluzioni (v2, non implementare ora)
- AI on-device anche su Firefox (API ML sperimentale di Firefox per le estensioni, oppure transformers.js), per il raggruppamento per argomento.
- Firefox per Android e Safari.
- Embedding semantici locali (transformers.js + `all-MiniLM-L6-v2` in offscreen document, WASM incluso nel pacchetto) per raggruppare meglio per argomento senza Gemini Nano.
- "Revisione settimanale": notifica opzionale una volta a settimana se ci sono più di N schede da chiudere.
- Regole personalizzate tipo "se URL contiene X allora mantieni/suggerisci".
- Statistiche personali (schede chiuse nel tempo), solo locali.

---

## 16. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Falsi positivi (suggerire una scheda importante) | Soglie conservative, motivi spiegati, "Mantieni", siti protetti, archivio + annulla, precisione ≥ 0,9 sulle fixture |
| `lastAccessed` assente o inaffidabile (discard, riavvio) | Tracker proprio + riconciliazione per URL + `max()` dei valori disponibili |
| Service worker terminato e stato perso | Nessuno stato solo in memoria: tutto su storage, scritture con debounce e flush immediato su `onSuspend` |
| Gemini Nano non disponibile (hardware, lingua, spazio) | AI opzionale con fallback euristico sempre presente |
| Prestazioni con migliaia di schede | Algoritmi O(n), `content-visibility`, clustering on-demand, benchmark in CI |
| Cambiamenti alle API Chrome/Firefox | Wrapper in `platform/`, `minimum_chrome_version` / `strict_min_version`, verifica sulla documentazione ufficiale (developer.chrome.com, MDN) |
| Divergenze di comportamento tra Chrome e Firefox | Feature detection centralizzata (`capabilities.ts`), tabella 5.5 come contratto, test con capabilities mockate, checklist manuale Firefox |
| Rifiuto in revisione AMO (sorgenti, codice minificato, permessi) | Zip dei sorgenti pulito, build riproducibile in CI, `web-ext lint`, note per i revisori, `minify: false` valutato per Firefox |
| Rifiuto in revisione Chrome Web Store (single purpose, permessi) | Scopo unico dichiarato, giustificazione di ogni permesso, nessun permesso inutilizzato |
| Guard che chiude una scheda che l'utente voleva (redirect, login, "Duplica scheda") | Esclusione delle pagine `auth`, esenzioni, grazia all'avvio, nuova scheda mai considerata "attiva", archivio + "Riapri l'ultimo duplicato" + "Consenti per questo sito" a portata di clic |
| Regex della whitelist lente o errate | Validazione live, limite di lunghezza, compilazione una sola volta, errori isolati per riga |
| Corse tra eventi (aperture simultanee) | Coda seriale + indice aggiornato prima della chiusura + test con 20 aperture parallele |
| Avviso permessi "cronologia" che spaventa l'utente | Spiegazione chiara nello store e nell'onboarding: "Leggiamo titoli e indirizzi delle schede solo sul tuo dispositivo" |

---

## 17. Onboarding (primo avvio)
Una sola schermata nel pannello, mai pagine aperte automaticamente:
1. "TabDeclutter ti suggerisce quali schede chiudere e ti aiuta a organizzarle. Tutto resta sul tuo dispositivo."
2. Scelta rapida della soglia di vecchiaia (3/7/14 giorni).
3. **Protezione duplicati**: "Quando apri una scheda già aperta: [Chiudila e torna a quella esistente] (preselezionato) / [Avvisami soltanto] / [Non fare nulla]", con il link "Hai una whitelist di Duplicate Tabs Closer? Incollala qui" (apre l'editor) e la nota "Se usi Duplicate Tabs Closer, disattivalo".
4. Nota: "Nei primi giorni i suggerimenti si basano su dati parziali e diventano più precisi con l'uso."
5. Pulsante "Inizia".

---

## 18. Fonti consultate
- Chrome Prompt API (stato, requisiti hardware, `availability`, `responseConstraint`, quote): https://developer.chrome.com/docs/ai/prompt-api
- `chrome.tabs` reference (`lastAccessed` da Chrome 121, `discard`, `discarded`): https://developer.chrome.com/docs/extensions/reference/api/tabs
- Bug/discussione `lastAccessed` undefined dopo il discard: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/k9V7ndpUjXk
- Firefox tab groups API (Firefox 138/139): https://blog.mozilla.org/addons/2025/04/30/webextensions-support-for-tab-groups/, https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups
- Firefox `data_collection_permissions` obbligatorio per i nuovi add-on: https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/, https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent
- Invio su AMO e sorgenti: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/Distribution/Submitting_an_add-on
- WXT side panel (Chrome `side_panel` / Firefox `sidebar_action`): https://wxt.dev/entrypoints/sidepanel, differenze API: https://extension.js.org/docs/implementation-guide/side-panel
- `tabs.Tab` su Firefox (`favIconUrl`, `lastAccessed`, `pendingUrl`): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab
- Duplicate Tabs Closer (modalità, priorità, whitelist `*`/regex, matching, "intentional duplicate"): https://github.com/Peuj/duplicate-tabs-closer
- Tab Wrangler (approccio auto-close + Corral): https://github.com/tabwrangler/tabwrangler, https://tabwrangler.com/
- Confronto framework WXT/Plasmo/CRXJS: https://wxt.dev/guide/resources/compare, https://dev.to/extensionbooster/plasmo-vs-crxjs-vs-wxt-which-chrome-extension-framework-should-you-use-in-2026-37o4
- Transformers.js in estensioni MV3 (offscreen document, WASM locale): https://huggingface.co/blog/transformersjs-chrome-extension, https://dev.to/sathiyasenpai/why-i-moved-my-transformersjs-pipeline-out-of-the-chrome-mv3-service-worker-and-into-an-offscreen-1kk4
- Chrome Tab Organizer nativo: https://techcrunch.com/2024/01/23/google-chrome-gains-ai-features-including-a-writing-helper-theme-creator-and-tab-organizer
- Panoramiche sui tab manager 2026 (spesso di parte, scritte da concorrenti): https://www.superchargebrowser.com/library/best-chrome-tab-managers-2026, https://leap-tabs.com/blog/best-tab-managers-chrome-2026
- Limiti sulla memoria per scheda (`chrome.processes` solo su Dev/Canary): https://github.com/daermond/Tab-Memory-Manager
