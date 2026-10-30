# Come far lavorare l'agente da solo

Il progetto viene costruito da sessioni di Claude Code **non presidiate**, guidate da phasekit.
Ogni task di `TASKS.md` gira in una sessione propria, sul branch `plan/phase-<task>`. Finisce con un
commit, poi phasekit riesegue i gates e, se sono verdi, fa il merge su `main` e passa al task
successivo. Se qualcosa non torna si ferma, ti avvisa con suono e notifica e scrive il motivo in
`.phasekit/logs/auto-stopped.txt`.

Tutti i comandi qui sotto vanno dati in **PowerShell 7** (`pwsh`), per esempio nel terminale di
VS Code, dalla cartella del progetto:

```powershell
cd "C:\Users\Admin\Documents\Roberto Reale\Projects\Coding\GitHub\TabDeclutter"
```

## 1. Avvio

```powershell
phasekit auto -Detach
```

Parte in un processo separato: puoi chiudere il terminale e il lavoro continua. Il terminale resta
agganciato ai log; `Ctrl+C` stacca solo la visualizzazione, non ferma la sequenza.

**Una volta sola**, per farlo ripartire da solo dopo un riavvio o se il processo viene ucciso:

```powershell
$pk = "C:\Users\Admin\Documents\Roberto Reale\Projects\Coding\GitHub\phasekit\tools"
$cfg = "C:\Users\Admin\Documents\Roberto Reale\Projects\Coding\GitHub\TabDeclutter\phasekit.json"
& "$pk\resume-at-logon.ps1" -Install -Config $cfg
& "$pk\watchdog.ps1" -Install -Config $cfg
```

Il watchdog controlla ogni 15 minuti e riavvia solo una sequenza morta, non una che si è fermata
per chiederti qualcosa. Per toglierli quando hai finito: gli stessi comandi con `-Uninstall`.

## 2. Seguire il lavoro

| Comando | Cosa mostra |
|---|---|
| `phasekit dashboard -Watch` | avanzamento, task in corso, stima del tempo rimanente |
| `phasekit logs -Follow` | cosa sta facendo l'agente adesso |
| `phasekit steps` | l'elenco dei task con la loro descrizione |
| `phasekit status` | ledger accanto al `git log`: devono coincidere |
| `phasekit spend` | quanto ha consumato ogni task |

## 3. Quando si ferma

1. Leggi `.phasekit/logs/auto-stopped.txt`: c'è il motivo e il comando suggerito.
2. Se l'agente ti ha fatto una domanda, rispondi **nella stessa conversazione** (costa un turno,
   ricominciare costa tutto il task):
   ```powershell
   phasekit reply M1.6 -Text "la tua risposta"
   ```
   Per risposte lunghe: scrivila in un file e usa `-File risposta.txt`.
3. Poi rilancia la sequenza. Riparte dal primo task non finito e salta quelli già fatti:
   ```powershell
   phasekit auto -Detach
   ```

Se non capisci perché si è fermato, apri Claude Code in questa cartella e incolla il blocco
`## resume` di `PROMPTS.md`: ti dice cosa è successo e cosa risponderebbe, senza toccare niente.

## 4. Pausa

```powershell
phasekit pause     # ferma tutto subito, anche attraverso i riavvii
phasekit resume    # riprende dallo stesso punto
```

Se finisce il credito dell'account, phasekit aspetta da solo l'orario di reset e riprende. Per non
aspettare puoi passare a un altro account con `phasekit account`.

## 5. Mentre gira

- **Non modificare file in questa cartella**, né a mano né con un'altra sessione di Claude: il
  runner ha bisogno dell'albero pulito e del branch giusto.
- Puoi usare il PC normalmente. Gli E2E usano un Chromium e un profilo Firefox separati, headless,
  e non toccano i tuoi browser.
- Il PC deve restare acceso. phasekit gli impedisce di andare in standby finché la sequenza è
  attiva (lo schermo invece può spegnersi). Spegnimento o riavvio fermano il processo: per questo
  c'è il logon task del punto 1.
- Prima del primo task `phasekit gates` fallisce: è normale, i gates li crea M0.1.

## 6. Revisione

- Ogni task è un merge `--no-ff` su `main`, quindi `git log --oneline --graph` mostra un task per
  blocco.
- Per buttare via un task già fatto: `git revert -m 1 <hash del merge>`, poi correggi `TASKS.md`
  e rilancia.
- `docs/MANUAL-CHECKS.md` raccoglie ciò che solo tu puoi verificare (riavvio vero del browser,
  screen reader, AI sul tuo PC). Conviene farlo alla fine di ogni fase (M0, M1…), così un problema
  viene fuori prima che altro ci venga costruito sopra. Se trovi un bug, aggiungi un task in
  `TASKS.md` (sezione, riga del ledger e voce in `autoSequence` di `phasekit.json`), fai il commit
  e rilancia.
- `docs/DECISIONS.md` spiega ogni scelta che l'agente ha fatto da solo.

## 7. GitHub (facoltativo)

Il repository per ora è solo locale. Quando vuoi:

```powershell
gh repo create TabDeclutter --private --source . --push
```

Da lì in poi `phasekit auto -Detach -Push` fa il push dopo ogni merge, e la CI (M0.6) gira su
GitHub. Se hai installato watchdog e logon task, reinstallali con `-Push`.

## 8. Cosa resta a te, sempre

- Le voci di `docs/MANUAL-CHECKS.md`.
- La conferma dell'id Firefox prima del primo invio ad AMO.
- La pubblicazione sugli store: l'agente prepara pacchetti e testi (M7) ma non invia niente.
