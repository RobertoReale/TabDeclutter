/**
 * `src/core/ai-grouping.ts`: topical grouping with an injected model (PLAN.md §7.3).
 *
 * There is no model here, only a fake one, which is the point: what is pinned down is what
 * the extension promises whatever the model does. The answer is never trusted — an invented
 * id is discarded, a repeated one counts once, a missing one goes to "Altro" — and when the
 * model cannot answer at all, the §7.2 proposal is what the user gets, identical to the one
 * `cluster.ts` would have returned on its own.
 *
 * Above all: no tab is ever lost or duplicated, because the AI only groups and names and
 * never decides what to close.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiGroupingOptions, Llm, LlmPromptOptions } from '../../src/core/ai-grouping';
import {
  buildPrompt,
  DEFAULT_AI_GROUPING_OPTIONS,
  groupByAi,
  responseConstraintFor,
  SYSTEM_PROMPT,
  tabLine,
} from '../../src/core/ai-grouping';
import type { GroupProposal } from '../../src/core/cluster';
import { colorFor, groupByTopic } from '../../src/core/cluster';
import type { TabInfo } from '../../src/core/types';
import { NO_GROUP_ID } from '../../src/core/types';

/** A tab that is nothing in particular, so a test only states what it is testing. */
function tab(id: number, url: string, title: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

interface Call {
  readonly input: string;
  readonly options: LlmPromptOptions | undefined;
}

interface Fake extends Llm {
  readonly calls: readonly Call[];
}

/** What the model may report about itself, all of it optional (PLAN.md §7.3). */
type Context = Pick<Llm, 'contextWindow' | 'contextUsage' | 'measureInputUsage'>;

/**
 * A model that answers whatever the test says, and remembers what it was asked. `answer`
 * is given the prompt and the index of the call, so a test can make the first attempt fail
 * and the next ones succeed.
 */
function fakeLlm(
  answer: (input: string, call: number) => string | Promise<string>,
  context: Context = {},
): Fake {
  const calls: Call[] = [];
  return {
    ...context,
    calls,
    async prompt(input: string, options?: LlmPromptOptions): Promise<string> {
      calls.push({ input, options });
      return answer(input, calls.length - 1);
    },
  };
}

/** An answer in the shape the schema of PLAN.md §7.3 constrains the model to. */
function answerWith(...groups: { name: string; tabIds: unknown[] }[]): string {
  return JSON.stringify({ groups });
}

/** The ids the prompt listed, which is how a test checks what went into a batch. */
function idsOf(input: string): number[] {
  return [...input.matchAll(/^(\d+)\|/gmu)].map((match) => Number(match[1]));
}

/** Group title → its tabs, which is what the assertions about membership read. */
function membership(proposal: GroupProposal): Record<string, readonly number[]> {
  return Object.fromEntries(proposal.groups.map((group) => [group.title, group.tabIds]));
}

/** Every tab the proposal mentions, grouped or not. */
function covered(proposal: GroupProposal): number[] {
  return [...proposal.groups.flatMap((group) => [...group.tabIds]), ...proposal.ungrouped].sort(
    (a, b) => a - b,
  );
}

/** An error the way the Prompt API throws it: recognised by its `name`. */
function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** Three tabs about Rust and three about cooking, in one window. */
const SIX_TABS: readonly TabInfo[] = [
  tab(1, 'https://doc.rust-lang.org/book/ch01.html', 'Rust async book'),
  tab(2, 'https://doc.rust-lang.org/book/ch02.html', 'Rust async runtime'),
  tab(3, 'https://tokio.rs/tokio/tutorial', 'Rust async tokio'),
  tab(4, 'https://giallozafferano.it/pasta', 'Pasta ricetta facile'),
  tab(5, 'https://giallozafferano.it/pasta-2', 'Pasta ricetta veloce'),
  tab(6, 'https://ricette.it/pasta-3', 'Pasta ricetta forno'),
];

/** The run never uses the real clock, so a timeout is a number and not a wait. */
function at(clock: number, extra: AiGroupingOptions = {}): AiGroupingOptions {
  return { now: () => clock, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the prompt', () => {
  it('lists a tab as id|title|host, with the title truncated to 80 characters', () => {
    const long = `${'a'.repeat(100)} tail`;
    const line = tabLine(tab(7, 'https://www.example.com/path', long));
    expect(line).toBe(`7|${'a'.repeat(80)}|example.com`);
  });

  it('keeps one tab on one line, whatever the title contains', () => {
    const line = tabLine(tab(8, 'https://news.site/a', 'A | B\nC\tD   E'));
    expect(line).toBe('8|A B C D E|news.site');
  });

  it('strips trailing site suffixes before truncating while keeping bare site titles', () => {
    expect(
      tabLine(
        tab(9, 'https://www.youtube.com/watch?v=1', 'Corrado Augias - I promessi sposi - YouTube'),
      ),
    ).toBe('9|Corrado Augias - I promessi sposi|youtube.com');
    expect(
      tabLine(
        tab(10, 'https://gemini.google.com/app/123', 'Studio di una funzione - Google Gemini'),
      ),
    ).toBe('10|Studio di una funzione|gemini.google.com');
    expect(tabLine(tab(11, 'https://www.youtube.com/', 'YouTube'))).toBe('11|YouTube|youtube.com');
  });

  it('asks for JSON only, and for the ids it listed', () => {
    const prompt = buildPrompt(SIX_TABS.slice(0, 2));
    expect(prompt.split('\n')).toHaveLength(4);
    expect(idsOf(prompt)).toEqual([1, 2]);
    expect(prompt).toContain('JSON only');
  });

  it('is the system prompt of the plan, in English', () => {
    expect(SYSTEM_PROMPT).toContain("Group by the user's task or topic, not by website.");
    expect(SYSTEM_PROMPT).toContain("Tabs that fit nowhere go to 'Other'.");
  });

  it('constrains the answer with the schema of §7.3', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }));
    await groupByAi(SIX_TABS, llm, at(0));
    expect(llm.calls[0]?.options?.responseConstraint).toEqual(responseConstraintFor(8, 24));
  });

  it('bounds the schema by the same numbers the validation uses', () => {
    const schema = responseConstraintFor(3, 10) as {
      properties: {
        groups: { maxItems: number; items: { properties: { name: { maxLength: number } } } };
      };
    };
    expect(schema.properties.groups.maxItems).toBe(3);
    expect(schema.properties.groups.items.properties.name.maxLength).toBe(10);
  });
});

describe('a valid answer', () => {
  it('becomes the proposal, named by the model and coloured like §7.2', async () => {
    const llm = fakeLlm(() =>
      answerWith({ name: 'Rust Async', tabIds: [1, 2, 3] }, { name: 'Cucina', tabIds: [4, 5, 6] }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));

    expect(result.source).toBe('ai');
    expect(result.prompts).toBe(1);
    expect(result.answered).toBe(1);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.proposal.mode).toBe('topic');
    expect(membership(result.proposal)).toEqual({
      'Rust Async': [1, 2, 3],
      Cucina: [4, 5, 6],
    });
    expect(result.proposal.ungrouped).toEqual([]);
    expect(result.proposal.groups[0]?.key).toBe('rust async');
    expect(result.proposal.groups[0]?.color).toBe(colorFor('rust async'));
    expect(result.proposal.groups[0]?.windowId).toBe(1);
  });

  it('puts the biggest group first', async () => {
    const llm = fakeLlm(() =>
      answerWith({ name: 'Due', tabIds: [1, 2] }, { name: 'Quattro', tabIds: [3, 4, 5, 6] }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.proposal.groups.map((group) => group.title)).toEqual(['Quattro', 'Due']);
  });

  it('leaves the tabs §7.2 does not consider out of the prompt and out of the proposal', async () => {
    const tabs = [
      ...SIX_TABS,
      tab(7, 'https://pinned.site/a', 'Pinned', { pinned: true }),
      tab(8, 'https://grouped.site/a', 'Grouped', { groupId: 4 }),
      tab(9, 'https://hidden.site/a', 'Hidden', { hidden: true }),
    ];
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }));
    const result = await groupByAi(tabs, llm, at(0));

    expect(idsOf(llm.calls[0]?.input ?? '')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps the windows apart, one prompt each', async () => {
    const tabs = [
      ...SIX_TABS.slice(0, 3),
      ...SIX_TABS.slice(3).map((it) => ({ ...it, windowId: 2 })),
    ];
    const llm = fakeLlm((input) =>
      idsOf(input)[0] === 1
        ? answerWith({ name: 'Rust', tabIds: [1, 2, 3] })
        : answerWith({ name: 'Cucina', tabIds: [4, 5, 6] }),
    );
    const result = await groupByAi(tabs, llm, at(0));

    expect(llm.calls.map((call) => idsOf(call.input))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(result.proposal.groups.map((group) => group.windowId)).toEqual([1, 2]);
  });
});

describe('the answer is not trusted', () => {
  it('discards an id that was never sent', async () => {
    const llm = fakeLlm(() =>
      answerWith(
        { name: 'Rust', tabIds: [1, 2, 999] },
        { name: 'Cucina', tabIds: [4, 5, 6, 1000] },
      ),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));

    expect(membership(result.proposal)).toEqual({ Cucina: [4, 5, 6], Rust: [1, 2] });
    expect(result.proposal.ungrouped).toEqual([3]);
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives a repeated id to the first group that claimed it', async () => {
    const llm = fakeLlm(() =>
      answerWith({ name: 'Rust', tabIds: [1, 2, 3] }, { name: 'Cucina', tabIds: [3, 4, 5, 6] }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));

    expect(membership(result.proposal)).toEqual({ Rust: [1, 2, 3], Cucina: [4, 5, 6] });
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drops a group the duplicates left too small', async () => {
    const llm = fakeLlm(() =>
      answerWith({ name: 'Rust', tabIds: [1, 2, 3, 4] }, { name: 'Cucina', tabIds: [4, 5] }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(membership(result.proposal)).toEqual({ Rust: [1, 2, 3, 4] });
    expect(result.proposal.ungrouped).toEqual([5, 6]);
  });

  it('puts the tabs it forgot in "Altro"', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }));
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.proposal.ungrouped).toEqual([4, 5, 6]);
  });

  it('does not make a group out of "Other"', async () => {
    const llm = fakeLlm(() =>
      answerWith({ name: 'Rust', tabIds: [1, 2, 3] }, { name: 'Other', tabIds: [4, 5, 6] }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(membership(result.proposal)).toEqual({ Rust: [1, 2, 3] });
    expect(result.proposal.ungrouped).toEqual([4, 5, 6]);
  });

  it('ignores a group with no name, a name of spaces, or no ids', async () => {
    const llm = fakeLlm(() =>
      answerWith(
        { name: '  ', tabIds: [1, 2] },
        { name: 'Cucina', tabIds: [4, 5, 6] },
        { name: 'Vuoto', tabIds: [] },
      ),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(membership(result.proposal)).toEqual({ Cucina: [4, 5, 6] });
    expect(result.proposal.ungrouped).toEqual([1, 2, 3]);
  });

  it('ignores a malformed group and an id that is not an integer', async () => {
    const llm = fakeLlm(() =>
      JSON.stringify({
        groups: [
          null,
          'nonsense',
          { name: 42, tabIds: [1, 2] },
          { name: 'NoIds' },
          { name: 'Rust', tabIds: [1, '2', 2.5, null, 3] },
        ],
      }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));
    // Only the last group is usable, and only the two integer ids in it.
    expect(membership(result.proposal)).toEqual({ Rust: [1, 3] });
    expect(result.source).toBe('ai');
    expect(result.proposal.ungrouped).toEqual([2, 4, 5, 6]);
  });

  it('truncates a name the model made too long cleanly at word boundaries when possible', async () => {
    const llm = fakeLlm(() =>
      answerWith(
        { name: 'x'.repeat(40), tabIds: [1, 2, 3] },
        { name: 'Corrado Augias Discussions', tabIds: [4, 5, 6] },
      ),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.proposal.groups.map((group) => group.title)).toEqual([
      'x'.repeat(24),
      'Corrado Augias',
    ]);
  });

  it('drops catch-all group names like Miscellaneous/General and ejects unrelated outliers from entity-anchored groups', async () => {
    const realTabs: TabInfo[] = [
      tab(
        1,
        'https://www.google.com/search?q=isomorfismo',
        'se è un isomorfismo, una base finisce in una base? - Cerca con Google',
      ),
      tab(2, 'https://www.youtube.com/watch?v=a', 'Corrado Augias - I promessi sposi - YouTube'),
      tab(
        3,
        'https://www.youtube.com/watch?v=b',
        'Corrado Augias: I segreti del Vaticano - YouTube',
      ),
      tab(
        4,
        'https://www.youtube.com/watch?v=c',
        'Corraudo Augias e Giorgio Zanchini - Storia - YouTube',
      ),
      tab(5, 'https://www.youtube.com/watch?v=d', 'Addio a Corrado Augias - YouTube'),
      tab(6, 'https://www.repubblica.it/vaticano', 'Il dibattito sul Vaticano e la storia'),
      tab(7, 'https://gemini.google.com/app/1', 'Prodotto scalare standard o generico?'),
      tab(8, 'https://www.youtube.com/watch?v=e', 'Calcolo integrali - YouTube'),
    ];
    const llm = fakeLlm(() =>
      answerWith(
        // Model hallucinates a contiguous [1..6] run dragging `isomorfismo` into Corrado Augias,
        // while tab 6 legitimately shares "vaticano"/"storia" with the Augias anchor tabs.
        { name: 'Corrado Augias Discussions', tabIds: [1, 2, 3, 4, 5, 6] },
        { name: 'Miscellaneous', tabIds: [7, 8] },
        { name: 'Linear Algebra', tabIds: [1, 7, 8] },
      ),
    );
    const result = await groupByAi(realTabs, llm, at(0));
    expect(result.source).toBe('ai');
    // Tab 1 (`isomorfismo`) was ejected from Corrado Augias and claimed by Linear Algebra;
    // Tab 6 stayed because it shares anchor vocabulary; "Miscellaneous" was dropped as catch-all.
    expect(membership(result.proposal)).toEqual({
      'Corrado Augias': [2, 3, 4, 5, 6],
      'Linear Algebra': [1, 7, 8],
    });
    expect(result.proposal.ungrouped).toEqual([]);
  });

  it('leaves large groups with generic-only or translated titles untouched by entity outlier pruning', async () => {
    const translatedTabs: TabInfo[] = [
      tab(1, 'https://it.wikipedia.org/wiki/Dino_Campana', 'Dino Campana'),
      tab(2, 'https://it.wikipedia.org/wiki/Luigi_Magni', 'Luigi Magni'),
      tab(3, 'https://it.wikipedia.org/wiki/Trilussa', 'Trilussa'),
      tab(4, 'https://it.wikipedia.org/wiki/Cesare_Pascarella', 'Cesare Pascarella'),
      tab(5, 'https://it.wikipedia.org/wiki/Giovanni_Papini', 'Giovanni Papini'),
    ];
    const translated = await groupByAi(
      translatedTabs,
      fakeLlm(() => answerWith({ name: 'Italian Poets', tabIds: [1, 2, 3, 4, 5] })),
      at(0),
    );
    expect(membership(translated.proposal)).toEqual({ 'Italian Poets': [1, 2, 3, 4, 5] });

    const genericTitle = await groupByAi(
      translatedTabs,
      fakeLlm(() => answerWith({ name: 'Study Videos', tabIds: [1, 2, 3, 4, 5] })),
      at(0),
    );
    expect(membership(genericTitle.proposal)).toEqual({ 'Study Videos': [1, 2, 3, 4, 5] });

    const shortTitle = await groupByAi(
      translatedTabs,
      fakeLlm(() => answerWith({ name: 'AI', tabIds: [1, 2, 3, 4, 5] })),
      at(0),
    );
    expect(membership(shortTitle.proposal)).toEqual({ AI: [1, 2, 3, 4, 5] });
  });

  it('prunes massive entity range dumps even below 50% anchors, rejects single-word cross-pollination, and locally recovers ejected topics', async () => {
    const dumpTabs: TabInfo[] = [
      // 7 real Corrado Augias anchors (including "live", "storia", "segreti", "lectio magistralis")
      tab(
        1,
        'https://www.youtube.com/watch?v=a1',
        'Senza Filtri Live, Corrado Augias - Siamo davvero scimmie - YouTube',
      ),
      tab(
        2,
        'https://www.youtube.com/watch?v=a2',
        'TIRARE LE SOMME DELLA STORIA - Corrado Augias con Zanchini - YouTube',
      ),
      tab(
        3,
        'https://www.youtube.com/watch?v=a3',
        'Corraudo Augias: I segreti del Vaticano - YouTube',
      ),
      tab(4, 'https://www.youtube.com/watch?v=a4', 'Corrado Augias - I promessi sposi - YouTube'),
      tab(
        5,
        'https://www.youtube.com/watch?v=a5',
        'Addio a Corrado Augias, ultimo saluto - YouTube',
      ),
      tab(
        6,
        'https://www.youtube.com/watch?v=a6',
        'Corrado Augias: Breviario per un confuso presente - YouTube',
      ),
      tab(
        7,
        'https://www.youtube.com/watch?v=a7',
        'Lectio magistralis. Il grande romanzo dei Vangeli - Corrado Augias - YouTube',
      ),
      // 1 legitimate Augias tab whose title omits "Augias" but shares 2 content words with anchor #7
      tab(
        8,
        'https://www.youtube.com/watch?v=a8',
        'Lectio magistralis sulla laicità Stato e Chiesa - YouTube',
      ),
      // 10 completely unrelated tabs dumped into Corrado Augias (7/18 = 38.9% anchors!)
      tab(9, 'https://it.wikipedia.org/wiki/Trilussa', 'Trilussa - Wikipedia'),
      tab(10, 'https://it.wikipedia.org/wiki/Luigi_Magni', 'Luigi Magni - Wikipedia'),
      tab(11, 'https://www.youtube.com/watch?v=m1', 'Gigi Magni Racconta Roma - YouTube'),
      tab(
        12,
        'https://www.youtube.com/watch?v=h1',
        'You can play this Hendrix riff FOREVER - YouTube',
      ),
      tab(
        13,
        'https://gemini.google.com/app/1',
        'Prodotto scalare standard o generico? - Google Gemini',
      ),
      tab(14, 'https://gemini.google.com/app/2', 'Spiegazione del secondo esempio - Google Gemini'),
      tab(
        15,
        'https://www.youtube.com/watch?v=p1',
        'Gigi Proietti parla un napoletano inventato - YouTube',
      ),
      tab(
        16,
        'https://www.youtube.com/watch?v=p2',
        'Mattarella scoppia a ridere con Gigi Proietti - YouTube',
      ),
      // Cross-pollinated with anchor #1 ("live") + anchor #2 ("storia") and stopword "degli"
      tab(
        17,
        'https://www.youtube.com/watch?v=x1',
        'Live #30 - Anti-storia degli Italiani - YouTube',
      ),
      tab(18, 'https://www.youtube.com/watch?v=x2', 'I SEGRETI DEGLI STATI UNITI - YouTube'),
    ];
    const llm = fakeLlm(() =>
      answerWith({
        name: 'Corrado Augias',
        tabIds: dumpTabs.map((t) => t.id),
      }),
    );
    const result = await groupByAi(dumpTabs, llm, at(0));
    expect(result.source).toBe('ai');
    const byName = membership(result.proposal);
    // Corrado Augias keeps ONLY the 7 anchors + tab 8 (shares "lectio" + "magistralis" with #7).
    expect(byName['Corrado Augias']).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Ejected unrelated pairs are automatically recovered by local TF-IDF fallbackDrafts.
    expect(Object.values(byName)).toContainEqual([10, 11]);
    expect(Object.values(byName)).toContainEqual([15, 16]);
    // Cross-pollinated unrelated tabs (#17, #18) and Hendrix (#12) never stay in Corrado Augias.
    expect(byName['Corrado Augias']).not.toContain(12);
    expect(byName['Corrado Augias']).not.toContain(17);
    expect(byName['Corrado Augias']).not.toContain(18);
  });

  it('merges equivalent AI and local fallback titles such as "Corrado Augias" and "Augias · Corrado"', async () => {
    const augiasTabs: TabInfo[] = [
      tab(1, 'https://www.youtube.com/watch?v=1', 'Corrado Augias - I promessi sposi - YouTube'),
      tab(
        2,
        'https://www.youtube.com/watch?v=2',
        'Corrado Augias - I segreti del Vaticano - YouTube',
      ),
      tab(
        3,
        'https://www.youtube.com/watch?v=3',
        'Corrado Augias - La vita e il romanzo - YouTube',
      ),
      tab(
        4,
        'https://www.youtube.com/watch?v=4',
        'Corrado Augias - Breviario per un confuso presente - YouTube',
      ),
      tab(
        5,
        'https://www.youtube.com/watch?v=5',
        'Corrado Augias - Lectio magistralis sulla laicità - YouTube',
      ),
      tab(
        6,
        'https://www.youtube.com/watch?v=6',
        'Corrado Augias - Addio ai telespettatori - YouTube',
      ),
    ];
    // Truncated JSON leaves tabs 4..6 to local fallback, which titles them "Augias · Corrado".
    const llm = fakeLlm(() => '```json\n{"groups":[{"name":"Corrado Augias","tabIds":[1,2,3');
    const result = await groupByAi(augiasTabs, llm, at(0));
    expect(result.source).toBe('ai');
    expect(membership(result.proposal)).toEqual({
      'Corrado Augias': [1, 2, 3, 4, 5, 6],
    });
  });

  it('merges two groups of one window that came back with the same name', async () => {
    // Three tabs per prompt, so one window is asked about twice (PLAN.md §7.3).
    const llm = fakeLlm((input) => answerWith({ name: 'Rust', tabIds: idsOf(input) }));
    const result = await groupByAi(SIX_TABS, llm, at(0, { maxBatchTabs: 3 }));

    expect(llm.calls).toHaveLength(2);
    expect(membership(result.proposal)).toEqual({ Rust: [1, 2, 3, 4, 5, 6] });
  });

  it('extracts JSON wrapped in markdown fences or brief prose', async () => {
    const fenced = fakeLlm(
      () => `\`\`\`json\n${answerWith({ name: 'Math', tabIds: [1, 2, 3] })}\n\`\`\``,
    );
    const fencedResult = await groupByAi(SIX_TABS, fenced, at(0));
    expect(fencedResult.source).toBe('ai');
    expect(membership(fencedResult.proposal)).toEqual({ Math: [1, 2, 3] });

    const wrapped = fakeLlm(
      () => `Here are the groups:\n${answerWith({ name: 'Cooking', tabIds: [4, 5, 6] })}\nDone.`,
    );
    const wrappedResult = await groupByAi(SIX_TABS, wrapped, at(0));
    expect(wrappedResult.source).toBe('ai');
    expect(membership(wrappedResult.proposal)).toEqual({ Cooking: [4, 5, 6] });

    // Gemini Nano unconstrained quirk reproduced live: each `{...}` inside `"groups":[...]`
    // wrapped in stray quotes (`"{"name":"...","tabIds":[...]}"`) or JSON-stringified.
    const strayQuoted = fakeLlm(
      () =>
        '```json\n{"groups":["{"name":"Corrado Augias Talks","tabIds":[1,2,3]}","{\\"name\\":\\"Cooking\\",\\"tabIds\\":[4,5,6]}"]}\n```',
    );
    const strayQuotedResult = await groupByAi(SIX_TABS, strayQuoted, at(0));
    expect(strayQuotedResult.source).toBe('ai');
    expect(membership(strayQuotedResult.proposal)).toEqual({
      'Corrado Augias Talks': [1, 2, 3],
      Cooking: [4, 5, 6],
    });

    // Gemini Nano omitting `},{` between groups inside `"groups":[{...}]` (so raw JSON.parse
    // would overwrite earlier duplicate `"name"`/`"tabIds"` keys with the final `"Other"`),
    // or truncating the final `"tabIds":[...` array before closing `]}`.
    const collapsedAndTruncated = fakeLlm(
      () =>
        '```json\n{"groups":[{"name":"Corrado Augias Lectures","tabIds":[1,2,3],"name":"Cooking","tabIds":[4,5],"name":"Other","tabIds":[6]}]}\n```',
    );
    const collapsedResult = await groupByAi(SIX_TABS, collapsedAndTruncated, at(0));
    expect(collapsedResult.source).toBe('ai');
    expect(membership(collapsedResult.proposal)).toEqual({
      'Corrado Augias Lectures': [1, 2, 3],
      Cooking: [4, 5],
    });

    const truncated = fakeLlm(
      () => '```json\n{"groups":[{"name":"Corrado Augias Lectures","tabIds":[1,2,3,4',
    );
    const truncatedResult = await groupByAi(SIX_TABS, truncated, at(0));
    expect(truncatedResult.source).toBe('ai');
    // Tabs 5 and 6 were never reached before truncation, so §7.2 local clustering recovers them
    // instead of dumping the unreached tail into "Other".
    expect(membership(truncatedResult.proposal)).toEqual({
      'Corrado Augias Lectures': [1, 2, 3, 4],
      'Pasta · Ricetta': [5, 6],
    });
  });

  it('recognizes a TimeoutError thrown by the session as a timeout fallback', async () => {
    const llm = fakeLlm(() => {
      throw named('TimeoutError');
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('timeout');
  });

  it('keeps at most maxGroups groups per window, the rest in "Altro"', async () => {
    const llm = fakeLlm(() =>
      answerWith(
        { name: 'Uno', tabIds: [1, 2, 3] },
        { name: 'Due', tabIds: [4, 5] },
        { name: 'Tre', tabIds: [6] },
      ),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0, { maxGroups: 1, minClusterTabs: 1 }));
    expect(membership(result.proposal)).toEqual({ Uno: [1, 2, 3] });
    expect(result.proposal.ungrouped).toEqual([4, 5, 6]);
  });
});

describe('when the model cannot answer', () => {
  /** What §7.2 would have proposed on its own: the fallback has to be exactly this. */
  function fallbackOf(tabs: readonly TabInfo[], options: AiGroupingOptions = {}): GroupProposal {
    return groupByTopic(tabs, options);
  }

  it('falls back to §7.2 on an answer that is not JSON', async () => {
    const llm = fakeLlm(() => 'I am a language model, not a JSON writer.');
    const result = await groupByAi(SIX_TABS, llm, at(0));

    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('unparsable');
    expect(result.answered).toBe(0);
    expect(result.proposal).toEqual(fallbackOf(SIX_TABS));
  });

  it('falls back on JSON that is not the schema shape', async () => {
    for (const answer of ['[]', 'null', '42', '{"groups":"nope"}', '{}']) {
      const llm = fakeLlm(() => answer);
      const result = await groupByAi(SIX_TABS, llm, at(0));
      expect(result.fallbackReason).toBe('unparsable');
      expect(result.proposal).toEqual(fallbackOf(SIX_TABS));
    }
  });

  it('falls back when the answer holds no usable group', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Other', tabIds: [1, 2, 3, 4, 5, 6] }));
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.fallbackReason).toBe('no-groups');
    expect(result.proposal).toEqual(fallbackOf(SIX_TABS));
  });

  it('falls back when the model throws', async () => {
    const llm = fakeLlm(() => {
      throw new Error('the session is gone');
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.fallbackReason).toBe('error');
    expect(result.fallbackDetail).toContain('the session is gone');
    expect(result.proposal).toEqual(fallbackOf(SIX_TABS));
  });

  it('falls back when the model throws something that is not an error at all', async () => {
    const llm = fakeLlm(() => {
      // Not an Error: a thrown string has no `name` to recognise it by.
      throw 'boom';
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(result.fallbackReason).toBe('error');
  });

  it('has nothing to ask when no tab is eligible', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1] }));
    const result = await groupByAi([], llm, at(0));

    expect(llm.calls).toHaveLength(0);
    expect(result.prompts).toBe(0);
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('empty');
    expect(result.proposal.groups).toEqual([]);
  });

  it('keeps the batches the model did answer, and lets §7.2 group the others', async () => {
    const llm = fakeLlm((input, call) =>
      call === 0 ? answerWith({ name: 'Rust', tabIds: idsOf(input) }) : 'not json',
    );
    const result = await groupByAi(SIX_TABS, llm, at(0, { maxBatchTabs: 3 }));

    expect(result.source).toBe('ai');
    expect(result.answered).toBe(1);
    expect(result.prompts).toBe(2);
    expect(result.fallbackReason).toBe('unparsable');
    // The model named the first batch; the second kept the §7.2 title for its tabs.
    expect(result.proposal.groups[0]?.title).toBe('Rust');
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('ungroups a failed batch §7.2 had nothing to say about either', async () => {
    const tabs = [
      ...SIX_TABS,
      tab(7, 'https://unrelated.site/x', 'Qualcosa di diverso xyzzy'),
      tab(8, 'https://another.site/y', 'Altra cosa ancora plugh'),
    ];
    const llm = fakeLlm((input, call) =>
      call === 0 ? answerWith({ name: 'Rust', tabIds: idsOf(input) }) : 'not json',
    );
    const result = await groupByAi(tabs, llm, at(0, { maxBatchTabs: 3 }));

    expect(result.source).toBe('ai');
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('the context and the quota', () => {
  it('splits the batch when the prompt does not fit what is left of the context', async () => {
    const full = buildPrompt(SIX_TABS).length;
    const llm = fakeLlm((input) => answerWith({ name: 'Rust', tabIds: idsOf(input) }), {
      contextWindow: 300 + full - 1,
      contextUsage: 0,
      measureInputUsage: (input: string) => Promise.resolve(input.length),
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));

    // The prompt that did not fit was never sent: only the two halves were.
    expect(llm.calls.map((call) => idsOf(call.input))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(result.prompts).toBe(2);
    expect(result.answered).toBe(2);
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('counts the context the session has already spent', async () => {
    const full = buildPrompt(SIX_TABS).length;
    const llm = fakeLlm((input) => answerWith({ name: 'Rust', tabIds: idsOf(input) }), {
      contextWindow: 300 + full,
      contextUsage: 1,
      measureInputUsage: (input: string) => Promise.resolve(input.length),
    });
    await groupByAi(SIX_TABS, llm, at(0));
    expect(llm.calls).toHaveLength(2);
  });

  it('asks a model that reports no context window', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }), {
      contextWindow: 0,
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(llm.calls).toHaveLength(1);
    expect(result.answered).toBe(1);
  });

  it('estimates the cost when the model cannot measure it', async () => {
    const full = buildPrompt(SIX_TABS).length;
    const llm = fakeLlm((input) => answerWith({ name: 'Rust', tabIds: idsOf(input) }), {
      // Four characters per token, so the whole prompt is estimated over the window.
      contextWindow: 300 + Math.ceil(full / 4) - 1,
    });
    await groupByAi(SIX_TABS, llm, at(0));
    expect(llm.calls).toHaveLength(2);
  });

  it('estimates the cost when measuring it fails', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }), {
      contextWindow: 100_000,
      measureInputUsage: () => Promise.reject(new Error('no can do')),
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));
    expect(llm.calls).toHaveLength(1);
    expect(result.answered).toBe(1);
  });

  it('retries a smaller batch on QuotaExceededError', async () => {
    const llm = fakeLlm((input, call) => {
      if (call === 0) throw named('QuotaExceededError');
      return answerWith({ name: 'Rust', tabIds: idsOf(input) });
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));

    expect(llm.calls.map((call) => idsOf(call.input))).toEqual([
      [1, 2, 3, 4, 5, 6],
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(result.source).toBe('ai');
    expect(result.prompts).toBe(3);
    expect(result.answered).toBe(2);
    expect(result.fallbackReason).toBeUndefined();
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives up on a single tab that still does not fit, and §7.2 answers', async () => {
    const llm = fakeLlm(() => {
      throw named('QuotaExceededError');
    });
    const result = await groupByAi(SIX_TABS, llm, at(0));

    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('quota');
    expect(result.proposal).toEqual(groupByTopic(SIX_TABS));
    // Six tabs halved down to one: eleven prompts, every one of them refused.
    expect(result.prompts).toBe(11);
  });
});

describe('the deadline and "Annulla"', () => {
  it('does not ask at all once the budget is spent', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }));
    const result = await groupByAi(SIX_TABS, llm, { now: () => 0, timeoutMs: 0 });

    expect(llm.calls).toHaveLength(0);
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('timeout');
    expect(result.proposal).toEqual(groupByTopic(SIX_TABS));
  });

  it('stops waiting after the timeout, aborts the model and falls back to §7.2', async () => {
    vi.useFakeTimers();
    const llm = fakeLlm(() => new Promise<string>(() => {}));
    const run = groupByAi(SIX_TABS, llm, { timeoutMs: 20_000 });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.options?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    expect(llm.calls[0]?.options?.signal?.aborted).toBe(true);
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('timeout');
    expect(result.proposal).toEqual(groupByTopic(SIX_TABS));
  });

  it('shares one budget across the batches', async () => {
    vi.useFakeTimers();
    let answered = 0;
    const llm = fakeLlm(
      (input) =>
        new Promise<string>((keep) => {
          setTimeout(() => {
            answered += 1;
            keep(answerWith({ name: `Gruppo ${answered}`, tabIds: idsOf(input) }));
          }, 15_000);
        }),
    );
    const run = groupByAi(SIX_TABS, llm, { timeoutMs: 20_000, maxBatchTabs: 3 });

    await vi.advanceTimersByTimeAsync(40_000);
    const result = await run;

    // The first batch took 15 s of the 20 s, so the second ran out of time.
    expect(result.source).toBe('ai');
    expect(result.answered).toBe(1);
    expect(result.fallbackReason).toBe('timeout');
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('does not ask when the caller has already cancelled', async () => {
    const llm = fakeLlm(() => answerWith({ name: 'Rust', tabIds: [1, 2, 3] }));
    const controller = new AbortController();
    controller.abort();
    const result = await groupByAi(SIX_TABS, llm, at(0, { signal: controller.signal }));

    expect(llm.calls).toHaveLength(0);
    expect(result.fallbackReason).toBe('aborted');
    expect(result.proposal).toEqual(groupByTopic(SIX_TABS));
  });

  it('passes "Annulla" on to the model and falls back on its AbortError', async () => {
    const controller = new AbortController();
    const llm = fakeLlm(
      (_input) =>
        new Promise<string>((_keep, reject) => {
          // Abort as soon as the model is asked, the way the spinner's button would.
          controller.abort();
          setTimeout(() => reject(named('AbortError')), 0);
        }),
    );
    const result = await groupByAi(SIX_TABS, llm, at(0, { signal: controller.signal }));

    expect(llm.calls[0]?.options?.signal?.aborted).toBe(true);
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('aborted');
  });
});

describe('more than one batch of tabs', () => {
  /** `count` tabs about `topic`, on one host: a macro-cluster §7.2 cannot miss. */
  function topic(from: number, count: number, host: string, words: string): TabInfo[] {
    return Array.from({ length: count }, (_unused, index) =>
      tab(from + index, `https://${host}/${words}/${index}`, `${words} numero ${index}`),
    );
  }

  const MANY: readonly TabInfo[] = [
    ...topic(1, 30, 'doc.rust-lang.org', 'rust async'),
    ...topic(31, 30, 'giallozafferano.it', 'pasta ricetta'),
    ...topic(61, 30, 'visitportugal.com', 'lisbona tram'),
  ];

  it('pre-clusters with §7.2 and keeps every prompt inside the batch size', async () => {
    const llm = fakeLlm((input, call) =>
      answerWith({ name: `Tema ${call}`, tabIds: idsOf(input) }),
    );
    const result = await groupByAi(MANY, llm, at(0));

    expect(result.prompts).toBeGreaterThan(1);
    for (const call of llm.calls) {
      expect(idsOf(call.input).length).toBeLessThanOrEqual(
        DEFAULT_AI_GROUPING_OPTIONS.maxBatchTabs,
      );
    }
    // A macro-cluster is never spread over two prompts: each batch is one topic.
    for (const call of llm.calls) {
      const decades = new Set(idsOf(call.input).map((id) => Math.floor((id - 1) / 30)));
      expect(decades.size).toBe(1);
    }
    expect(result.source).toBe('ai');
    expect(covered(result.proposal)).toEqual(MANY.map((it) => it.id));
  });

  it('packs the small clusters together instead of asking once per pair', async () => {
    const tabs = [...SIX_TABS, ...topic(7, 4, 'lonelyplanet.com', 'lisbona tram')];
    const llm = fakeLlm((input, call) =>
      answerWith({ name: `Tema ${call}`, tabIds: idsOf(input) }),
    );
    const result = await groupByAi(tabs, llm, at(0, { maxBatchTabs: 7 }));

    // Ten tabs, three §7.2 clusters, batches of at most seven: two prompts, not three.
    expect(result.prompts).toBe(2);
    expect(covered(result.proposal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('cuts a macro-cluster bigger than a whole batch into pieces', async () => {
    const llm = fakeLlm((input, call) =>
      answerWith({ name: `Tema ${call}`, tabIds: idsOf(input) }),
    );
    const result = await groupByAi(MANY, llm, at(0, { maxBatchTabs: 10 }));

    expect(llm.calls).toHaveLength(9);
    for (const call of llm.calls) expect(idsOf(call.input)).toHaveLength(10);
    expect(covered(result.proposal)).toEqual(MANY.map((it) => it.id));
  });

  it('pre-clusters each window with its own §7.2 groups', async () => {
    const tabs = [...MANY, ...MANY.map((it) => ({ ...it, id: it.id + 100, windowId: 2 }))];
    const llm = fakeLlm((input, call) =>
      answerWith({ name: `Tema ${call}`, tabIds: idsOf(input) }),
    );
    const result = await groupByAi(tabs, llm, at(0));

    // No prompt ever mixes two windows: a batch is built out of one window's clusters.
    for (const call of llm.calls) {
      const windows = new Set(idsOf(call.input).map((id) => (id > 100 ? 2 : 1)));
      expect(windows.size).toBe(1);
    }
    expect(covered(result.proposal)).toEqual(tabs.map((it) => it.id).sort((a, b) => a - b));
  });

  it('never loses or duplicates a tab, whatever the model answers', async () => {
    const llm = fakeLlm((input, call) => {
      const ids = idsOf(input);
      if (call === 1) return 'not json';
      if (call === 2) throw named('QuotaExceededError');
      return answerWith(
        { name: `Tema ${call}`, tabIds: [...ids.slice(0, 5), 99_999] },
        { name: 'Other', tabIds: ids.slice(5, 7) },
      );
    });
    const result = await groupByAi(MANY, llm, at(0));

    expect(covered(result.proposal)).toEqual(MANY.map((it) => it.id));
    expect(new Set(covered(result.proposal)).size).toBe(MANY.length);
  });

  it('forwards onStage and appends llm.lastTrace to timeout and error diagnostics', async () => {
    const stages: string[] = [];
    const timeoutLlm: Llm = {
      lastTrace: 'stage=prefill (clone=0.0s · no 1st token · 0 chars/0 chunks)',
      prompt: async (_input, options) => {
        options?.onStage?.('prefill (waiting for 1st token)');
        throw named('TimeoutError');
      },
    };
    const timedOut = await groupByAi(
      SIX_TABS,
      timeoutLlm,
      at(0, { onStage: (s) => stages.push(s) }),
    );
    expect(stages[0]).toContain('measure');
    expect(stages).toContain('prefill (waiting for 1st token)');
    expect(timedOut.fallbackReason).toBe('timeout');
    expect(timedOut.fallbackDetail).toContain('stage=prefill');

    const errorLlm: Llm = {
      lastTrace: 'stage=clone',
      prompt: async () => {
        throw new Error('backend crashed');
      },
    };
    const errored = await groupByAi(SIX_TABS, errorLlm, at(0));
    expect(errored.fallbackReason).toBe('error');
    expect(errored.fallbackDetail).toContain('backend crashed');
    expect(errored.fallbackDetail).toContain('stage=clone');
  });
});
