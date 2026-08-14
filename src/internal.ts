import { requestError } from "./errors.js";
import type { FetchLike, Logger, RetryOptions, SystemInfo } from "./types.js";

export const SCALE_SET_ENDPOINT = "_apis/runtime/runnerscalesets";
export const RUNNER_ENDPOINT = "_apis/distributedtask/pools/0/agents";

export interface GitHubConfig {
  url: URL;
  scope: "enterprise" | "organization" | "repository";
  enterprise?: string;
  organization?: string;
  repository?: string;
  isHosted: boolean;
}

export function parseGitHubConfig(input: string | URL, forceGhes = false): GitHubConfig {
  const raw = trimSlashes(input.toString());
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`failed to parse GitHub config URL: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parts = url.pathname
    .replace(/^\/|\/$/g, "")
    .split("/")
    .filter(Boolean);
  const isHosted = !forceGhes && isHostedGitHub(url);
  if (parts.length === 1) {
    return { url, scope: "organization", organization: parts[0]!, isHosted };
  }
  if (parts.length === 2 && parts[0]?.toLowerCase() === "enterprises") {
    return { url, scope: "enterprise", enterprise: parts[1]!, isHosted };
  }
  if (parts.length === 2) {
    return { url, scope: "repository", organization: parts[0]!, repository: parts[1]!, isHosted };
  }
  throw new Error(`invalid GitHub config URL ${JSON.stringify(url.toString())}`);
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x2f) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(start, end);
}

export function githubApiUrl(config: GitHubConfig, path: string): URL {
  const url = new URL(config.url);
  url.search = "";
  url.hash = "";
  if (config.isHosted) {
    url.hostname =
      config.url.hostname.toLowerCase() === "www.github.com"
        ? "api.github.com"
        : `api.${config.url.hostname}`;
    url.pathname = path;
  } else {
    url.pathname = `/api/v3${path}`;
  }
  return url;
}

export function registrationTokenPath(config: GitHubConfig): string {
  switch (config.scope) {
    case "organization":
      return `/orgs/${config.organization}/actions/runners/registration-token`;
    case "enterprise":
      return `/enterprises/${config.enterprise}/actions/runners/registration-token`;
    case "repository":
      return `/repos/${config.organization}/${config.repository}/actions/runners/registration-token`;
  }
}

export function userAgent(systemInfo: SystemInfo): string {
  return JSON.stringify({
    system: systemInfo.system,
    version: systemInfo.version,
    commit_sha: systemInfo.commitSha,
    scale_set_id: systemInfo.scaleSetId,
    subsystem: systemInfo.subsystem,
    build_version: "0.1.0",
    build_commit_sha: "",
    kind: "scaleset",
  });
}

/** Normalise the one legacy PascalCase field used by the Actions API. */
export function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire);
  if (typeof value !== "object" || value === null) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    normalized[key === "RunnerSetting" ? "runnerSetting" : key] = fromWire(field);
  }
  return normalized;
}

export function isHostedGitHub(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "github.com" ||
    host === "www.github.com" ||
    host === "github.localhost" ||
    host.endsWith(".ghe.com")
  );
}

export class AsyncLock {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface TransportOptions {
  fetch?: FetchLike;
  retry?: RetryOptions;
  timeoutMs?: number;
  logger?: Logger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function send(
  request: Request,
  options: TransportOptions,
  retryUnauthorized = false,
): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  const maxRetries = options.retry?.maxRetries ?? 4;
  const maxDelayMs = options.retry?.maxDelayMs ?? 30_000;
  const minDelayMs = options.retry?.minDelayMs ?? 1_000;
  const random = options.retry?.random ?? Math.random;
  let response: Response | undefined;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await fetchWithTimeout(fetcher, request.clone(), options.timeoutMs ?? 300_000);
      if (!shouldRetry(response.status, retryUnauthorized) || attempt === maxRetries)
        return response;
      options.logger?.debug?.("retrying Actions request", {
        attempt: attempt + 1,
        status: response.status,
        url: request.url,
      });
    } catch (error) {
      lastError = await requestError(request, undefined, asError(error));
      if (attempt === maxRetries) throw lastError;
      options.logger?.debug?.("retrying failed Actions request", {
        attempt: attempt + 1,
        url: request.url,
      });
    }
    const delay = retryDelay(response, attempt, minDelayMs, maxDelayMs, random);
    try {
      await (options.sleep ?? defaultSleep)(delay, request.signal);
    } catch (error) {
      throw await requestError(request, undefined, asError(error));
    }
  }
  if (response) return response;
  throw lastError ?? (await requestError(request, undefined, new Error("request failed")));
}

async function fetchWithTimeout(
  fetcher: FetchLike,
  request: Request,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetcher(request);
  const signal = combineSignals(request.signal, timeoutMs);
  return fetcher(request, { signal });
}

function shouldRetry(status: number, retryUnauthorized: boolean): boolean {
  return (
    status === 429 || status >= 500 || (retryUnauthorized && (status === 401 || status === 403))
  );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function retryDelay(
  response: Response | undefined,
  attempt: number,
  minDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const retryAfter = response ? retryAfterMs(response.headers.get("Retry-After")) : undefined;
  if (retryAfter !== undefined) return Math.min(maxDelayMs, retryAfter);
  const exponential = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
  // retryablehttp's default policy jitters its exponential backoff. Keeping the
  // source injectable makes the behavior deterministic in conformance tests.
  return Math.floor(exponential * (0.5 + boundedRandom(random)));
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function boundedRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

function combineSignals(requestSignal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function") return AbortSignal.any([requestSignal, timeout]);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  requestSignal.addEventListener("abort", () => abort(requestSignal), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
