# Cluster review — topic grouping on `tabs-300`

PLAN.md §13's acceptance for M4 asks for one thing a test cannot answer: whether the topic clusters
*make sense*. This is that review, on the 300-tab fixture
(`tests/fixtures/tabs-300.json`, six windows, the same file the perf budget uses).

What was run is `groupByTopic(tabs)` from `src/core/cluster.ts` with the default options
(`threshold: 0.25`, `minClusterTabs: 2`, `maxGroups: 8`, pinned and already-grouped tabs left out,
as §4.4 leaves them). Clustering is per window (§7.2.3), so a window is named below as `w1`…`w6`.
The counts quoted are the measured ones: **45 groups, 169 tabs left in "Altro"** across the six
windows.

Read it as a verdict on the algorithm, not on the fixture: the fixture was written to look like a
tab hoarder's browser (`scripts/generate-fixtures.ts`), with search pages, logins, error pages,
duplicates and a trip to Lisbon spread over three windows.

## The clusters, judged

Fifteen of the 45 are judged here — the task asks for at least eight — chosen to cover both what
the algorithm is for and every way it was seen to fail.

### Sensible

| Cluster | Tabs | Why it is right |
| --- | --- | --- |
| w3 "Wxt · Dev" | 4 | Four GitHub issues of `wxt-dev/wxt`. One site, one subject, and the name is the subject rather than "Github". |
| w5 "Chrome · Extensions" | 4 | `chrome.tabs` ×3 and `chrome.storage`, all API docs. Exactly the pile a user keeps open while coding. |
| w5 "Gitlab · Merge" | 4 | Four merge requests. The titles differ ("Rework the pipeline editor", "cache the policy list") and the shared tokens are the ones that matter. |
| w5 "Lisbona · Tram" | 3 | Google, Il Post and Wikipedia on the tram 28 in Lisbon. **The best case in the fixture:** three different sites, one subject — this is the group a by-site pass cannot make, and the whole reason §7.2 exists. |
| w2 "Monitor · Pollici" | 3 | Two Amazon searches and one Bing search for a 27" monitor. Cross-site again, and shopping is where a user really does open ten tabs. |
| w2 "Annunci · Lombardia" | 3 | Three Subito listings for bicycles in Lombardy. |
| w1 "Public · Suffix" | 3 | Two YouTube tabs on the Public Suffix List and a DuckDuckGo search for it. |
| w3 "Shipping · Stores" | 3 | The same article three times. A cluster of duplicates is still the right cluster; which of them to close is §4.3's question, not this one. |
| w6 "Case · Homes" | 2 | Two Airbnb searches, Sintra and Lisbon. Small but unambiguous. |
| w6 "Sintra" | 2 | GetYourGuide and Lonely Planet on Sintra. Two sites, one name, nothing else in it. |

### Not sensible

| Cluster | Tabs | What went wrong |
| --- | --- | --- |
| w6 "Node · 1033" | 2 | Alentejo and Lisbon on VisitPortugal: the right pair, named off a path segment (`node/1033`) because the titles share almost nothing. The grouping is good and the **name** is noise. |
| w6 "Belem · G189158" | 2 | Two Tripadvisor restaurant lists. Same failure, from a Tripadvisor path id (`g189158`). |
| w5 "Jpg · 1064" | 2 | Two Wikimedia image pages, `Lisbon_tram_1064.jpg` and `Torre_de_Belem_1273.jpg`. Clustered on the word "jpg" — a file type, not a subject. Both are Lisbon photos, so the pair is defensible by luck, not by reason. |
| w2 "Casa" | 2 | A Trello board named "casa" and a RaiPlay documentary "Presa Diretta la casa di tutti". A word collision: one is housework, the other is housing policy. |
| w1 / w3 "Tab" | 2 each | New-tab pages, grouped because their title is "New Tab". Not a topic at all. |

### What the failures have in common

Two causes, and neither is the threshold:

1. **Titles that are not prose.** Path ids, image filenames and `jpg` become tokens like any other.
   `stripSiteSuffix` and the stop words of §7.2.1 remove the site name and the filler; they do not
   know that `g189158` carries no meaning.
2. **The name, not the membership.** In three of the five bad cases the tabs belong together and
   only the label is wrong. That is the cheapest kind of failure the view can have, because §4.4.3
   lets the user retype a name inline before anything is applied — which is exactly what the
   editable preview is for.

Numeric and id-like tokens could be dropped in §7.2.1 (anything with no letter in it, say). It is
not done here: it is a change to the shipped tokenizer, M4.4's scope is this review and the E2E
tests, and the harm it fixes is a name the user can already correct in the preview. Noted here so
the next person reading this file knows it was considered.

## The threshold

§7.2.3 puts the cosine threshold at "~0.25" and leaves the exact value open. Three alternatives
were measured on the same 300 tabs, changing nothing else:

| Threshold | Groups | Left in "Altro" | What it does to the result |
| --- | --- | --- | --- |
| 0.20 | 44 | 162 | **Over-merges.** w4 gains a group called "Tab" with five tabs: the Twitch stream "Live coding: a tab manager in two hours" ×3 together with two New Tab pages. w1 merges "Amazon.it: monitor 27 pollici usb c" with "Amazon.it: lampada da scrivania led" — a monitor and a desk lamp. |
| **0.25 (shipped)** | **45** | **169** | The table above. |
| 0.30 | 45 | 173 | **Loses the good cross-site clusters and gains junk.** "Lisbona · Tram" is gone, its three tabs back in "Altro"; so is w3 "Google · Search". In their place w3 gets "1197 · 1202", two Jira tickets clustered on their numbers. |
| 0.35 | 44 | 177 | Worse in the same direction: "Lisbona · Tram" still gone, and the groups that survive ("Wxt · Dev", "Gitlab · Merge", "Chrome · Extensions", "Case · Homes") are the ones a by-site pass would have found anyway. |

**Decision: 0.25 stays.** It is the only one of the four that keeps the cross-site clusters —
"Lisbona · Tram", "Monitor · Pollici" — which is the only thing topic mode offers over site mode,
and it does not make the over-merges 0.20 makes. The result is not "clearly poor" in §13's sense:
ten of the fifteen judged clusters are right, and of the five that are not, three are right groups
with a bad name. Recorded in `docs/DECISIONS.md` under M4.4.

## How to run it again

The numbers above come from `groupByTopic` on the fixture, with nothing in between. In a test file,
or in anything that can import `src/core/`:

```ts
import { groupByTopic } from '../../src/core/cluster';
import { loadFixture } from '../fixtures/scoring-input';

const tabs = loadFixture('tabs-300').tabs.map((entry) => entry.tab);
const proposal = groupByTopic(tabs, { threshold: 0.25 });
// proposal.groups: title, color, windowId, tabIds — one per cluster
```

No script is committed for it: a one-off dump is not a gate. What *is* pinned is the behaviour, in
`tests/unit/cluster.test.ts` — that topics are found and named after their own words, that the
answer is identical on every run, that a group of one never happens, and what the threshold does at
its two extremes. The numbers in the tables above are not pinned anywhere and are not meant to be:
they are a reading of one fixture on one day, and re-reading them is the point of this section.
