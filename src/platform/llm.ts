/**
 * Chrome's Prompt API (Gemini Nano) behind the `Llm` of `core/ai-grouping.ts` (PLAN.md §7.3).
 *
 * `core/ai-grouping.ts` holds the whole grouping logic against an injected model; this is
 * the only place that knows the model is Chrome's `LanguageModel`. It is Chrome-only by
 * feature detection and never by name (invariant 5): the global is simply absent on
 * Firefox, which is what `caps.promptApi` reads and what makes `checkAvailability` answer
 * `'unsupported'` there.
 *
 * Nothing here is loaded when the panel opens. The panel reaches this module — and with it
 * `core/ai-grouping.ts` — through `import()` from `state/ai.ts` (PLAN.md §11), so the
 * Firefox build, which can never use it, never fetches or parses it.
 *
 * Three things PLAN.md §7.3 asks for and that the API alone does not give:
 *
 * - **Download only on a click.** Creating a session is what downloads the model, and the
 *   browser only allows it with user activation, so `downloadModel` is called from the
 *   button of §4.4.2 and nowhere else. The progress comes from `monitor` →
 *   `downloadprogress`.
 * - **One lazy session, reused.** `panelSession()` creates nothing: the session appears on
 *   the first prompt and is kept, and `closeSession()` destroys it when the panel closes.
 * - **A deadline on every call.** `AbortController`, aborted by the caller's own signal
 *   ("Annulla") or by the 20 s timeout, so a model that stops answering cannot hold the
 *   run open: `groupByAi` sees the rejection and §7.2 answers instead.
 *
 * The API surface used here is the one documented at
 * https://developer.chrome.com/docs/ai/prompt-api (checked 2026-11-14): `availability()`,
 * `create({ initialPrompts, expectedInputs, expectedOutputs, monitor, signal })`,
 * `session.prompt(input, { responseConstraint, signal })`, `session.measureInputUsage()`,
 * `session.contextUsage` / `session.contextWindow`, `session.destroy()`.
 */

// Relative and not `@/`: the `unit` vitest project runs without WXT's plugin, and so
// without WXT's alias, and this module is tested there (`tests/unit/llm.test.ts`).
import { SYSTEM_PROMPT } from '../core/ai-grouping';
import type { Llm, LlmPromptOptions } from '../core/ai-grouping';
import {
  extractCompleteGroupsJson,
  hasRecoverableGroupSnippet,
  isDegenerateStream,
} from '../core/ai-prompt';

export { extractCompleteGroupsJson, isDegenerateStream };

/** The states of PLAN.md §7.3, plus the one the API cannot report: it is not there. */
export type AiAvailability =
  'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** What `availability()` answers. Anything else is read as `'unavailable'`. */
const REPORTED: readonly string[] = ['unavailable', 'downloadable', 'downloading', 'available'];

/** PLAN.md §7.3: 20 s default per-call deadline, then the run falls back to §7.2. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Minimum per-call timeout at which constrained decoding is capped to half the budget so a
 * slow JSON-Schema grammar on local hardware still leaves time for an unconstrained retry.
 */
const CONSTRAINED_SPLIT_MIN_MS = 30_000;

/**
 * Interval at which an open production session pings the backend so Chromium's 60 s
 * `OnDeviceModelIdleTimeout` (`kDefaultModelIdleTimeout`) never unloads the 4 GiB weights
 * and compiled D3D12 compute shaders while the side panel remains open.
 */
const SESSION_KEEPALIVE_MS = 40_000;

/** `monitor`'s argument: an `EventTarget` that reports the download's progress. */
export interface LanguageModelMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { readonly loaded: number }) => void,
  ): void;
}

/** What a text session expects to be given and to answer with. */
interface ExpectedText {
  readonly type: 'text';
  readonly languages: readonly string[];
}

export interface LanguageModelCreateOptions {
  readonly initialPrompts?: readonly { readonly role: string; readonly content: string }[];
  readonly expectedInputs?: readonly ExpectedText[];
  readonly expectedOutputs?: readonly ExpectedText[];
  /** Deterministic greedy sampling (`temperature: 0, topK: 1`), supported in Chrome Extensions. */
  readonly temperature?: number;
  readonly topK?: number;
  readonly monitor?: (monitor: LanguageModelMonitor) => void;
  readonly signal?: AbortSignal;
}

/** The session the API hands back, as much of it as this module uses. */
export interface LanguageModelSession {
  /** Tokens the session can hold in total (`contextWindow` in newer drafts, `inputQuota` in Chrome 138+). */
  readonly contextWindow?: number;
  readonly inputQuota?: number;
  /** Tokens it has already spent (`contextUsage` in newer drafts, `inputUsage` in Chrome 138+). */
  readonly contextUsage?: number;
  readonly inputUsage?: number;
  prompt(
    input: string,
    options?: {
      readonly responseConstraint?: unknown;
      readonly omitResponseConstraintInput?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<string>;
  promptStreaming?(
    input: string,
    options?: {
      readonly responseConstraint?: unknown;
      readonly omitResponseConstraintInput?: boolean;
      readonly signal?: AbortSignal;
    },
  ):
    | ReadableStream<string>
    | AsyncIterable<string>
    | Promise<ReadableStream<string> | AsyncIterable<string>>;
  measureInputUsage?(input: string, options?: { readonly signal?: AbortSignal }): Promise<number>;
  clone?(options?: { readonly signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}

/** The `LanguageModel` global itself, so that a test can supply its own. */
export interface LanguageModelApi {
  availability(options?: LanguageModelCreateOptions): Promise<string>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

/**
 * `LanguageModel`, when the browser has it. Read off the globals rather than referenced
 * directly: on Firefox, and in a unit test, there is no such name to mention.
 */
export function languageModel(globals: object = globalThis): LanguageModelApi | undefined {
  const found = (globals as { LanguageModel?: LanguageModelApi }).LanguageModel;
  return typeof found?.availability === 'function' ? found : undefined;
}

/**
 * The languages the session is asked about (PLAN.md §7.3): English, because the Prompt
 * API officially supports en/ja/es/de/fr. Italian titles still travel through it as data.
 */
const EXPECTED: Pick<LanguageModelCreateOptions, 'expectedInputs' | 'expectedOutputs'> = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

/**
 * Deterministic greedy decoding for structured JSON tab grouping: Chrome defaults to
 * `temperature=1.0, top_k=64`, which adds randomness and JSON syntax errors on small models.
 * Both fields are always passed together per the Chrome Extension Prompt API spec.
 */
const GREEDY_SAMPLING: Pick<LanguageModelCreateOptions, 'temperature' | 'topK'> = {
  temperature: 0,
  topK: 1,
};

/**
 * Prepends `SYSTEM_PROMPT` to `input` when the session is created without `initialPrompts`
 * so `LanguageModel.create()` takes Chromium's 0-token initialization barrier fast-path
 * (`AILanguageModel::Initialize` with empty `initial_prompts`) instead of blocking session
 * creation on a GPU prefill pass.
 */
function withSystemPrompt(input: string): string {
  return input.startsWith(SYSTEM_PROMPT) ? input : `${SYSTEM_PROMPT}\n\n${input}`;
}

/**
 * Races an in-flight shared promise against a caller's `AbortSignal` without aborting the
 * underlying shared promise when the caller gives up first.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      queueMicrotask(() => {
        if (!settled) {
          settled = true;
          reject(signal.reason as Error);
        }
      });
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}

/**
 * What the browser has (PLAN.md §7.3, "Detection and state"). It never throws: a browser
 * that has the global but cannot answer about it has no model to offer either.
 */
export async function checkAvailability(
  api: LanguageModelApi | undefined = languageModel(),
): Promise<AiAvailability> {
  if (api === undefined) return 'unsupported';
  try {
    const state = await api.availability({ ...EXPECTED });
    return REPORTED.includes(state) ? (state as AiAvailability) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export interface AiSessionOptions {
  /** The API to talk to; the global by default. */
  readonly api?: LanguageModelApi | undefined;
  /** How long one call has before it is aborted (PLAN.md §7.3). */
  readonly timeoutMs?: number;
  /**
   * Whether to pass `responseConstraint` to `session.prompt()`. Disabled by default on real
   * browser sessions because Chromium's `llguidance` (`ConstraintFactory::InitializeTokenizer`)
   * copies the 256k-token vocabulary and computes 256k-bit masks per token on CPU, while
   * Gemini Nano already runs greedy decoding (`top_k=1, temperature=0`) and `core/ai-grouping.ts`
   * parses and validates the JSON shape directly.
   */
  readonly useResponseConstraint?: boolean;
}

/** What `open()` is told: whose signal to obey, and where the download's progress goes. */
export interface OpenOptions {
  readonly signal?: AbortSignal;
  /** `downloadprogress`'s `loaded`, which goes from 0 to 1. */
  readonly onProgress?: (loaded: number) => void;
}

/**
 * The panel's model: one session, created on the first call that needs it and reused
 * afterwards (PLAN.md §7.3, "Performance").
 *
 * It is an `Llm`, so `groupByAi` takes it as it is. Every call is bounded: the caller's
 * signal and a timeout both abort the same `AbortController`, and the call rejects as soon
 * as either does, even if the model never answers at all.
 */
export class AiSession implements Llm {
  readonly #api: LanguageModelApi | undefined;
  readonly #timeoutMs: number;
  readonly #useResponseConstraint: boolean;
  readonly #manageKeepAlive: boolean;
  /** The session once it exists; what `contextWindow` and `contextUsage` read. */
  #open: LanguageModelSession | null = null;
  /** The creation while it is in flight, so two calls at once share one session. */
  #opening: Promise<LanguageModelSession> | null = null;
  /** Aborted only when `close()` is called, so a caller timeout never kills background warmup. */
  #lifetimeController = new AbortController();
  /** Periodic ping that prevents Chrome's 60 s idle timer from unloading compiled D3D12 shaders. */
  #keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Number of active prompt executions, so keep-alive pings only fire when idle. */
  #activePrompts = 0;
  /** Compact diagnostic trace of the most recent `prompt()` sub-stages. */
  #lastTrace = '';
  /** Listeners notified when a background session creation finishes warming. */
  readonly #warmListeners = new Set<() => void>();

  constructor(options: AiSessionOptions = {}) {
    this.#api = options.api ?? languageModel();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#useResponseConstraint = options.useResponseConstraint ?? false;
    this.#manageKeepAlive = options.api === undefined;
  }

  /** Tokens the live session can hold, and `undefined` while there is none. */
  get contextWindow(): number | undefined {
    return this.#open?.contextWindow ?? this.#open?.inputQuota;
  }

  get contextUsage(): number | undefined {
    return this.#open?.contextUsage ?? this.#open?.inputUsage;
  }

  /** Diagnostic trace of the last `prompt()` call (stage, clone/prefill/stream timings, output preview). */
  get lastTrace(): string {
    return this.#lastTrace;
  }

  /** Whether a session is open, which is what `closeSession()` has to destroy. */
  get isOpen(): boolean {
    return this.#open !== null;
  }

  /**
   * Registers a callback invoked the next time an in-flight background `LanguageModel.create()`
   * finishes warming (or immediately if the session is already open).
   */
  onWarm(listener: () => void): () => void {
    if (this.#open !== null) {
      listener();
      return () => undefined;
    }
    this.#warmListeners.add(listener);
    return () => {
      this.#warmListeners.delete(listener);
    };
  }

  /**
   * Creates the session now. This is the step that downloads the model when it is
   * `downloadable`, which is why it is only ever reached from the click of §4.4.2
   * (or to warm an already-`available` model before prompting).
   *
   * The 20 s of §7.3 is a prompt's deadline and not this one: a first download is
   * gigabytes and takes as long as it takes. Only the caller's signal stops waiting.
   */
  async open(options: OpenOptions = {}): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    await raceSignal(this.#session(signal, options.onProgress), signal);
  }

  async prompt(input: string, options: LlmPromptOptions = {}): Promise<string> {
    this.#lastTrace = 'stage=open';
    const onStage = options.onStage;
    return this.#within(options.signal, async (signal) => {
      const base = await this.#session(signal);
      const fullInput = withSystemPrompt(input);
      const constraint = this.#useResponseConstraint
        ? sanitizeConstraint(options.responseConstraint)
        : undefined;
      const hasClone = typeof base.clone === 'function';
      this.#activePrompts += 1;
      try {
        try {
          if (constraint !== undefined && this.#timeoutMs >= CONSTRAINED_SPLIT_MIN_MS) {
            const constrainedCap = Math.floor(this.#timeoutMs * 0.5);
            return await this.#askWithCap(
              base,
              fullInput,
              constraint,
              signal,
              constrainedCap,
              onStage,
            );
          }
          return await this.#ask(base, fullInput, constraint, signal, onStage);
        } catch (error: unknown) {
          if (signal.aborted || isTerminalPromptError(error)) throw error;
          console.info('TabDeclutter: on-device AI prompt failed, retrying cleanly', error);
          // Keep the warm base session when it was only cloned (never mutated directly);
          // only destroy and reload when base itself was prompted without clone().
          let retryBase = base;
          if (!hasClone) {
            this.close();
            retryBase = await this.#session(signal);
          }
          const retryInput = `${fullInput}\nIMPORTANT: Every group "name" MUST be 1-3 simple English words only (e.g. "Math", "Videos", "Email").`;
          try {
            return await this.#ask(retryBase, retryInput, undefined, signal, onStage);
          } catch (retryError: unknown) {
            if (!hasClone || signal.aborted || isTerminalPromptError(retryError)) {
              throw retryError;
            }
            // If the base session itself became unhealthy (e.g. idle disconnect), reload it once.
            this.close();
            const fresh = await this.#session(signal);
            return await this.#ask(fresh, retryInput, undefined, signal, onStage);
          }
        }
      } finally {
        this.#activePrompts = Math.max(0, this.#activePrompts - 1);
      }
    });
  }

  /**
   * Runs a constrained pass under a shorter child deadline so a slow JSON-Schema grammar
   * on local hardware aborts cleanly and hands the remaining budget to an unconstrained retry.
   */
  async #askWithCap(
    base: LanguageModelSession,
    input: string,
    responseConstraint: unknown,
    outer: AbortSignal,
    capMs: number,
    onStage?: (stage: string) => void,
  ): Promise<string> {
    const child = new AbortController();
    const onOuterAbort = (): void => {
      child.abort(outer.reason);
    };
    outer.addEventListener('abort', onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<string>((keep, reject) => {
        const give = (): void => {
          reject(child.signal.reason as Error);
        };
        if (outer.aborted) child.abort(outer.reason);
        if (child.signal.aborted) {
          give();
          return;
        }
        child.signal.addEventListener('abort', give, { once: true });
        timer = setTimeout(() => {
          child.abort(
            new DOMException(
              'constrained decoding exceeded split budget',
              'ConstrainedTimeoutError',
            ),
          );
        }, capMs);
        this.#ask(base, input, responseConstraint, child.signal, onStage).then(keep, reject);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * Prompts an isolated clone of `base` when the browser supports `session.clone()`, so
   * repeated groupings reuse the warm weights without accumulating history tokens.
   *
   * Uses `promptStreaming()` whenever available on unconstrained calls (the default path) so we
   * surface live sub-stage telemetry (`clone` → `prefill` → `streaming`), stop the millisecond
   * a complete balanced `{"groups":[...]}` JSON object finishes, break runaway repetition loops,
   * and report exact diagnostics if the hardware stalls.
   */
  async #ask(
    base: LanguageModelSession,
    input: string,
    responseConstraint: unknown,
    signal: AbortSignal,
    onStage?: (stage: string) => void,
  ): Promise<string> {
    const promptOpts =
      responseConstraint === undefined
        ? { signal }
        : { responseConstraint, omitResponseConstraintInput: true, signal };
    if (typeof base.clone === 'function') {
      if (signal.aborted) throw signal.reason as Error;
      const cloneStartedAt = Date.now();
      this.#lastTrace = 'stage=clone';
      onStage?.('clone (session.clone)');
      const isolated = await base.clone({ signal });
      const cloneMs = Date.now() - cloneStartedAt;
      let destroyed = false;
      const cleanup = (): void => {
        if (destroyed) return;
        destroyed = true;
        isolated.destroy();
      };
      signal.addEventListener('abort', cleanup, { once: true });
      try {
        return await this.#execute(isolated, input, promptOpts, signal, cloneMs, cleanup, onStage);
      } finally {
        signal.removeEventListener('abort', cleanup);
        cleanup();
      }
    }
    return this.#execute(base, input, promptOpts, signal, undefined, undefined, onStage);
  }

  async #execute(
    target: LanguageModelSession,
    input: string,
    promptOpts: {
      readonly responseConstraint?: unknown;
      readonly omitResponseConstraintInput?: boolean;
      readonly signal?: AbortSignal;
    },
    signal: AbortSignal,
    cloneMs: number | undefined,
    stopSession: (() => void) | undefined,
    onStage?: (stage: string) => void,
  ): Promise<string> {
    const cloneTag = cloneMs === undefined ? '' : `clone=${fmtSec(cloneMs)} · `;
    const startedAt = Date.now();
    this.#lastTrace = `stage=prefill (${cloneTag}0 chars)`;
    onStage?.(`prefill (${cloneTag}waiting for 1st token)`);

    if (
      promptOpts.responseConstraint === undefined &&
      typeof target.promptStreaming === 'function'
    ) {
      return this.#stream(
        target,
        input,
        promptOpts,
        signal,
        cloneTag,
        startedAt,
        stopSession,
        onStage,
      );
    }

    const reply = await target.prompt(input, promptOpts);
    this.#lastTrace = `stage=done (${cloneTag}${reply.length} chars in ${fmtSec(Date.now() - startedAt)})`;
    return reply;
  }

  async #stream(
    target: LanguageModelSession,
    input: string,
    promptOpts: { readonly signal?: AbortSignal },
    signal: AbortSignal,
    cloneTag: string,
    startedAt: number,
    stopSession: (() => void) | undefined,
    onStage?: (stage: string) => void,
  ): Promise<string> {
    const stream = await target.promptStreaming!(input, promptOpts);
    let accumulated = '';
    let firstTokenMs: number | undefined;
    let chunks = 0;
    let lastStageUpdate = 0;

    const updateTrace = (phase: string): void => {
      const firstTag =
        firstTokenMs === undefined ? 'no 1st token' : `1stTok=${fmtSec(firstTokenMs)}`;
      const preview = compactPreview(accumulated);
      const sample = preview === '' ? '' : ` · out=${JSON.stringify(preview)}`;
      this.#lastTrace = `stage=${phase} (${cloneTag}${firstTag} · ${accumulated.length} chars/${chunks} chunks${sample})`;
    };

    const handleChunk = (chunk: string): { done: boolean; result?: string } => {
      if (chunk === '') return { done: false };
      chunks += 1;
      if (firstTokenMs === undefined) {
        firstTokenMs = Date.now() - startedAt;
      }
      // Support both spec incremental delta chunks and cumulative-prefix chunks defensively.
      accumulated =
        accumulated.length > 0 && chunk.startsWith(accumulated) ? chunk : accumulated + chunk;
      updateTrace('streaming');

      const nowMs = Date.now();
      if (chunks === 1 || nowMs - lastStageUpdate >= 250) {
        lastStageUpdate = nowMs;
        onStage?.(`streaming (${accumulated.length} chars · 1st tok ${fmtSec(firstTokenMs)})`);
      }

      // Stop immediately once a complete top-level `{"groups":[...]}` JSON object finishes,
      // preventing Gemini Nano from burning tens of seconds on trailing prose or EOS loops.
      const complete = extractCompleteGroupsJson(accumulated);
      if (complete !== null) {
        this.#lastTrace = `stage=done-early (${cloneTag}1stTok=${fmtSec(firstTokenMs)} · ${complete.length} chars in ${fmtSec(nowMs - startedAt)})`;
        return { done: true, result: complete };
      }

      // Break runaway repetition loops early instead of stalling until the 90 s timeout.
      if (isDegenerateStream(accumulated)) {
        updateTrace('loop-stopped');
        return { done: true, result: accumulated };
      }
      return { done: false };
    };

    try {
      if (isReadableStream(stream)) {
        const reader = stream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (typeof value !== 'string') continue;
            const step = handleChunk(value);
            if (step.done) {
              void reader.cancel().catch(() => undefined);
              stopSession?.();
              return step.result ?? accumulated;
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        for await (const chunk of stream) {
          if (typeof chunk !== 'string') continue;
          const step = handleChunk(chunk);
          if (step.done) {
            stopSession?.();
            return step.result ?? accumulated;
          }
        }
      }
    } catch (error: unknown) {
      updateTrace(firstTokenMs === undefined ? 'prefill' : 'mid-stream');
      // If we hit a timeout after already streaming recoverable group JSON, return the partial
      // text so `validateAiAnswer` can salvage completed groups instead of discarding everything.
      if (
        signal.aborted &&
        errorNameOf(signal.reason) === 'TimeoutError' &&
        hasRecoverableGroupSnippet(accumulated)
      ) {
        updateTrace('timeout-salvaged');
        return accumulated;
      }
      throw error;
    }

    this.#lastTrace = `stage=done (${cloneTag}${firstTokenMs === undefined ? 'empty' : `1stTok=${fmtSec(firstTokenMs)}`} · ${accumulated.length} chars in ${fmtSec(Date.now() - startedAt)})`;
    return accumulated;
  }

  /**
   * What the input would cost, measured by the model. A session that cannot measure says
   * so by throwing, and `core/ai-grouping.ts` estimates from the length instead.
   */
  async measureInputUsage(
    input: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<number> {
    return this.#within(options.signal, async (signal) => {
      const session = await raceSignal(this.#session(signal), signal);
      if (signal.aborted) throw signal.reason as Error;
      if (session.measureInputUsage === undefined) {
        throw new Error('the session cannot measure an input');
      }
      return session.measureInputUsage(input, { signal });
    });
  }

  /** PLAN.md §7.3: the session is destroyed when the panel closes. */
  close(): void {
    this.#stopKeepAlive();
    this.#lifetimeController.abort();
    this.#lifetimeController = new AbortController();
    this.#open?.destroy();
    this.#open = null;
    this.#opening = null;
  }

  /**
   * The session, created once. A creation that fails is not remembered as a failure.
   *
   * When a caller's per-call `signal` aborts while `this.#opening` is still loading the
   * shared model in the background (and no download monitor is attached), only the caller's
   * wait rejects (`raceSignal`) so Chromium's `OnDeviceModelService` can finish cold-loading
   * weights and compiling D3D12 shaders instead of tearing down and restarting from zero.
   */
  #session(
    signal: AbortSignal,
    onProgress?: (loaded: number) => void,
  ): Promise<LanguageModelSession> {
    if (signal.aborted) {
      return Promise.reject(signal.reason as Error);
    }
    if (this.#open !== null) return Promise.resolve(this.#open);
    const createSignal = onProgress === undefined ? this.#lifetimeController.signal : signal;
    this.#opening ??= this.#create(createSignal, onProgress).catch((error: unknown) => {
      this.#opening = null;
      throw error;
    });
    return this.#opening;
  }

  async #create(
    signal: AbortSignal,
    onProgress?: (loaded: number) => void,
  ): Promise<LanguageModelSession> {
    const api = this.#api;
    if (api === undefined) throw new Error('no on-device model on this browser');
    const lifetime = this.#lifetimeController;
    const baseOpts: LanguageModelCreateOptions = {
      ...EXPECTED,
      // Omit `initialPrompts` from `create()` so `AILanguageModel::Initialize` takes Chromium's
      // 0-token initialization barrier fast-path (`Input::New()`), resolving as soon as the
      // model weights are ready instead of blocking session creation on a GPU prefill pass;
      // `SYSTEM_PROMPT` is prepended directly to each prompt input.
      signal,
      ...(onProgress === undefined
        ? {}
        : {
            monitor: (monitor: LanguageModelMonitor) => {
              monitor.addEventListener('downloadprogress', (event) => {
                onProgress(event.loaded);
              });
            },
          }),
    };
    let session: LanguageModelSession;
    try {
      session = await api.create({ ...baseOpts, ...GREEDY_SAMPLING });
    } catch (error: unknown) {
      if (signal.aborted || !isSamplingOptionError(error)) throw error;
      // Future-proof fallback if a browser rejects legacy `temperature`/`topK` options.
      session = await api.create(baseOpts);
    }
    if (lifetime.signal.aborted) {
      session.destroy();
      throw new DOMException('the AI session was closed while opening', 'AbortError');
    }
    this.#open = session;
    this.#opening = null;
    this.#startKeepAlive();
    const listeners = [...this.#warmListeners];
    this.#warmListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Never let a listener failure poison the resolved session.
      }
    }
    return session;
  }

  #startKeepAlive(): void {
    this.#stopKeepAlive();
    if (!this.#manageKeepAlive || this.#open === null) return;
    this.#keepAliveTimer = setInterval(() => {
      const live = this.#open;
      if (live === null || this.#activePrompts > 0) return;
      if (typeof live.measureInputUsage === 'function') {
        void live.measureInputUsage('.').catch(() => undefined);
      } else if (typeof live.clone === 'function') {
        void live
          .clone()
          .then((cloned) => {
            cloned.destroy();
          })
          .catch(() => undefined);
      }
    }, SESSION_KEEPALIVE_MS);
    (this.#keepAliveTimer as unknown as { unref?: () => void }).unref?.();
  }

  #stopKeepAlive(): void {
    if (this.#keepAliveTimer !== null) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = null;
    }
  }

  /**
   * One call, bounded by the caller's signal and by the timeout. Both abort the same
   * controller, and the promise rejects with the reason the controller was aborted with —
   * so "Annulla" is an `AbortError` and the deadline a `TimeoutError`, which is exactly
   * what `groupByAi` tells apart before falling back to §7.2.
   */
  async #within<T>(outer: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(outer?.reason);
    };
    outer?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((keep, reject) => {
        const give = (): void => {
          reject(controller.signal.reason as Error);
        };
        if (outer?.aborted === true) controller.abort(outer.reason);
        if (controller.signal.aborted) {
          give();
          return;
        }
        controller.signal.addEventListener('abort', give, { once: true });
        timer = setTimeout(() => {
          controller.abort(
            new DOMException('the on-device model did not answer in time', 'TimeoutError'),
          );
        }, this.#timeoutMs);
        run(controller.signal).then(keep, reject);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }
}

/** The panel's one session, for as long as the panel is open. */
let current: AiSession | null = null;

/**
 * The session the panel groups with: lazy, and the same one every time (PLAN.md §7.3).
 * The options are honoured by whoever creates it, which is the first caller.
 */
export function panelSession(options: AiSessionOptions = {}): AiSession {
  current ??= new AiSession(options);
  return current;
}

/** The panel is closing: the session goes with it (PLAN.md §7.3, "Performance"). */
export function closeSession(): void {
  current?.close();
  current = null;
}

export interface DownloadOptions extends AiSessionOptions, OpenOptions {}

/**
 * "Attiva AI on-device" (PLAN.md §7.3): the explicit click that starts Chrome's one-off
 * download, which is creating the session with a `monitor` on it.
 *
 * It answers with where the browser stands afterwards rather than throwing: a download
 * that fails or is refused leaves the AI option as the availability check finds it, and
 * the panel goes on grouping with §7.2.
 */
export async function downloadModel(options: DownloadOptions = {}): Promise<AiAvailability> {
  const session = panelSession({ api: options.api, timeoutMs: options.timeoutMs });
  try {
    await session.open({ signal: options.signal, onProgress: options.onProgress });
  } catch {
    return checkAvailability(options.api ?? languageModel());
  }
  return 'available';
}

/**
 * Chrome's Prompt API docs recommend keeping `responseConstraint` structural and avoiding
 * `maxLength` / `maxItems` constraints inside JSON Schema, which can trigger `NotSupportedError`
 * or degenerate token compression in constrained decoding; client-side validation still enforces
 * both limits. Returns `constraint` unchanged by reference when no problematic keywords appear.
 */
function hasUnsupportedConstraintKeyword(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasUnsupportedConstraintKeyword);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'maxLength' || key === 'maxItems') return true;
    if (hasUnsupportedConstraintKeyword(nested)) return true;
  }
  return false;
}

function stripConstraintLimits(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripConstraintLimits);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'maxLength' || key === 'maxItems') continue;
    out[key] = stripConstraintLimits(nested);
  }
  if (out.type === 'object' && !('additionalProperties' in out)) {
    out.additionalProperties = false;
  }
  return out;
}

function sanitizeConstraint(constraint: unknown): unknown {
  if (constraint === undefined || !hasUnsupportedConstraintKeyword(constraint)) {
    return constraint;
  }
  return stripConstraintLimits(constraint);
}

function isTerminalPromptError(error: unknown): boolean {
  const name = errorNameOf(error);
  return name === 'AbortError' || name === 'TimeoutError' || name === 'QuotaExceededError';
}

function errorNameOf(error: unknown): string {
  if (error === null || typeof error !== 'object' || !('name' in error)) return '';
  return String((error as { name: unknown }).name);
}

function fmtSec(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function isReadableStream(value: unknown): value is ReadableStream<string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'getReader' in value &&
    typeof (value as { getReader?: unknown }).getReader === 'function'
  );
}

function isSamplingOptionError(error: unknown): boolean {
  const name = errorNameOf(error);
  return name === 'NotSupportedError' || name === 'TypeError' || name === 'RangeError';
}

function compactPreview(text: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 48)}…${clean.slice(-28)}`;
}

/**
 * What `state/ai.ts` asks of this module. Named here so the panel can hold the module
 * behind an `import()` and a test can hand it a model of its own (TASKS.md §2.4).
 */
export interface LlmModule {
  checkAvailability(api?: LanguageModelApi): Promise<AiAvailability>;
  downloadModel(options?: DownloadOptions): Promise<AiAvailability>;
  panelSession(options?: AiSessionOptions): Llm;
  closeSession(): void;
}
