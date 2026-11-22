import { afterEach, describe, expect, it, vi } from 'vitest';

import { responseConstraintFor, SYSTEM_PROMPT } from '../../src/core/ai-grouping';
import type {
  LanguageModelCreateOptions,
  LanguageModelMonitor,
  LanguageModelSession,
} from '../../src/platform/llm';
import {
  AiSession,
  checkAvailability,
  closeSession,
  downloadModel,
  extractCompleteGroupsJson,
  isDegenerateStream,
  languageModel,
  panelSession,
} from '../../src/platform/llm';

/**
 * `platform/llm.ts` against a `LanguageModel` of our own (PLAN.md §7.3).
 *
 * Everything the real API does that matters here is scripted: the five availability
 * states, a download that reports progress, a session that answers, one that never does,
 * and one that cannot measure an input. The module takes the API as a parameter
 * (TASKS.md §2.4), so none of this needs a global or a browser.
 */

/** A session that answers whatever it was told to, and remembers how it was asked. */
class FakeSession implements LanguageModelSession {
  contextWindow?: number;
  contextUsage?: number;
  destroyed = 0;
  readonly asked: {
    input: string;
    responseConstraint?: unknown;
    omitResponseConstraintInput?: boolean;
    signal?: AbortSignal;
  }[] = [];
  readonly measured: string[] = [];
  readonly answer: (input: string) => Promise<string>;
  /** Absent when the model cannot measure, which the real API allows. */
  measureInputUsage?: (input: string) => Promise<number>;

  constructor(
    answer: (input: string) => Promise<string>,
    usage?: (input: string) => Promise<number>,
  ) {
    this.answer = answer;
    if (usage !== undefined) {
      this.measureInputUsage = async (input: string) => {
        this.measured.push(input);
        return usage(input);
      };
    }
  }

  async prompt(
    input: string,
    options: {
      responseConstraint?: unknown;
      omitResponseConstraintInput?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    this.asked.push({ input, ...options });
    return this.answer(input);
  }

  destroy(): void {
    this.destroyed += 1;
  }
}

interface FakeApiOptions {
  readonly state?: string;
  readonly answer?: (input: string) => Promise<string>;
  readonly usage?: (input: string) => Promise<number>;
  /** Fractions the download reports before `create` resolves. */
  readonly progress?: readonly number[];
  /** What `create` does instead of succeeding. */
  readonly failCreate?: () => Promise<never>;
  readonly failAvailability?: boolean;
  /** Held here until it resolves, which is how a slow download is scripted. */
  readonly hold?: () => Promise<void>;
}

class FakeApi {
  readonly created: LanguageModelCreateOptions[] = [];
  readonly asked: LanguageModelCreateOptions[] = [];
  sessions: FakeSession[] = [];
  state: string;

  constructor(private readonly options: FakeApiOptions = {}) {
    this.state = options.state ?? 'available';
  }

  availability = async (options: LanguageModelCreateOptions = {}): Promise<string> => {
    this.asked.push(options);
    if (this.options.failAvailability === true) throw new Error('no');
    return this.state;
  };

  create = async (options: LanguageModelCreateOptions = {}): Promise<LanguageModelSession> => {
    this.created.push(options);
    if (this.options.progress !== undefined) {
      const listeners: ((event: { loaded: number }) => void)[] = [];
      const monitor: LanguageModelMonitor = {
        addEventListener: (_type, listener) => listeners.push(listener),
      };
      options.monitor?.(monitor);
      for (const loaded of this.options.progress) {
        for (const listener of listeners) listener({ loaded });
      }
    }
    if (this.options.hold !== undefined) await this.options.hold();
    if (this.options.failCreate !== undefined) return this.options.failCreate();
    const session = new FakeSession(
      this.options.answer ?? (async () => '{"groups":[]}'),
      this.options.usage,
    );
    this.sessions.push(session);
    return session;
  };
}

afterEach(() => {
  closeSession();
  vi.useRealTimers();
});

describe('languageModel', () => {
  it('is whatever the globals call LanguageModel', () => {
    const api = new FakeApi();
    expect(languageModel({ LanguageModel: api })).toBe(api);
  });

  it('is undefined on a browser without one, which is every Firefox', () => {
    expect(languageModel({})).toBeUndefined();
    // Something by that name that is not the API is not the API.
    expect(languageModel({ LanguageModel: {} })).toBeUndefined();
  });
});

describe('checkAvailability', () => {
  it('says unsupported when there is no API at all', async () => {
    await expect(checkAvailability(undefined)).resolves.toBe('unsupported');
  });

  it.each(['unavailable', 'downloadable', 'downloading', 'available'] as const)(
    'reports %s as the browser does',
    async (state) => {
      await expect(checkAvailability(new FakeApi({ state }))).resolves.toBe(state);
    },
  );

  it('asks about the languages the session will use', async () => {
    const api = new FakeApi();
    await checkAvailability(api);
    expect(api.asked[0]).toMatchObject({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
  });

  it('reads a state it does not know as unavailable', async () => {
    await expect(checkAvailability(new FakeApi({ state: 'after-download' }))).resolves.toBe(
      'unavailable',
    );
  });

  it('reads a browser that cannot answer as unavailable', async () => {
    await expect(checkAvailability(new FakeApi({ failAvailability: true }))).resolves.toBe(
      'unavailable',
    );
  });
});

describe('AiSession', () => {
  it('creates nothing until something is asked', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });
    expect(api.created).toHaveLength(0);
    expect(session.isOpen).toBe(false);

    await session.prompt('one');
    expect(api.created).toHaveLength(1);
    expect(session.isOpen).toBe(true);
  });

  it('creates the session without initialPrompts and prepends the system prompt to each prompt', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });

    await session.prompt('one');
    await session.prompt('two');

    expect(api.created).toHaveLength(1);
    expect(api.created[0]?.initialPrompts).toBeUndefined();
    expect(api.sessions[0]?.asked.map((ask) => ask.input)).toEqual([
      `${SYSTEM_PROMPT}\n\none`,
      `${SYSTEM_PROMPT}\n\ntwo`,
    ]);
  });

  it('shares one creation between two calls made at once', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });

    await Promise.all([session.prompt('one'), session.prompt('two')]);

    expect(api.created).toHaveLength(1);
  });

  it('omits responseConstraint by default and passes it with omitResponseConstraintInput when enabled', async () => {
    const defaultApi = new FakeApi();
    const defaultSession = new AiSession({ api: defaultApi });
    const constraint = { type: 'object' };

    await defaultSession.prompt('one', { responseConstraint: constraint });
    expect(defaultApi.sessions[0]?.asked[0]?.responseConstraint).toBeUndefined();
    expect(defaultApi.sessions[0]?.asked[0]?.omitResponseConstraintInput).toBeUndefined();
    expect(defaultApi.sessions[0]?.asked[0]?.signal).toBeInstanceOf(AbortSignal);

    const api = new FakeApi();
    const session = new AiSession({ api, useResponseConstraint: true });

    await session.prompt('one', { responseConstraint: constraint });
    await session.prompt('two');

    const constrainedAsk = api.sessions[0]?.asked[0];
    expect(constrainedAsk?.responseConstraint).toBe(constraint);
    expect(constrainedAsk?.omitResponseConstraintInput).toBe(true);
    expect(constrainedAsk?.signal).toBeInstanceOf(AbortSignal);

    const freeAsk = api.sessions[0]?.asked[1];
    expect(freeAsk?.responseConstraint).toBeUndefined();
    expect(freeAsk?.omitResponseConstraintInput).toBeUndefined();
  });

  it('reports the context the live session has', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });
    expect(session.contextWindow).toBeUndefined();

    await session.prompt('one');
    const live = api.sessions[0];
    if (live !== undefined) {
      live.contextWindow = 6144;
      live.contextUsage = 120;
    }

    expect(session.contextWindow).toBe(6144);
    expect(session.contextUsage).toBe(120);
  });

  it('destroys the session when the panel closes, and forgets it', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });
    await session.prompt('one');

    session.close();

    expect(api.sessions[0]?.destroyed).toBe(1);
    expect(session.isOpen).toBe(false);
    expect(session.contextWindow).toBeUndefined();

    // A later question is a new session, not a destroyed one asked again.
    await session.prompt('two');
    expect(api.created).toHaveLength(2);
  });

  it('does not remember a creation that failed', async () => {
    let attempt = 0;
    const api = new FakeApi({
      failCreate: () => {
        attempt += 1;
        return Promise.reject(new Error('busy'));
      },
    });
    const session = new AiSession({ api });

    await expect(session.prompt('one')).rejects.toThrow('busy');
    await expect(session.prompt('two')).rejects.toThrow('busy');
    expect(attempt).toBe(2);
  });

  it('throws when there is no API behind it', async () => {
    const session = new AiSession({ api: undefined });
    await expect(session.prompt('one')).rejects.toThrow(/no on-device model/);
  });

  it('gives up after 20 s and aborts what it was waiting for', async () => {
    vi.useFakeTimers();
    const api = new FakeApi({ answer: () => new Promise<string>(() => undefined) });
    const session = new AiSession({ api });

    const pending = session.prompt('one');
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await caught).toMatchObject({ name: 'TimeoutError' });
    expect(api.sessions[0]?.asked[0]?.signal?.aborted).toBe(true);
  });

  it('waits as long as the model needs, up to that', async () => {
    vi.useFakeTimers();
    let answer: (text: string) => void = () => undefined;
    const api = new FakeApi({
      answer: () =>
        new Promise<string>((keep) => {
          answer = keep;
        }),
    });
    const session = new AiSession({ api });

    const pending = session.prompt('one');
    await vi.advanceTimersByTimeAsync(19_000);
    answer('{"groups":[]}');

    await expect(pending).resolves.toBe('{"groups":[]}');
  });

  it('stops on the caller\'s signal, which is "Annulla"', async () => {
    const api = new FakeApi({ answer: () => new Promise<string>(() => undefined) });
    const session = new AiSession({ api });
    const controller = new AbortController();

    const pending = session.prompt('one', { signal: controller.signal });
    const caught = pending.catch((error: unknown) => error);
    controller.abort(new DOMException('cancelled', 'AbortError'));

    expect(await caught).toMatchObject({ name: 'AbortError' });
    expect(api.sessions[0]?.asked[0]?.signal?.aborted).toBe(true);
  });

  it('stops at once when the signal was aborted before the call', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });

    await expect(
      session.prompt('one', { signal: AbortSignal.abort(new DOMException('gone', 'AbortError')) }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.created).toHaveLength(0);
  });

  it('measures an input with the model when it can', async () => {
    const api = new FakeApi({ usage: async () => 42 });
    const session = new AiSession({ api });

    await expect(session.measureInputUsage('one')).resolves.toBe(42);
    expect(api.sessions[0]?.measured).toEqual(['one']);
  });

  it('says so when the session cannot measure, which is not an error for the caller', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });

    await expect(session.measureInputUsage('one')).rejects.toThrow(/cannot measure/);
  });

  it('strips maxLength and maxItems from responseConstraint and adds additionalProperties: false when useResponseConstraint is enabled', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api, useResponseConstraint: true });

    await session.prompt('one', { responseConstraint: responseConstraintFor(8, 24) });

    const sent = api.sessions[0]?.asked[0]?.responseConstraint as Record<string, unknown>;
    expect(sent).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['groups'],
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'tabIds'],
            properties: {
              name: { type: 'string' },
              tabIds: { type: 'array', items: { type: 'integer' } },
            },
          },
        },
      },
    });
  });

  it('clones the base session when clone() is supported and destroys the clone afterwards', async () => {
    const clonedSessions: FakeSession[] = [];
    const baseSession = new FakeSession(async () => '{"groups":[]}');
    const cloneable: LanguageModelSession = {
      prompt: baseSession.prompt.bind(baseSession),
      destroy: baseSession.destroy.bind(baseSession),
      clone: async () => {
        const copy = new FakeSession(async () => '{"groups":[{"name":"Math","tabIds":[1,2]}]}');
        clonedSessions.push(copy);
        return copy;
      },
    };
    const api = {
      availability: async () => 'available',
      create: async () => cloneable,
    };
    const session = new AiSession({ api });

    await expect(session.prompt('tabs')).resolves.toContain('Math');
    expect(clonedSessions).toHaveLength(1);
    expect(clonedSessions[0]?.destroyed).toBe(1);
    expect(baseSession.destroyed).toBe(0);
  });

  it('retries cleanly without responseConstraint when Chrome rejects with NotSupportedError', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const api = new FakeApi({
      answer: async () => {
        calls += 1;
        if (calls === 1) {
          throw new DOMException(
            'The model attempted to output text in an untested language.',
            'NotSupportedError',
          );
        }
        return '{"groups":[{"name":"Math","tabIds":[1,2]}]}';
      },
    });
    const session = new AiSession({ api, useResponseConstraint: true });

    const reply = await session.prompt('1|Basi ortogonali|gemini.google.com', {
      responseConstraint: responseConstraintFor(8, 24),
    });

    expect(reply).toContain('Math');
    expect(calls).toBe(2);
    // Reset the session after the error when clone() is unavailable and dropped responseConstraint.
    expect(api.created).toHaveLength(2);
    expect(api.sessions[1]?.asked[0]?.responseConstraint).toBeUndefined();
    expect(api.sessions[1]?.asked[0]?.input).toContain('simple English words only');
    expect(warn).not.toHaveBeenCalled();
    info.mockRestore();
    warn.mockRestore();
  });

  it('aborts a stalled constrained pass at half-budget and succeeds via unconstrained retry on the warm base session', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const clones: FakeSession[] = [];
    let created = 0;
    const baseSession = new FakeSession(async () => '{"groups":[]}');
    const cloneable: LanguageModelSession = {
      prompt: baseSession.prompt.bind(baseSession),
      destroy: baseSession.destroy.bind(baseSession),
      clone: async () => {
        const index = clones.length;
        const copy = new FakeSession(async () => {
          if (index === 0) {
            // Simulate Chrome's constrained decoder hanging indefinitely.
            return new Promise<string>(() => undefined);
          }
          return '{"groups":[{"name":"Math","tabIds":[1,2]}]}';
        });
        clones.push(copy);
        return copy;
      },
    };
    const api = {
      availability: async () => 'available',
      create: async () => {
        created += 1;
        return cloneable;
      },
    };
    const session = new AiSession({ api, timeoutMs: 60_000, useResponseConstraint: true });

    const pending = session.prompt(
      '1|Esercitazione_8_Sacco.pdf|\n2|calcolo integrali|youtube.com',
      {
        responseConstraint: responseConstraintFor(8, 24),
      },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const reply = await pending;

    expect(reply).toContain('Math');
    // Warm base session was created once and reused across both clones.
    expect(created).toBe(1);
    expect(baseSession.destroyed).toBe(0);
    expect(clones).toHaveLength(2);
    // First stalled clone was aborted and destroyed immediately; second ran unconstrained.
    expect(clones[0]?.asked[0]?.omitResponseConstraintInput).toBe(true);
    expect(clones[0]?.asked[0]?.signal?.aborted).toBe(true);
    expect(clones[0]?.destroyed).toBe(1);
    expect(clones[1]?.asked[0]?.responseConstraint).toBeUndefined();
    expect(clones[1]?.destroyed).toBe(1);
    info.mockRestore();
  });

  it('keeps background create() alive when a caller warmup signal aborts and fires onWarm once ready', async () => {
    let finishCreate: () => void = () => undefined;
    const api = new FakeApi({
      hold: () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
      answer: async () => '{"groups":[{"name":"Math","tabIds":[1,2]}]}',
    });
    const session = new AiSession({ api });
    let warmed = 0;
    session.onWarm(() => {
      warmed += 1;
    });

    const caller = new AbortController();
    const openPending = session.open({ signal: caller.signal });
    caller.abort(new DOMException('warmup deadline', 'TimeoutError'));

    await expect(openPending).rejects.toMatchObject({ name: 'TimeoutError' });
    // The underlying Chrome create() call is NOT aborted when a caller times out.
    expect(api.created).toHaveLength(1);
    expect(api.created[0]?.signal?.aborted).toBe(false);
    expect(session.isOpen).toBe(false);
    expect(warmed).toBe(0);

    // Once background loading completes, the session becomes warm and ready without a 2nd create().
    finishCreate();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.isOpen).toBe(true);
    expect(warmed).toBe(1);
    await expect(session.prompt('tabs')).resolves.toContain('Math');
    expect(api.created).toHaveLength(1);
  });

  it('never clones or prompts after a cold-loading call was aborted', async () => {
    let finishCreate: () => void = () => undefined;
    let cloneCalls = 0;
    const baseSession = new FakeSession(async () => '{"groups":[]}');
    const cloneable: LanguageModelSession = {
      prompt: baseSession.prompt.bind(baseSession),
      destroy: baseSession.destroy.bind(baseSession),
      clone: async () => {
        cloneCalls += 1;
        return new FakeSession(async () => '{"groups":[]}');
      },
    };
    const api = {
      availability: async () => 'available',
      create: async () => {
        await new Promise<void>((resolve) => {
          finishCreate = resolve;
        });
        return cloneable;
      },
    };
    const session = new AiSession({ api, timeoutMs: 60_000 });
    const controller = new AbortController();

    const pending = session.prompt('tabs', { signal: controller.signal });
    const caught = pending.catch((error: unknown) => error);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    expect(await caught).toMatchObject({ name: 'AbortError' });

    finishCreate();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(cloneCalls).toBe(0);
    expect(baseSession.asked).toHaveLength(0);
  });

  it('uses promptStreaming(), reports live stages, and stops early once complete JSON closes', async () => {
    let cancelled = false;
    let destroyed = 0;
    const stages: string[] = [];
    const streamingSession: LanguageModelSession = {
      inputQuota: 4096,
      inputUsage: 120,
      prompt: async () => {
        throw new Error('blocking prompt should not be used when promptStreaming exists');
      },
      promptStreaming: () =>
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue('```json\n{"groups":[{"name":"Math",');
            controller.enqueue('"tabIds":[1,2]}]}');
            // Never close the stream to simulate Gemini Nano hanging/rambling after `}`.
          },
          cancel() {
            cancelled = true;
          },
        }),
      destroy: () => {
        destroyed += 1;
      },
    };
    const api = {
      availability: async () => 'available',
      create: async () => ({
        ...streamingSession,
        clone: async () => streamingSession,
      }),
    };
    const session = new AiSession({ api, timeoutMs: 5_000 });

    const reply = await session.prompt('1|Algebra|a.com\n2|Calculus|b.com', {
      onStage: (stage) => stages.push(stage),
    });

    expect(reply).toBe('{"groups":[{"name":"Math","tabIds":[1,2]}]}');
    expect(cancelled).toBe(true);
    expect(destroyed).toBe(1);
    expect(session.contextWindow).toBe(4096);
    expect(session.contextUsage).toBe(120);
    expect(stages.some((s) => s.startsWith('clone'))).toBe(true);
    expect(stages.some((s) => s.startsWith('prefill'))).toBe(true);
    expect(stages.some((s) => s.startsWith('streaming'))).toBe(true);
    expect(session.lastTrace).toContain('stage=done-early');
  });

  it('records stage=prefill in lastTrace when promptStreaming stalls before the first token', async () => {
    vi.useFakeTimers();
    const stalled: LanguageModelSession = {
      prompt: async () => new Promise<string>(() => undefined),
      promptStreaming: (_input, opts) =>
        new ReadableStream<string>({
          start(controller) {
            opts?.signal?.addEventListener('abort', () => controller.error(opts.signal?.reason), {
              once: true,
            });
          },
        }),
      destroy: () => undefined,
    };
    const api = {
      availability: async () => 'available',
      create: async () => stalled,
    };
    const session = new AiSession({ api, timeoutMs: 1_000 });

    const pending = session.prompt('tabs');
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await caught).toMatchObject({ name: 'TimeoutError' });
    expect(session.lastTrace).toContain('stage=prefill');
    expect(session.lastTrace).toContain('0 chars');
  });

  it('detects complete balanced groups JSON and runaway repetition loops', () => {
    expect(extractCompleteGroupsJson('{"groups":[{"name":"A","tabIds":[1,2]}')).toBeNull();
    expect(
      extractCompleteGroupsJson('Sure!\n{"groups":[{"name":"A","tabIds":[1,2]}]}\nHope this helps'),
    ).toBe('{"groups":[{"name":"A","tabIds":[1,2]}]}');
    expect(isDegenerateStream('{"groups":[{"name":"A","tabIds":[1,2]}]}')).toBe(false);
    expect(isDegenerateStream('x'.repeat(200) + ',1,2,3'.repeat(10))).toBe(true);
  });
});

describe('downloadModel', () => {
  it('creates the session, which is what starts the download, and reports progress', async () => {
    const api = new FakeApi({ state: 'downloadable', progress: [0, 0.5, 1] });
    const seen: number[] = [];

    const state = await downloadModel({ api, onProgress: (loaded) => seen.push(loaded) });

    expect(state).toBe('available');
    expect(seen).toEqual([0, 0.5, 1]);
    expect(api.created).toHaveLength(1);
  });

  it('leaves the AI where the browser says it is when the download fails', async () => {
    const api = new FakeApi({
      state: 'downloadable',
      failCreate: () => Promise.reject(new Error('no room on this disk')),
    });

    await expect(downloadModel({ api })).resolves.toBe('downloadable');
  });

  it('takes as long as it takes: the 20 s of §7.3 is a prompt, not a download', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const api = new FakeApi({
      state: 'downloadable',
      hold: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });

    const pending = downloadModel({ api });
    await vi.advanceTimersByTimeAsync(120_000);
    // Two minutes in, nothing has given up on it.
    expect(api.created[0]?.signal?.aborted ?? false).toBe(false);

    release();
    await expect(pending).resolves.toBe('available');
  });
});

describe('panelSession', () => {
  it('is one session for the whole panel, destroyed when it closes', async () => {
    const api = new FakeApi();
    const first = panelSession({ api });
    expect(panelSession()).toBe(first);

    await first.prompt('one');
    closeSession();

    expect(api.sessions[0]?.destroyed).toBe(1);
    expect(panelSession({ api })).not.toBe(first);
  });
});
