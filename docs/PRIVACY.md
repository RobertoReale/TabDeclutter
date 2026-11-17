# TabDeclutter — Privacy policy

_Last updated: 2026-11-17 (version 0.1.0)._

**TabDeclutter does not collect, transmit or share any data.** Everything it knows stays in your
browser, on your device.

## What the extension reads

To suggest which tabs to close, organize them and block duplicates, TabDeclutter reads, for the
tabs you have open: the address (URL), the title, the time you last used the tab, whether it is
pinned, playing audio or in a group, and its window. It reads them through the browser's own
extension API (the `tabs` permission) and uses them only on your device.

## What the extension stores

Only in the browser's local extension storage (`storage.local`, and `storage.session` for state
that is dropped when the browser restarts):

- a map of when each open tab was last active;
- the tabs you asked to keep, and the sites you protected;
- the archive of tabs you closed from TabDeclutter (address, title, time), kept for the number of
  days set in the settings (30 by default) and at most 1000 entries;
- your settings and your duplicate whitelist;
- the short-lived state of the duplicate protection (a pause, tabs the extension itself reopened).

Nothing else is kept. Uninstalling the extension removes all of it.

## What the extension never does

- It makes **no network requests**: no servers of ours, no analytics, no telemetry, no crash
  reports, no advertising, no remote configuration.
- It loads and runs **no remote code**.
- It does not sell, share or transfer data to anyone, because it has none to give.
- It does not read page content: it has no content scripts and no host permissions.
- It does not work in private (incognito) windows.
- Tab titles are treated as untrusted text and are never interpreted as markup.

## Optional features

- **On-device AI (Chrome only, optional).** If your Chrome offers its built-in model (Gemini
  Nano, through the Prompt API), TabDeclutter can use it to suggest names for groups of tabs. The
  model runs on your device and is managed by Chrome. Titles and domains are given to it locally
  and never leave the device. The download of the model, which happens only after you click for
  it, is Chrome's, not the extension's. Firefox does not offer this feature.
- **Bookmarks (optional permission).** If you turn on the "already bookmarked" signal, the browser
  asks for the `bookmarks` permission. The extension only checks whether an address is
  bookmarked, and never changes a bookmark. You can turn it off, and revoke the permission, at any
  time.
- **Site icons.** On Chrome the icons come from the browser's own local cache, with no request to
  the websites. Firefox has no such cache for extensions, so there each tab is shown with a
  coloured badge holding the first letter of its site, drawn by the extension, unless the tab
  already carries its icon as embedded data. No icon is ever downloaded.

## Your control

Every close is an explicit gesture of yours and can be undone. You can empty the archive from the
extension itself, and removing the extension deletes everything it stored.

## Changes and contact

If this policy changes, the new text will be published here with its date, and the change will be
listed in `CHANGELOG.md`. Questions: open an issue at
<https://github.com/RobertoReale/TabDeclutter/issues>.

---

## Informativa sulla privacy (italiano)

**TabDeclutter non raccoglie, non trasmette e non condivide alcun dato.** Tutto ciò che conosce
resta nel tuo browser, sul tuo dispositivo.

- **Cosa legge:** per le schede aperte, indirizzo, titolo, ultimo utilizzo, se è fissata, se riproduce
  audio, il gruppo e la finestra, tramite l'API delle estensioni del browser (permesso `tabs`).
  Li usa solo sul dispositivo.
- **Cosa salva:** solo nell'archiviazione locale dell'estensione: l'ultima attività delle schede,
  le schede da mantenere e i siti protetti, l'archivio delle schede chiuse (per i giorni impostati,
  30 di default, al massimo 1000), le impostazioni, la lista di eccezioni dei duplicati e lo stato
  temporaneo della protezione duplicati. Disinstallando l'estensione tutto viene cancellato.
- **Cosa non fa mai:** nessuna richiesta di rete, nessuna analisi d'uso o telemetria, nessuna
  pubblicità, nessun codice remoto, nessuna lettura del contenuto delle pagine, nessun
  funzionamento nelle finestre in incognito.
- **Funzioni facoltative:** l'IA sul dispositivo (solo Chrome) usa il modello integrato in Chrome
  per proporre nomi di gruppo; il modello gira in locale e il suo download parte solo dopo un tuo
  clic. Il permesso facoltativo `bookmarks` viene chiesto solo se attivi il segnale "già nei
  segnalibri"; l'estensione controlla soltanto se un indirizzo è nei segnalibri e non li modifica.
- **Il tuo controllo:** ogni chiusura è un tuo gesto esplicito e si può annullare.

Domande: <https://github.com/RobertoReale/TabDeclutter/issues>.
