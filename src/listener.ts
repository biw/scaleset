import type { MessageSessionClient } from "./session.js";
import type { Logger, RunnerScaleSetMessage, RunnerScaleSetStatistic } from "./types.js";

export interface ListenerClient {
  readonly session: { sessionId?: string; statistics?: RunnerScaleSetStatistic };
  getMessage(
    lastMessageId: number,
    maxCapacity: number,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerScaleSetMessage | undefined>;
  deleteMessage(messageId: number, options?: { signal?: AbortSignal }): Promise<void>;
  acquireJobs(requestIds: number[], options?: { signal?: AbortSignal }): Promise<number[]>;
}

/** Serializable state required to resume scale-set message polling. */
export interface ScaleSetCheckpoint {
  lastMessageId: number;
  statistics: RunnerScaleSetStatistic;
}

export interface ScaleSetPollOptions {
  maxRunners: number;
  signal?: AbortSignal;
}

export interface IdleScaleSetPollResult {
  kind: "idle";
  checkpoint: ScaleSetCheckpoint;
  desiredRunnerCount: number;
}

export interface MessageScaleSetPollResult {
  kind: "message";
  message: RunnerScaleSetMessage;
  desiredRunnerCount: number;
  acquire(requestIds: number[]): Promise<number[]>;
  acknowledge(): Promise<ScaleSetCheckpoint>;
}

export type ScaleSetPollResult = IdleScaleSetPollResult | MessageScaleSetPollResult;

/**
 * Handles complete scale-set messages. Calls are serialized.
 *
 * The first call receives a synthetic message with {@link INITIAL_MESSAGE_ID}
 * and the session statistics. An empty long poll is delivered as `undefined`;
 * cache statistics if you want to keep reconciling while the queue is idle.
 * The handler is responsible for acquiring every available job it wants.
 *
 * A real message is acknowledged only after this method succeeds. If it
 * throws, the listener stops without acknowledging, so the message and any
 * partial work may be repeated. Implementations should be idempotent.
 */
export interface ScaleSetScaler {
  scale(
    message: RunnerScaleSetMessage | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<void> | void;
}

export interface ScaleSetListenerOptions {
  scaleSetId: number;
  maxRunners?: number;
  logger?: Logger;
}

/** Message ID used for the synthetic session-statistics message. */
export const INITIAL_MESSAGE_ID = -1;

/**
 * Performs one scale-set long poll using caller-owned, serializable state.
 * It never acknowledges a message automatically.
 */
export class ResumableScaleSetListener {
  readonly #client: ListenerClient;

  constructor(client: ListenerClient | MessageSessionClient) {
    if (!client) throw new Error("client is required");
    this.#client = client;
  }

  /** Create the first checkpoint from the message session's authoritative statistics. */
  initialCheckpoint(): ScaleSetCheckpoint {
    const session = this.#client.session;
    if (!session.sessionId) throw new Error("initial session is nil");
    if (!session.statistics) throw new Error("session statistics is nil");
    return checkpoint(0, requireStatistics(session.statistics, "session statistics"));
  }

  /** Perform at most one long poll without mutating the supplied checkpoint. */
  async poll(
    savedCheckpoint: ScaleSetCheckpoint,
    options: ScaleSetPollOptions,
  ): Promise<ScaleSetPollResult> {
    throwIfAborted(options.signal);
    validateMaxRunners(options.maxRunners);
    const current = restoreCheckpoint(savedCheckpoint);
    const message = await this.#client.getMessage(current.lastMessageId, options.maxRunners, {
      signal: options.signal,
    });

    if (!message) {
      return {
        kind: "idle",
        checkpoint: current,
        desiredRunnerCount: current.statistics.totalAssignedJobs,
      };
    }

    const messageId = requireMessageId(message.messageId);
    if (messageId < current.lastMessageId) {
      throw new Error(`message ID ${messageId} is older than checkpoint ${current.lastMessageId}`);
    }
    const statistics = requireStatistics(message.statistics, "message statistics");
    const nextCheckpoint = checkpoint(messageId, statistics);
    const available = new Set(message.jobAvailableMessages.map((job) => job.runnerRequestId));
    let acknowledged: ScaleSetCheckpoint | undefined;
    let acknowledgement: Promise<ScaleSetCheckpoint> | undefined;
    let acquisitionsInProgress = 0;

    return {
      kind: "message",
      message,
      desiredRunnerCount: statistics.totalAssignedJobs,
      acquire: async (requestIds) => {
        if (acknowledged) throw new Error("message has already been acknowledged");
        if (acknowledgement) throw new Error("message acknowledgement is in progress");
        validateAcquisition(requestIds, available);
        throwIfAborted(options.signal);
        acquisitionsInProgress += 1;
        try {
          return await this.#client.acquireJobs(requestIds, { signal: options.signal });
        } finally {
          acquisitionsInProgress -= 1;
        }
      },
      acknowledge: async () => {
        if (acknowledged) return checkpoint(acknowledged.lastMessageId, acknowledged.statistics);
        if (acquisitionsInProgress > 0) {
          throw new Error("cannot acknowledge while job acquisition is in progress");
        }
        if (!acknowledgement) {
          acknowledgement = this.#client
            .deleteMessage(messageId)
            .then(() => {
              acknowledged = nextCheckpoint;
              return checkpoint(nextCheckpoint.lastMessageId, nextCheckpoint.statistics);
            })
            .finally(() => {
              if (!acknowledged) acknowledgement = undefined;
            });
        }
        return acknowledgement;
      },
    };
  }
}

/**
 * Runs the upstream listener state machine against a session client and a
 * consumer-provided scaler. The listener owns session polling and message
 * acknowledgement; the scaler owns all message handling, including acquiring
 * jobs. A message is acknowledged only after `scale` succeeds.
 */
export class ScaleSetListener {
  readonly #resumable: ResumableScaleSetListener;
  readonly #scaleSetId: number;
  readonly #logger: Logger | undefined;
  #maxRunners = 0;

  constructor(client: ListenerClient | MessageSessionClient, options: ScaleSetListenerOptions) {
    if (!client) throw new Error("client is required");
    if (!Number.isInteger(options.scaleSetId) || options.scaleSetId === 0) {
      throw new Error("scaleSetId is required");
    }
    this.#resumable = new ResumableScaleSetListener(client);
    this.#scaleSetId = options.scaleSetId;
    this.#logger = options.logger;
    this.setMaxRunners(options.maxRunners ?? 0);
  }

  get scaleSetId(): number {
    return this.#scaleSetId;
  }

  get maxRunners(): number {
    return this.#maxRunners;
  }

  setMaxRunners(count: number): void {
    validateMaxRunners(count);
    this.#maxRunners = count;
  }

  async run(scaler: ScaleSetScaler, signal?: AbortSignal): Promise<never> {
    let current = this.#resumable.initialCheckpoint();
    try {
      await scaler.scale(
        {
          messageId: INITIAL_MESSAGE_ID,
          statistics: current.statistics,
          jobAvailableMessages: [],
          jobAssignedMessages: [],
          jobStartedMessages: [],
          jobCompletedMessages: [],
        },
        { signal },
      );
    } catch (cause) {
      throw new Error("failed to handle initial session statistics", { cause });
    }
    this.#logger?.info?.("Handling initial session statistics", {
      totalAssignedJobs: current.statistics.totalAssignedJobs,
    });

    for (;;) {
      throwIfAborted(signal);
      this.#logger?.info?.("Getting next message", { lastMessageId: current.lastMessageId });
      const result = await this.#resumable.poll(current, {
        maxRunners: this.#maxRunners,
        signal,
      });
      try {
        await scaler.scale(result.kind === "message" ? result.message : undefined, { signal });
      } catch (cause) {
        throw new Error("failed to scale", { cause });
      }
      if (result.kind === "message") {
        try {
          current = await result.acknowledge();
        } catch (cause) {
          throw new Error(`failed to delete the message ${result.message.messageId}`, { cause });
        }
      } else {
        current = result.checkpoint;
      }
    }
  }
}

const statisticFields = [
  "totalAvailableJobs",
  "totalAcquiredJobs",
  "totalAssignedJobs",
  "totalRunningJobs",
  "totalRegisteredRunners",
  "totalBusyRunners",
  "totalIdleRunners",
] as const satisfies readonly (keyof RunnerScaleSetStatistic)[];

function restoreCheckpoint(value: ScaleSetCheckpoint): ScaleSetCheckpoint {
  if (!value || !Number.isSafeInteger(value.lastMessageId) || value.lastMessageId < 0) {
    throw new Error("checkpoint lastMessageId must be a non-negative safe integer");
  }
  return checkpoint(
    value.lastMessageId,
    requireStatistics(value.statistics, "checkpoint statistics"),
  );
}

function checkpoint(
  lastMessageId: number,
  statistics: RunnerScaleSetStatistic,
): ScaleSetCheckpoint {
  return { lastMessageId, statistics: { ...statistics } };
}

function requireMessageId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("message ID must be a non-negative safe integer");
  }
  return value;
}

function requireStatistics(
  value: RunnerScaleSetStatistic | undefined,
  label: string,
): RunnerScaleSetStatistic {
  if (!value || typeof value !== "object") throw new Error(`${label} are invalid`);
  for (const field of statisticFields) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new Error(`${label} are invalid: ${field} must be a non-negative safe integer`);
    }
  }
  return value;
}

function validateAcquisition(requestIds: number[], available: ReadonlySet<number>): void {
  if (!Array.isArray(requestIds)) throw new Error("requestIds must be an array");
  const requested = new Set<number>();
  for (const requestId of requestIds) {
    if (!Number.isSafeInteger(requestId)) {
      throw new Error("runner request IDs must be safe integers");
    }
    if (requested.has(requestId)) {
      throw new Error(`runner request ID ${requestId} is duplicated`);
    }
    if (!available.has(requestId)) {
      throw new Error(`runner request ID ${requestId} is not available in this message`);
    }
    requested.add(requestId);
  }
}

function validateMaxRunners(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > 2_147_483_647) {
    throw new Error("maxRunners must be between 0 and MaxInt32");
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
): asserts signal is AbortSignal | undefined {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
