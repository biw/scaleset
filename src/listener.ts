import type { MessageSessionClient } from "./session.js";
import type {
  JobCompleted,
  JobStarted,
  Logger,
  RunnerScaleSetMessage,
  RunnerScaleSetStatistic,
} from "./types.js";

export interface ListenerClient {
  readonly session: { sessionId?: string; statistics?: RunnerScaleSetStatistic };
  getMessage(
    lastMessageId: number,
    maxCapacity: number,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerScaleSetMessage | undefined>;
  deleteMessage(messageId: number): Promise<void>;
  acquireJobs(requestIds: number[]): Promise<number[]>;
}

export interface ScaleSetScaler {
  handleJobStarted(job: JobStarted): Promise<void> | void;
  handleJobCompleted(job: JobCompleted): Promise<void> | void;
  handleDesiredRunnerCount(count: number): Promise<number> | number;
}

export interface MetricsRecorder {
  recordStatistics(statistics: RunnerScaleSetStatistic): void;
  recordJobStarted(message: JobStarted): void;
  recordJobCompleted(message: JobCompleted): void;
  recordDesiredRunners(count: number): void;
}

export interface ScaleSetListenerOptions {
  scaleSetId: number;
  maxRunners?: number;
  metricsRecorder?: MetricsRecorder;
  logger?: Logger;
}

const discardMetrics: MetricsRecorder = {
  recordStatistics() {},
  recordJobStarted() {},
  recordJobCompleted() {},
  recordDesiredRunners() {},
};

/**
 * Runs the upstream listener state machine against a session client and a
 * consumer-provided scaler. It intentionally contains no provider logic.
 */
export class ScaleSetListener {
  readonly #client: ListenerClient;
  readonly #scaleSetId: number;
  readonly #metrics: MetricsRecorder;
  readonly #logger: Logger | undefined;
  #maxRunners = 0;
  #latestStatistics: RunnerScaleSetStatistic | undefined;

  constructor(client: ListenerClient | MessageSessionClient, options: ScaleSetListenerOptions) {
    if (!client) throw new Error("client is required");
    if (!Number.isInteger(options.scaleSetId) || options.scaleSetId === 0) {
      throw new Error("scaleSetId is required");
    }
    this.#client = client;
    this.#scaleSetId = options.scaleSetId;
    this.#metrics = options.metricsRecorder ?? discardMetrics;
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
    if (!Number.isInteger(count) || count < 0 || count > 2_147_483_647) {
      throw new Error("maxRunners must be between 0 and MaxInt32");
    }
    this.#maxRunners = count;
  }

  async run(scaler: ScaleSetScaler, signal?: AbortSignal): Promise<never> {
    const initialSession = this.#client.session;
    if (!initialSession.sessionId) throw new Error("initial session is nil");
    if (!initialSession.statistics) throw new Error("session statistics is nil");
    this.#recordStatistics(initialSession.statistics);
    const initialDesired = await scaler.handleDesiredRunnerCount(
      initialSession.statistics.totalAssignedJobs,
    );
    this.#metrics.recordDesiredRunners(initialDesired);

    let lastMessageId = 0;
    for (;;) {
      throwIfAborted(signal);
      this.#logger?.info?.("Getting next message", { lastMessageId });
      const message = await this.#client.getMessage(lastMessageId, this.#maxRunners, { signal });
      if (!message) {
        if (!this.#latestStatistics) throw new Error("listener statistics are nil");
        await scaler.handleDesiredRunnerCount(this.#latestStatistics.totalAssignedJobs);
        continue;
      }
      lastMessageId = message.messageId;
      await this.#handleMessage(scaler, message);
    }
  }

  async #handleMessage(scaler: ScaleSetScaler, message: RunnerScaleSetMessage): Promise<void> {
    if (!message.statistics) throw new Error("message statistics are nil");
    this.#recordStatistics(message.statistics);

    // The upstream Go listener acknowledges before it acquires/calls handlers.
    await this.#client.deleteMessage(message.messageId);
    if (message.jobAvailableMessages.length > 0) {
      await this.#client.acquireJobs(
        message.jobAvailableMessages.map((job) => job.runnerRequestId),
      );
    }
    for (const job of message.jobStartedMessages) {
      this.#metrics.recordJobStarted(job);
      await scaler.handleJobStarted(job);
    }
    for (const job of message.jobCompletedMessages) {
      this.#metrics.recordJobCompleted(job);
      await scaler.handleJobCompleted(job);
    }
    const desired = await scaler.handleDesiredRunnerCount(message.statistics.totalAssignedJobs);
    this.#metrics.recordDesiredRunners(desired);
  }

  #recordStatistics(statistics: RunnerScaleSetStatistic): void {
    this.#latestStatistics = statistics;
    this.#metrics.recordStatistics(statistics);
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
): asserts signal is AbortSignal | undefined {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
