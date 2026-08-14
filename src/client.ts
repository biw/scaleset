import { createGitHubAppJwt, type Credential, validateCredential } from "./auth.js";
import { ScaleSetError, requestError } from "./errors.js";
import {
  AsyncLock,
  RUNNER_ENDPOINT,
  SCALE_SET_ENDPOINT,
  fromWire,
  githubApiUrl,
  parseGitHubConfig,
  registrationTokenPath,
  send,
  userAgent,
  type GitHubConfig,
  type TransportOptions,
} from "./internal.js";
import { MessageSessionClient } from "./session.js";
import type {
  FetchLike,
  Clock,
  Logger,
  RetryOptions,
  RunnerGroup,
  RunnerGroupList,
  RunnerReference,
  RunnerReferenceList,
  RunnerScaleSet,
  RunnerScaleSetJitRunnerConfig,
  RunnerScaleSetJitRunnerSetting,
  RunnerScaleSetSession,
  SystemInfo,
} from "./types.js";

interface RegistrationToken {
  token?: string;
  expires_at?: string;
}

interface ActionsServiceAdminConnection {
  url?: string;
  token?: string;
}

interface AccessToken {
  token: string;
  expires_at: string;
}

interface ActionsConnection {
  url: string;
  token: string;
  expiresAt: Date;
}

export interface ScaleSetClientOptions {
  githubConfigUrl: string | URL;
  credential: Credential;
  systemInfo?: Partial<SystemInfo>;
  fetch?: FetchLike;
  retry?: RetryOptions;
  timeoutMs?: number;
  logger?: Logger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Wall clock used for token freshness and GitHub App JWTs. */
  clock?: Clock;
  /** Treat a .ghe.com hostname as GitHub Enterprise Server rather than hosted GitHub. */
  forceGhes?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * A portable client for GitHub Actions Runner Scale Set APIs.
 *
 * It owns GitHub authentication and the Actions service admin connection, but
 * deliberately does not create runners or decide fleet capacity.
 */
export class ScaleSetClient {
  readonly #config: GitHubConfig;
  readonly #credential: Credential;
  readonly #transport: TransportOptions;
  readonly #clock: Clock;
  readonly #refreshLock = new AsyncLock();
  #systemInfo: SystemInfo;
  #actionsConnection: ActionsConnection | undefined;

  constructor(options: ScaleSetClientOptions) {
    this.#config = parseGitHubConfig(options.githubConfigUrl, options.forceGhes);
    this.#credential = options.credential;
    try {
      validateCredential(this.#credential);
    } catch (error) {
      throw new ScaleSetError(`invalid credentials: ${(error as Error).message}`, "VALIDATION", {
        cause: error,
      });
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#transport = {
      fetch: options.fetch,
      retry: options.retry,
      timeoutMs: options.timeoutMs,
      logger: options.logger,
      sleep: options.sleep,
    };
    this.#systemInfo = {
      system: options.systemInfo?.system ?? "scaleset",
      version: options.systemInfo?.version ?? "0.1.0",
      commitSha: options.systemInfo?.commitSha ?? "",
      scaleSetId: options.systemInfo?.scaleSetId ?? 0,
      subsystem: options.systemInfo?.subsystem ?? "client",
    };
  }

  get systemInfo(): SystemInfo {
    return { ...this.#systemInfo };
  }

  setSystemInfo(systemInfo: SystemInfo): void {
    this.#systemInfo = { ...systemInfo };
  }

  debugInfo(): { hasProxy: boolean; hasRootCA: boolean; systemInfo: string } {
    return {
      hasProxy: this.#transport.fetch?.scalesetTransportInfo?.hasProxy ?? false,
      hasRootCA: this.#transport.fetch?.scalesetTransportInfo?.hasRootCA ?? false,
      systemInfo: userAgent(this.#systemInfo),
    };
  }

  async getRunnerScaleSet(
    runnerGroupId: number,
    runnerScaleSetName: string,
    options?: RequestOptions,
  ): Promise<RunnerScaleSet | undefined> {
    const url = new URL(`/${SCALE_SET_ENDPOINT}`, "https://actions.invalid");
    url.searchParams.set("runnerGroupId", String(runnerGroupId));
    url.searchParams.set("name", runnerScaleSetName);
    const result = await this.#actionsJson<{ count: number; value: RunnerScaleSet[] }>(
      "GET",
      `${url.pathname}${url.search}`,
      undefined,
      [200],
      options?.signal,
    );
    if (result.count === 0) return undefined;
    if (result.count === 1) return result.value[0];
    throw new ScaleSetError(
      `multiple runner scale sets found with name ${JSON.stringify(runnerScaleSetName)}`,
    );
  }

  /** Return every runner scale set belonging to a runner group. */
  async listRunnerScaleSets(
    runnerGroupId: number,
    options?: RequestOptions,
  ): Promise<RunnerScaleSet[]> {
    const url = new URL(`/${SCALE_SET_ENDPOINT}`, "https://actions.invalid");
    url.searchParams.set("runnerGroupId", String(runnerGroupId));
    const result = await this.#actionsJson<{ count: number; value: RunnerScaleSet[] }>(
      "GET",
      `${url.pathname}${url.search}`,
      undefined,
      [200],
      options?.signal,
    );
    return result.value;
  }

  async getRunnerScaleSetById(id: number, options?: RequestOptions): Promise<RunnerScaleSet> {
    return this.#actionsJson(
      "GET",
      `/${SCALE_SET_ENDPOINT}/${id}`,
      undefined,
      [200],
      options?.signal,
    );
  }

  async getRunnerGroupByName(name: string, options?: RequestOptions): Promise<RunnerGroup> {
    const url = new URL("/_apis/runtime/runnergroups/", "https://actions.invalid");
    url.searchParams.set("groupName", name);
    const result = await this.#actionsJson<RunnerGroupList>(
      "GET",
      `${url.pathname}${url.search}`,
      undefined,
      [200],
      options?.signal,
    );
    if (result.count === 1 && result.value[0]) return result.value[0];
    if (result.count === 0)
      throw new ScaleSetError(`no runner group found with name ${JSON.stringify(name)}`);
    throw new ScaleSetError(`multiple runner groups found with name ${JSON.stringify(name)}`);
  }

  async createRunnerScaleSet(
    runnerScaleSet: RunnerScaleSet,
    options?: RequestOptions,
  ): Promise<RunnerScaleSet> {
    const input = withDefaultLabels(runnerScaleSet, true);
    return this.#actionsJson("POST", `/${SCALE_SET_ENDPOINT}`, input, [200], options?.signal);
  }

  async updateRunnerScaleSet(
    id: number,
    runnerScaleSet: RunnerScaleSet,
    options?: RequestOptions,
  ): Promise<RunnerScaleSet> {
    return this.#actionsJson(
      "PATCH",
      `/${SCALE_SET_ENDPOINT}/${id}`,
      withDefaultLabels(runnerScaleSet, false),
      [200],
      options?.signal,
    );
  }

  async deleteRunnerScaleSet(id: number, options?: RequestOptions): Promise<void> {
    await this.#actionsJson(
      "DELETE",
      `/${SCALE_SET_ENDPOINT}/${id}`,
      undefined,
      [204],
      options?.signal,
    );
  }

  async createMessageSession(
    runnerScaleSetId: number,
    owner: string,
    options?: RequestOptions & { retry?: RetryOptions },
  ): Promise<MessageSessionClient> {
    const session = await this.#actionsJson<RunnerScaleSetSession>(
      "POST",
      `/${SCALE_SET_ENDPOINT}/${runnerScaleSetId}/sessions`,
      // uuid.UUID's zero value is still serialized by the Go reference.
      { sessionId: "00000000-0000-0000-0000-000000000000", ownerName: owner },
      [200],
      options?.signal,
      options?.retry,
    );
    return new MessageSessionClient(this, runnerScaleSetId, owner, session, options?.retry);
  }

  async generateJitRunnerConfig(
    runnerSetting: RunnerScaleSetJitRunnerSetting,
    scaleSetId: number,
    options?: RequestOptions,
  ): Promise<RunnerScaleSetJitRunnerConfig> {
    return this.#actionsJson(
      "POST",
      `/${SCALE_SET_ENDPOINT}/${scaleSetId}/generatejitconfig`,
      runnerSetting,
      [200],
      options?.signal,
    );
  }

  async getRunner(id: number, options?: RequestOptions): Promise<RunnerReference> {
    return this.#actionsJson("GET", `/${RUNNER_ENDPOINT}/${id}`, undefined, [200], options?.signal);
  }

  async getRunnerByName(
    name: string,
    options?: RequestOptions,
  ): Promise<RunnerReference | undefined> {
    const url = new URL(`/${RUNNER_ENDPOINT}`, "https://actions.invalid");
    url.searchParams.set("agentName", name);
    const result = await this.#actionsJson<RunnerReferenceList>(
      "GET",
      `${url.pathname}${url.search}`,
      undefined,
      [200],
      options?.signal,
    );
    if (result.count === 0) return undefined;
    if (result.count === 1) return result.value[0];
    throw new ScaleSetError(`multiple runners found with name ${JSON.stringify(name)}`);
  }

  async removeRunner(id: number, options?: RequestOptions): Promise<void> {
    await this.#actionsJson(
      "DELETE",
      `/${RUNNER_ENDPOINT}/${id}`,
      undefined,
      [204],
      options?.signal,
    );
  }

  /** @internal Used by MessageSessionClient to use the same admin connection and transport. */
  async _actionsRequest(
    method: string,
    path: string,
    body: unknown,
    expectedStatuses: number[],
    signal?: AbortSignal,
    retry?: RetryOptions,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const connection = await this.#ensureActionsConnection(signal);
    const url = joinActionsUrl(connection.url, path);
    const request = new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
        "User-Agent": userAgent(this.#systemInfo),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(toWire(body)),
      signal,
    });
    const response = await send(request, {
      ...this.#transport,
      retry: retry ?? this.#transport.retry,
    });
    if (!expectedStatuses.includes(response.status)) {
      throw await requestError(
        request,
        response,
        new Error(`unexpected status code: ${response.status}`),
      );
    }
    return response;
  }

  /** @internal Transport settings shared with a message session. */
  get _transportOptions(): TransportOptions {
    return this.#transport;
  }

  async #actionsJson<T>(
    method: string,
    path: string,
    body: unknown,
    expectedStatuses: number[],
    signal?: AbortSignal,
    retry?: RetryOptions,
  ): Promise<T> {
    const response = await this._actionsRequest(
      method,
      path,
      body,
      expectedStatuses,
      signal,
      retry,
    );
    if (response.status === 204) return undefined as T;
    return (await readJson(response)) as T;
  }

  async #ensureActionsConnection(signal?: AbortSignal): Promise<ActionsConnection> {
    if (this.#isConnectionFresh()) return this.#actionsConnection!;
    return this.#refreshLock.run(async () => {
      if (this.#isConnectionFresh()) return this.#actionsConnection!;
      this.#transport.logger?.info?.("refreshing Actions service token", {
        githubConfigUrl: this.#config.url.toString(),
      });
      const registration = await this.#getRegistrationToken(signal);
      const connection = await this.#getActionsServiceConnection(registration, signal);
      this.#actionsConnection = {
        url: connection.url,
        token: connection.token,
        expiresAt: jwtExpiry(connection.token),
      };
      return this.#actionsConnection;
    });
  }

  #isConnectionFresh(): boolean {
    return (
      this.#actionsConnection !== undefined &&
      this.#actionsConnection.expiresAt.getTime() > this.#clock().getTime() + 60_000
    );
  }

  async #getRegistrationToken(signal?: AbortSignal): Promise<RegistrationToken> {
    const path = registrationTokenPath(this.#config);
    const request = await this.#githubRequest("POST", path, undefined, signal);
    const response = await send(request, this.#transport);
    if (response.status !== 201) {
      throw await requestError(
        request,
        response,
        new Error(`failed to get runner registration token (${response.status})`),
      );
    }
    const token = (await readJson(response)) as RegistrationToken;
    if (!token.token)
      throw new ScaleSetError("runner registration response did not contain a token");
    return token;
  }

  async #getActionsServiceConnection(
    registrationToken: RegistrationToken,
    signal?: AbortSignal,
  ): Promise<{ url: string; token: string }> {
    const request = new Request(githubApiUrl(this.#config, "/actions/runner-registration"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `RemoteAuth ${registrationToken.token}`,
        "User-Agent": userAgent(this.#systemInfo),
      },
      // The reference client uses json.Encoder.Encode, which terminates this
      // bootstrap request with a newline.
      body: `${JSON.stringify({ url: this.#config.url.toString(), runner_event: "register" })}\n`,
      signal,
    });
    const response = await send(request, this.#transport, true);
    if (response.status < 200 || response.status > 299) {
      throw await requestError(
        request,
        response,
        new Error(`unexpected status code: ${response.status}`),
      );
    }
    const connection = (await readJson(response)) as ActionsServiceAdminConnection;
    if (!connection.url || !connection.token) {
      throw new ScaleSetError("actions service admin connection missing URL or token");
    }
    return { url: connection.url, token: connection.token };
  }

  async #githubRequest(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Request> {
    const request = new Request(githubApiUrl(this.#config, path), {
      method,
      headers: { "User-Agent": userAgent(this.#systemInfo) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const token = await this.#githubToken(signal);
    request.headers.set("Authorization", `Bearer ${token}`);
    request.headers.set("Content-Type", "application/vnd.github.v3+json");
    return request;
  }

  async #githubToken(signal?: AbortSignal): Promise<string> {
    if (this.#credential.type === "personal-access-token") return this.#credential.token;
    if (this.#credential.type === "token-provider")
      return this.#credential.tokenProvider.getToken(signal);

    const jwt = await createGitHubAppJwt(this.#credential, this.#clock());
    const request = new Request(
      githubApiUrl(
        this.#config,
        `/app/installations/${this.#credential.installationId}/access_tokens`,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "User-Agent": userAgent(this.#systemInfo),
        },
        signal,
      },
    );
    const response = await send(request, this.#transport);
    if (response.status !== 201) {
      throw await requestError(
        request,
        response,
        new Error(`failed to get GitHub App access token (${response.status})`),
      );
    }
    const token = (await readJson(response)) as AccessToken;
    if (!token.token)
      throw new ScaleSetError("GitHub App access token response did not contain a token");
    return token.token;
  }
}

function withDefaultLabels(value: RunnerScaleSet, create: boolean): RunnerScaleSet {
  const labels = value.labels?.map((label) => ({ ...label, type: label.type || "System" }));
  if ((!labels || labels.length === 0) && create) {
    if (!value.name)
      throw new ScaleSetError(
        "runner scale set must have a name or at least one label",
        "VALIDATION",
      );
    return withGoZeroValues({ ...value, labels: [{ name: value.name, type: "System" }] });
  }
  return withGoZeroValues({ ...value, ...(labels ? { labels } : {}) });
}

function withGoZeroValues(value: RunnerScaleSet): RunnerScaleSet {
  // encoding/json does not omit a value-typed struct or time.Time. Keep this
  // wire-level quirk so Go and TypeScript produce the same protocol payloads.
  return {
    ...value,
    runnerSetting: value.runnerSetting ?? {},
    createdOn: value.createdOn ?? "0001-01-01T00:00:00Z",
  };
}

function joinActionsUrl(base: string, path: string): URL {
  const input = new URL(path, "https://actions.invalid");
  const url = new URL(input.pathname.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of input.searchParams) url.searchParams.set(key, value);
  if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", "6.0-preview");
  url.searchParams.sort();
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  const text = (await response.text()).replace(/^\uFEFF/, "");
  try {
    return fromWire(JSON.parse(text));
  } catch (error) {
    throw new ScaleSetError(
      `failed to parse JSON response: ${(error as Error).message}`,
      "REQUEST_FAILED",
      {
        cause: error,
      },
    );
  }
}

function jwtExpiry(token: string): Date {
  try {
    const part = token.split(".")[1];
    if (!part) throw new Error("missing JWT payload");
    const payload = JSON.parse(fromBase64Url(part)) as { exp?: unknown };
    if (typeof payload.exp !== "number") throw new Error("missing JWT expiration");
    return new Date(payload.exp * 1_000);
  } catch (error) {
    throw new ScaleSetError(
      `failed to parse Actions service token expiry: ${(error as Error).message}`,
      "REQUEST_FAILED",
      {
        cause: error,
      },
    );
  }
}

function fromBase64Url(value: string): string {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (!isRecord(value)) return value;
  const wire: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    wire[key === "runnerSetting" ? "RunnerSetting" : key] = Array.isArray(field)
      ? field.map(toWire)
      : isRecord(field)
        ? toWire(field)
        : field;
  }
  return wire;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
