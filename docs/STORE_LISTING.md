# TabDeclutter — Store listing texts

Ready to paste into the Chrome Web Store (and Microsoft Edge Add-ons, which takes the same
package) and into Firefox Add-ons (AMO). Every text is the content of the fenced block under its
heading. `tests/unit/store-docs.test.ts` checks the length limits and that the short descriptions
equal `extDescription` in `src/public/_locales/`.

Name (both stores, both languages): `TabDeclutter`

Category: Chrome Web Store → Productivity (Workflow & Planning); AMO → Tabs.
Licence: MIT. Privacy policy: <https://github.com/RobertoReale/TabDeclutter/blob/main/docs/PRIVACY.md>.
Support / issues: <https://github.com/RobertoReale/TabDeclutter/issues>.

## Single purpose

Chrome Web Store, "Single purpose" field.

### Single purpose (EN)

```
Help the user reduce, deduplicate and organize their open tabs.
```

### Single purpose (IT)

```
Aiutare l'utente a ridurre, deduplicare e organizzare le schede aperte.
```

Declutter (suggestions to close), Organize (tab groups) and Duplicate protection all serve that one
purpose.

## Chrome Web Store

### Short description (EN, max 132 characters)

```
Suggests which tabs to close, organizes the rest into native tab groups and blocks duplicate tabs in real time.
```

### Short description (IT, max 132 characters)

```
Suggerisce quali schede chiudere, organizza le altre in gruppi nativi e blocca le schede duplicate in tempo reale.
```

### Detailed description (EN)

```
Too many open tabs? TabDeclutter tells you which ones you can close, sorts the rest into tab groups and stops duplicates from piling up. Everything happens on your device.

WHAT IT DOES
• Declutter: a list of the tabs you probably no longer need, each with a plain reason ("You have not opened it in 12 days", "Duplicate of another open tab"). Close them one by one or in bulk, keep the ones you want, or discard them to free memory.
• Organize: put your tabs into native browser tab groups, by site or by topic. With Chrome's built-in on-device AI, group names can be improved, optionally and without leaving your computer. Optionally sort YouTube video tabs by duration (including suspended tabs without reloading them).
• Duplicate protection: as soon as a tab becomes a duplicate of another, warn you or close it automatically, as you choose. Whitelist, URL comparison rules, pause, and the same pattern syntax as Duplicate Tabs Closer.
• Archive and undo: every close is saved for a while and can be restored, with its history.
• Badge with the number of suggested tabs, keyboard shortcuts, light and dark theme, Italian and English.

PRIVATE BY DESIGN
No account, no servers, no analytics, no network requests by default, no remote code. Tab information is read and stored only in your browser. Optional YouTube duration sorting is off by default and requests an optional host permission strictly for www.youtube.com only if you enable it, caching durations locally and revoking access when turned off. Automatic cleanup and duplicate closing only run after setup when enabled, obey strict safety guardrails, and archive every closed tab locally so nothing is ever lost.

WHY THE "READ YOUR BROWSING HISTORY ON ALL YOUR SIGNED-IN DEVICES" WARNING
It is how Chrome words the permissions to see the address and title of your open tabs and to restore a tab you closed with Undo. The extension only uses the tabs of this browser, and needs both to work. The extension reads nothing from the pages themselves.

If you still use Duplicate Tabs Closer, turn it off to avoid conflicts.
```

### Detailed description (IT)

```
Troppe schede aperte? TabDeclutter ti dice quali puoi chiudere, mette le altre in gruppi e impedisce ai duplicati di accumularsi. Tutto avviene sul tuo dispositivo.

COSA FA
• Riordina: l'elenco delle schede che probabilmente non ti servono più, ognuna con un motivo chiaro ("Non la apri da 12 giorni", "Duplicato di un'altra scheda aperta"). Chiudile una per una o in blocco, mantieni quelle che vuoi, oppure sospendile per liberare memoria.
• Organizza: raggruppa le schede nei gruppi nativi del browser, per sito o per argomento. Con l'IA integrata di Chrome, in locale, i nomi dei gruppi possono migliorare, in modo facoltativo e senza uscire dal computer. Opzionalmente ordina le schede video YouTube per durata (anche quelle sospese senza ricaricarle).
• Protezione duplicati: appena una scheda diventa duplicata di un'altra, ti avvisa o la chiude da sola, come preferisci. Eccezioni, regole di confronto degli indirizzi, pausa e la stessa sintassi di Duplicate Tabs Closer.
• Archivio e annulla: ogni chiusura viene conservata per un po' e può essere ripristinata, con la sua cronologia.
• Badge con il numero di schede suggerite, scorciatoie da tastiera, tema chiaro e scuro, italiano e inglese.

PRIVATO PER SCELTA
Nessun account, nessun server, nessuna analisi d'uso, nessuna richiesta di rete di default, nessun codice remoto. Le informazioni sulle schede sono lette e salvate solo nel tuo browser. L'ordinamento per durata di YouTube è spento di default e chiede un permesso opzionale solo per www.youtube.com se lo attivi, salvando le durate in cache locale e revocando il permesso quando lo disattivi. Pulizia automatica e protezione duplicati agiscono solo dopo la configurazione quando attive, rispettano rigide protezioni e salvano ogni scheda chiusa nell'Archivio locale così puoi sempre ripristinarla.

PERCHÉ L'AVVISO "LEGGERE LA CRONOLOGIA DI NAVIGAZIONE SU TUTTI I DISPOSITIVI SU CUI VIENE ESEGUITO L'ACCESSO"
È il modo in cui Chrome descrive i permessi di vedere indirizzo e titolo delle schede aperte e di ripristinare una scheda chiusa con Annulla. L'estensione usa solo le schede di questo browser e ha bisogno di entrambi. Dalle pagine stesse non legge nulla.

Se usi ancora Duplicate Tabs Closer, disattivalo per evitare conflitti.
```

### Privacy practices tab

- Single purpose: the text above.
- Permission justifications: copy the "Justification" column of the Chrome tables in `PERMISSIONS.md`.
- Remote code: **No**, the extension runs no remote code.
- Data usage: tick **none** of the data types; certify that no user data is collected, sold or used
  outside the single purpose, or to judge creditworthiness.
- Privacy policy URL: the one at the top of this file.

### Assets

- 128×128 icon: `src/public/icon/icon-128.png` (also in the package).
- 1280×800 screenshots: the five PNGs in `docs/store/screenshots/chrome/` (`pnpm screenshots`
  makes them again). AMO takes the same files.
- 440×280 small promo tile: not made yet; it has to exist before the first Chrome Web Store
  submission (`docs/RELEASE-CHECKLIST.md`, "Left before submission").

## Firefox Add-ons (AMO)

### Summary (EN, max 250 characters)

```
Suggests which tabs to close, organizes the rest into native tab groups and blocks duplicate tabs in real time. Reasons are always shown, every close can be undone, and nothing ever leaves your device.
```

### Summary (IT, max 250 characters)

```
Suggerisce quali schede chiudere, organizza le altre in gruppi nativi e blocca le schede duplicate in tempo reale. I motivi sono sempre mostrati, ogni chiusura si può annullare e nulla lascia il tuo dispositivo.
```

### Description (EN)

```
Too many open tabs? TabDeclutter tells you which ones you can close, sorts the rest into tab groups and stops duplicates from piling up. Everything happens on your device.

<b>What it does</b>
<ul>
<li>Declutter: a list of the tabs you probably no longer need, each with a plain reason. Close them one by one or in bulk, keep the ones you want, or discard them to free memory.</li>
<li>Organize: put your tabs into native tab groups, by site or by topic, and optionally sort YouTube video tabs by duration (including suspended tabs without reloading them).</li>
<li>Duplicate protection: as soon as a tab becomes a duplicate of another, warn you or close it automatically, as you choose. Whitelist, URL comparison rules, pause, and the same pattern syntax as Duplicate Tabs Closer.</li>
<li>Archive and undo: every close is saved for a while and can be restored.</li>
<li>Badge with the number of suggested tabs, keyboard shortcuts, light and dark theme, Italian and English.</li>
</ul>

<b>Private by design</b>
No account, no servers, no analytics, no network requests by default, no remote code. Tab information is read and stored only in your browser. Optional YouTube duration sorting is off by default and asks for optional host access strictly to www.youtube.com only if you turn it on (revoked when turned off). Automatic cleanup and duplicate closing only run after setup when enabled, obey strict safety guardrails, and archive every closed tab locally so it can always be restored. The "Access browser tabs" permission is needed to see the address and title of your open tabs, and "Access recently closed tabs" to restore a tab you closed with Undo; the extension injects no content scripts.

Requires Firefox 140 or later. If you still use Duplicate Tabs Closer, turn it off to avoid conflicts.
```

### Description (IT)

```
Troppe schede aperte? TabDeclutter ti dice quali puoi chiudere, mette le altre in gruppi e impedisce ai duplicati di accumularsi. Tutto avviene sul tuo dispositivo.

<b>Cosa fa</b>
<ul>
<li>Riordina: l'elenco delle schede che probabilmente non ti servono più, ognuna con un motivo chiaro. Chiudile una per una o in blocco, mantieni quelle che vuoi, oppure sospendile per liberare memoria.</li>
<li>Organizza: raggruppa le schede nei gruppi nativi, per sito o per argomento, e opzionalmente ordina le schede video YouTube per durata (anche quelle sospese senza ricaricarle).</li>
<li>Protezione duplicati: appena una scheda diventa duplicata di un'altra, ti avvisa o la chiude da sola, come preferisci. Eccezioni, regole di confronto degli indirizzi, pausa e la stessa sintassi di Duplicate Tabs Closer.</li>
<li>Archivio e annulla: ogni chiusura viene conservata per un po' e può essere ripristinata.</li>
<li>Badge con il numero di schede suggerite, scorciatoie da tastiera, tema chiaro e scuro, italiano e inglese.</li>
</ul>

<b>Privato per scelta</b>
Nessun account, nessun server, nessuna analisi d'uso, nessuna richiesta di rete di default, nessun codice remoto. Le informazioni sulle schede sono lette e salvate solo nel tuo browser. L'ordinamento per durata di YouTube è spento di default e chiede il permesso host opzionale solo per www.youtube.com se lo attivi (revocato quando lo disattivi). Pulizia automatica e protezione duplicati agiscono solo dopo la configurazione quando attive, rispettano rigide protezioni e salvano ogni scheda chiusa nell'Archivio locale così puoi sempre ripristinarla. Il permesso "Accedere alle schede del browser" serve a vedere indirizzo e titolo delle schede aperte, e "Accedere alle schede chiuse di recente" a ripristinare con Annulla una scheda chiusa; l'estensione non inietta alcun content script.

Richiede Firefox 140 o successivo. Se usi ancora Duplicate Tabs Closer, disattivalo per evitare conflitti.
```

### Form fields

- Category: Tabs. Licence: MIT. Privacy policy: the URL at the top of this file.
- Data collection: none (the manifest says `required: ["none"]`).
- Notes for reviewers: paste the "Notes for reviewers" section of `AMO_REVIEW.md`.
- Source code: upload the `-sources.zip` made by `pnpm zip:firefox`.
