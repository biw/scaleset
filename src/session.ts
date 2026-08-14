import { isScaleSetError, messageQueueTokenExpiredError, requestError } from "./errors.js";
import { AsyncLock, SCALE_SET_ENDPOINT, fromWire, send, userAgent } from "./internal.js";
import { HEADER_SCALE_SET_MAX_CAPACITY } from "./types.js";
import type { RequestOptions, ScaleSetClient } from "./client.js";
import type {
  JobAssigned,
  JobAvailable,
  JobCompleted,
  JobStarted,
  RetryOptions,
  RunnerScaleSetMessage,
  RunnerScaleSetSession,
} from "./types.js";

/** A created scale-set message session. Call close when its listener stops. */
export class MessageSessionClient {
  readonly #refreshLock = new AsyncLock();
  readonly #client: ScaleSetClient;
  readonly #scaleSetId: number;
  readonly #owner: string;
  readonly #retry: RetryOptions | undefined;
  #session: RunnerScaleSetSession;

  constructor(
    client: ScaleSetClient,
    scaleSetId: number,
    owner: string,
    session: RunnerScaleSetSession,
    retry?: RetryOptions,
  ) {
    this.#client = client;
    this.#scaleSetId = scaleSetId;
    this.#owner = owner;
    this.#session = session;
    this.#retry = retry;
  }

  get session(): RunnerScaleSetSession {
    return { ...this.#session };
  }

  get owner(): string {
    return this.#owner;
  }

  async close(options?: RequestOptions): Promise<void> {
    const sessionId = this.#requireSessionId();
    await this.#client._actionsRequest(
      "DELETE",
      `/${SCALE_SET_ENDPOINT}/${this.#scaleSetId}/sessions/${sessionId}`,
      undefined,
      [204],
      options?.signal,
      this.#retry,
    );
  }

  async getMessage(
    lastMessageId: number,
    maxCapacity: number,
    options?: RequestOptions,
  ): Promise<RunnerScaleSetMessage | undefined> {
    return this.#withRefresh(options?.signal, () =>
      this.#getMessage(lastMessageId, maxCapacity, options?.signal),
    );
  }

  async deleteMessage(messageId: number, options?: RequestOptions): Promise<void> {
    await this.#withRefresh(options?.signal, () => this.#deleteMessage(messageId, options?.signal));
  }

  async acquireJobs(requestIds: number[], options?: RequestOptions): Promise<number[]> {
    return this.#withRefresh(options?.signal, () => this.#acquireJobs(requestIds, options?.signal));
  }

  async #withRefresh<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const expiredSession = this.#session;
    try {
      return await operation();
    } catch (error) {
      if (!isScaleSetError(error, "MESSAGE_QUEUE_TOKEN_EXPIRED")) throw error;
      await this.#refresh(signal, expiredSession);
      return operation();
    }
  }

  async #refresh(
    signal: AbortSignal | undefined,
    expiredSession: RunnerScaleSetSession,
  ): Promise<void> {
    await this.#refreshLock.run(async () => {
      // Another concurrent request may already have refreshed this session.
      if (
        this.#session.sessionId !== expiredSession.sessionId ||
        this.#session.messageQueueAccessToken !== expiredSession.messageQueueAccessToken
      )
        return;
      const sessionId = this.#requireSessionId();
      const response = await this.#client._actionsRequest(
        "PATCH",
        `/${SCALE_SET_ENDPOINT}/${this.#scaleSetId}/sessions/${sessionId}`,
        undefined,
        [200],
        signal,
        this.#retry,
      );
      this.#session = fromWire(await response.json()) as RunnerScaleSetSession;
    });
  }

  async #getMessage(
    lastMessageId: number,
    maxCapacity: number,
    signal?: AbortSignal,
  ): Promise<RunnerScaleSetMessage | undefined> {
    const queueUrl = this.#queueUrl();
    if (lastMessageId > 0) queueUrl.searchParams.set("lastMessageId", String(lastMessageId));
    const request = new Request(queueUrl, {
      headers: {
        Accept: "application/json; api-version=6.0-preview",
        Authorization: `Bearer ${this.#requireQueueToken()}`,
        "User-Agent": userAgent(this.#client.systemInfo),
        [HEADER_SCALE_SET_MAX_CAPACITY]: String(maxCapacity),
      },
      signal,
    });
    const response = await send(request, { ...this.#client._transportOptions, retry: this.#retry });
    if (response.status === 202) return undefined;
    if (response.status === 401)
      throw await requestError(request, response, messageQueueTokenExpiredError());
    if (response.status !== 200) {
      throw await requestError(
        request,
        response,
        new Error(`unexpected status code ${response.status}`),
      );
    }
    return parseRunnerScaleSetMessage(fromWire(await response.json()));
  }

  async #deleteMessage(messageId: number, signal?: AbortSignal): Promise<void> {
    const queueUrl = this.#queueUrl();
    queueUrl.pathname = `${queueUrl.pathname.replace(/\/$/, "")}/${messageId}`;
    const request = new Request(queueUrl, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#requireQueueToken()}`,
        "User-Agent": userAgent(this.#client.systemInfo),
      },
      signal,
    });
    const response = await send(request, { ...this.#client._transportOptions, retry: this.#retry });
    if (response.status === 204) return;
    if (response.status === 401)
      throw await requestError(request, response, messageQueueTokenExpiredError());
    throw await requestError(
      request,
      response,
      new Error(`unexpected status code ${response.status}`),
    );
  }

  async #acquireJobs(requestIds: number[], signal?: AbortSignal): Promise<number[]> {
    const response = await this.#client._actionsRequest(
      "POST",
      `/${SCALE_SET_ENDPOINT}/${this.#scaleSetId}/acquirejobs`,
      requestIds,
      [200, 401],
      signal,
      this.#retry,
      { Authorization: `Bearer ${this.#requireQueueToken()}` },
    );
    if (response.status === 401) {
      const request = new Request(response.url || "https://actions.invalid/acquirejobs", {
        method: "POST",
      });
      throw await requestError(request, response, messageQueueTokenExpiredError());
    }
    const result = (await response.json()) as { value?: unknown };
    if (!Array.isArray(result.value) || !result.value.every((id) => typeof id === "number")) {
      throw new Error("failed to decode acquired job IDs");
    }
    return result.value;
  }

  #queueUrl(): URL {
    const value = this.#session.messageQueueUrl;
    if (!value) throw new Error("message session is missing a message queue URL");
    return new URL(value);
  }

  #requireQueueToken(): string {
    if (!this.#session.messageQueueAccessToken)
      throw new Error("message session is missing a queue access token");
    return this.#session.messageQueueAccessToken;
  }

  #requireSessionId(): string {
    if (!this.#session.sessionId) throw new Error("message session is missing a session ID");
    return this.#session.sessionId;
  }
}

export function parseRunnerScaleSetMessage(value: unknown): RunnerScaleSetMessage {
  if (
    !isRecord(value) ||
    value.messageType !== "RunnerScaleSetJobMessages" ||
    typeof value.messageId !== "number"
  ) {
    throw new Error(
      `unsupported runner scale set message type: ${isRecord(value) ? String(value.messageType) : "unknown"}`,
    );
  }
  const result: RunnerScaleSetMessage = {
    messageId: value.messageId,
    ...(isRecord(value.statistics)
      ? {
          statistics: value.statistics as unknown as NonNullable<
            RunnerScaleSetMessage["statistics"]
          >,
        }
      : {}),
    jobAvailableMessages: [],
    jobAssignedMessages: [],
    jobStartedMessages: [],
    jobCompletedMessages: [],
  };
  if (typeof value.body !== "string" || !value.body) return result;
  let messages: unknown;
  try {
    messages = JSON.parse(value.body);
  } catch (error) {
    throw new Error(`failed to parse batched runner messages: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!Array.isArray(messages)) throw new Error("batched runner messages must be an array");
  for (const message of messages) {
    if (!isRecord(message) || typeof message.messageType !== "string") continue;
    switch (message.messageType) {
      case "JobAvailable":
        result.jobAvailableMessages.push(message as unknown as JobAvailable);
        break;
      case "JobAssigned":
        result.jobAssignedMessages.push(message as unknown as JobAssigned);
        break;
      case "JobStarted":
        result.jobStartedMessages.push(message as unknown as JobStarted);
        break;
      case "JobCompleted":
        result.jobCompletedMessages.push(message as unknown as JobCompleted);
        break;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
