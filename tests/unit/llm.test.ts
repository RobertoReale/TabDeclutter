import { afterEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_PROMPT } from '../../src/core/ai-grouping';
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
  readonly asked: { input: string; responseConstraint?: unknown; signal?: AbortSignal }[] = [];
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
    options: { responseConstraint?: unknown; signal?: AbortSignal } = {},
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

  it('creates the session with the system prompt of §7.3, once', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });

    await session.prompt('one');
    await session.prompt('two');

    expect(api.created).toHaveLength(1);
    expect(api.created[0]?.initialPrompts).toEqual([{ role: 'system', content: SYSTEM_PROMPT }]);
    expect(api.sessions[0]?.asked.map((ask) => ask.input)).toEqual(['one', 'two']);
  });

  it('shares one creation between two calls made at once', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });

    await Promise.all([session.prompt('one'), session.prompt('two')]);

    expect(api.created).toHaveLength(1);
  });

  it('passes the response constraint and a signal through', async () => {
    const api = new FakeApi();
    const session = new AiSession({ api });
    const constraint = { type: 'object' };

    await session.prompt('one', { responseConstraint: constraint });

    const ask = api.sessions[0]?.asked[0];
    expect(ask?.responseConstraint).toBe(constraint);
    expect(ask?.signal).toBeInstanceOf(AbortSignal);
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
