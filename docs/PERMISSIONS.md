# TabDeclutter — Permissions

One permission per row, per browser, with the warning the browser shows and the justification to
paste into the store forms. `tests/unit/store-docs.test.ts` compares the first column of every table
below with `build/manifest.ts`, and the `permissions docs` gate (`tools/check-permissions.mjs`) with the built
`.output/*/manifest.json`, so the lists cannot drift apart: an added or removed permission fails the test until this file says so.

Common to both browsers: **no `host_permissions`, no content scripts, no `<all_urls>`**, the default
extension CSP, no remote code, `incognito: not_allowed`.

Firefox warning texts are the ones in Firefox's own source
([extensionPermissions.ftl](https://github.com/mozilla/gecko-dev/blob/master/toolkit/locales/en-US/toolkit/global/extensionPermissions.ftl),
`webext-perms-description-*`, read 2026-11-17); a permission with no message there shows nothing of its
own. Chrome's are from the message rules of Chromium's `chrome_permission_message_rules.cc` (`tabs` + `sessions` map to `IDS_EXTENSION_PROMPT_WARNING_HISTORY_READ_ON_ALL_DEVICES`) and from
[Chrome's list](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)
and the rules in Chromium's `chrome_permission_message_rules.cc`; the Chrome wording was not checked on
an install prompt. "None" means the browser shows no warning of its own for it.

## Chrome (required)

| Permission    | Warning shown                                               | Justification                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`        | "Read your browsing history on all your signed-in devices" (it: "Leggere la cronologia di navigazione su tutti i dispositivi su cui viene eseguito l'accesso"): the `tabs` and `sessions` pair shows this one in place of "Read your browsing history" | Needed to read the URL, title and last-used time of the open tabs, which is the whole input of the suggestions, the grouping and the duplicate detection. Nothing is read from page content and nothing leaves the device. |
| `tabGroups`   | None                                                        | Creates, names, colours and collapses the native tab groups of the "Organize" view.                                                                                                       |
| `storage`     | None                                                        | Keeps the settings, the tab activity map, the archive of closed tabs and the whitelist on the device (`storage.local`), and the short-lived duplicate-guard state (`storage.session`).      |
| `sidePanel`   | None                                                        | The main interface is Chrome's side panel, opened from the toolbar icon or `Alt+Shift+D`.                                                                                                  |
| `alarms`      | None                                                        | Wakes the background every few hours to purge expired archive entries, periodically to refresh the badge, and to end a pause of the duplicate protection.                                  |
| `favicon`     | None of its own (covered by the `tabs` warning)             | Shows each tab's icon from Chrome's local cache (`/_favicon/`), so no request is made to any website.                                                                                      |
| `sessions`    | Together with `tabs` it widens the warning above (no warning of its own) | Lets "Undo" restore a closed tab with its history and scroll position, instead of just reopening its address.                                                                              |
| `contextMenus`| None                                                        | Adds "Always keep this tab", "Always protect this site" and "Allow duplicates for this site" to the right-click menu of the page, and the duplicate protection's actions (reopen the last duplicate closed, pause the protection) to the right-click menu of the toolbar icon. |

## Chrome (optional)

| Permission  | Warning shown                                       | Justification                                                                                                                                         |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookmarks` | "Read and change your bookmarks"                    | Requested only when the user turns on the "already bookmarked" signal, which makes a bookmarked tab easier to suggest for closing, since it can be found again. Only checks whether an address is bookmarked; never writes. |

## Firefox (required)

| Permission    | Warning shown                                               | Justification                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`        | "Access browser tabs" (it: "Accedere alle schede del browser") | Needed to read the URL, title and last-used time of the open tabs, which is the whole input of the suggestions, the grouping and the duplicate detection. Nothing is read from page content and nothing leaves the device. |
| `tabGroups`   | None                                                        | Creates, names, colours and collapses the native tab groups of the "Organize" view (Firefox 139 and later).                                                                              |
| `storage`     | None                                                        | Keeps the settings, the tab activity map, the archive of closed tabs and the whitelist on the device, and the short-lived duplicate-guard state.                                          |
| `alarms`      | None                                                        | Wakes the event page every few hours to purge expired archive entries, periodically to refresh the badge, and to end a pause of the duplicate protection.                                  |
| `sessions`    | "Access recently closed tabs" (it: "Accedere alle schede chiuse di recente") | Lets "Undo" restore a closed tab with its history, instead of just reopening its address.                                                                                                  |
| `menus`       | None                                                        | Firefox's name for the context menu: adds "Always keep this tab", "Always protect this site" and "Allow duplicates for this site" to the right-click menu of the page and of a tab, and the duplicate protection's actions (reopen the last duplicate closed, pause the protection) to the right-click menu of the toolbar button. |

Firefox has no `sidePanel` and no `favicon` permission: the panel is the `sidebar_action`, and
each tab is shown with a coloured badge holding the first letter of its site (or with its icon, when
the tab already carries it as embedded data), so no icon is ever downloaded. The manifest declares
`data_collection_permissions: { required: ["none"] }`.

## Firefox (optional)

| Permission  | Warning shown                                  | Justification                                                                                                                                         |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookmarks` | "Read and modify bookmarks"                    | Requested only when the user turns on the "already bookmarked" signal. Only checks whether an address is bookmarked; never writes.                    |

## Not requested, on purpose

`host_permissions`, `<all_urls>`, `webNavigation`, `history`, `unlimitedStorage`, `scripting`,
`activeTab`, `notifications`, `downloads`. Duplicate protection needs nothing beyond `tabs`.
