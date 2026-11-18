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

/** The states of PLAN.md §7.3, plus the one the API cannot report: it is not there. */
export type AiAvailability =
  'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** What `availability()` answers. Anything else is read as `'unavailable'`. */
const REPORTED: readonly string[] = ['unavailable', 'downloadable', 'downloading', 'available'];

/** PLAN.md §7.3: 20 s, then the run falls back to §7.2. */
export const DEFAULT_TIMEOUT_MS = 20_000;

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
  readonly monitor?: (monitor: LanguageModelMonitor) => void;
  readonly signal?: AbortSignal;
}

/** The session the API hands back, as much of it as this module uses. */
export interface LanguageModelSession {
  /** Tokens the session can hold in total. */
  readonly contextWindow?: number;
  /** Tokens it has already spent. */
  readonly contextUsage?: number;
  prompt(
    input: string,
    options?: { readonly responseConstraint?: unknown; readonly signal?: AbortSignal },
  ): Promise<string>;
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
  /** The session once it exists; what `contextWindow` and `contextUsage` read. */
  #open: LanguageModelSession | null = null;
  /** The creation while it is in flight, so two calls at once share one session. */
  #opening: Promise<LanguageModelSession> | null = null;

  constructor(options: AiSessionOptions = {}) {
    this.#api = options.api ?? languageModel();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Tokens the live session can hold, and `undefined` while there is none. */
  get contextWindow(): number | undefined {
    return this.#open?.contextWindow;
  }

  get contextUsage(): number | undefined {
    return this.#open?.contextUsage;
  }

  /** Whether a session is open, which is what `closeSession()` has to destroy. */
  get isOpen(): boolean {
    return this.#open !== null;
  }

  /**
   * Creates the session now. This is the step that downloads the model when it is
   * `downloadable`, which is why it is only ever reached from the click of §4.4.2.
   *
   * The 20 s of §7.3 is a prompt's deadline and not this one: a first download is
   * gigabytes and takes as long as it takes. Only the caller's signal stops it.
   */
  async open(options: OpenOptions = {}): Promise<void> {
    await this.#session(options.signal ?? new AbortController().signal, options.onProgress);
  }

  async prompt(input: string, options: LlmPromptOptions = {}): Promise<string> {
    return this.#within(options.signal, async (signal) => {
      const base = await this.#session(signal);
      const constraint = sanitizeConstraint(options.responseConstraint);
      try {
        return await this.#ask(base, input, constraint, signal);
      } catch (error: unknown) {
        if (signal.aborted || isTerminalPromptError(error)) throw error;
        console.warn('TabDeclutter: on-device AI prompt failed, retrying cleanly', error);
        // Reset the base session in case Chrome left it in an invalid state, then retry once
        // unconstrained with an explicit English-name reminder (avoids both constrained-decoder
        // failures and Chrome's "untested output language" filter on Italian tab titles).
        this.close();
        const fresh = await this.#session(signal);
        const retryInput = `${input}\nIMPORTANT: Every group "name" MUST be 1-3 simple English words only (e.g. "Math", "Videos", "Email").`;
        return this.#ask(fresh, retryInput, undefined, signal);
      }
    });
  }

  /**
   * Prompts an isolated clone of `base` when the browser supports `session.clone()`, so
   * repeated groupings reuse the KV-cached system prompt without accumulating history tokens.
   */
  async #ask(
    base: LanguageModelSession,
    input: string,
    responseConstraint: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    const promptOpts =
      responseConstraint === undefined ? { signal } : { responseConstraint, signal };
    if (typeof base.clone === 'function') {
      const isolated = await base.clone({ signal });
      try {
        return await isolated.prompt(input, promptOpts);
      } finally {
        isolated.destroy();
      }
    }
    return base.prompt(input, promptOpts);
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
      const session = await this.#session(signal);
      if (session.measureInputUsage === undefined) {
        throw new Error('the session cannot measure an input');
      }
      return session.measureInputUsage(input, { signal });
    });
  }

  /** PLAN.md §7.3: the session is destroyed when the panel closes. */
  close(): void {
    this.#open?.destroy();
    this.#open = null;
    this.#opening = null;
  }

  /** The session, created once. A creation that fails is not remembered as a failure. */
  async #session(
    signal: AbortSignal,
    onProgress?: (loaded: number) => void,
  ): Promise<LanguageModelSession> {
    if (this.#open !== null) return this.#open;
    this.#opening ??= this.#create(signal, onProgress).catch((error: unknown) => {
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
    const session = await api.create({
      ...EXPECTED,
      // The system prompt belongs to the session, not to every prompt: it is sent once
      // and the session is reused (PLAN.md §7.3).
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
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
    });
    this.#open = session;
    this.#opening = null;
    return session;
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
  if (error === null || typeof error !== 'object' || !('name' in error)) return false;
  const name = String((error as { name: unknown }).name);
  return name === 'AbortError' || name === 'TimeoutError' || name === 'QuotaExceededError';
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
