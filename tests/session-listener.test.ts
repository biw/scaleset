import { describe, expect, it } from "vite-plus/test";
import {
  INITIAL_MESSAGE_ID,
  MessageSessionClient,
  ResumableScaleSetListener,
  ScaleSetListener,
  parseRunnerScaleSetMessage,
  type ListenerClient,
  type RunnerScaleSetMessage,
  type RunnerScaleSetStatistic,
} from "../src/index.js";

const statistics: RunnerScaleSetStatistic = {
  totalAvailableJobs: 0,
  totalAcquiredJobs: 0,
  totalAssignedJobs: 2,
  totalRunningJobs: 0,
  totalRegisteredRunners: 0,
  totalBusyRunners: 0,
  totalIdleRunners: 0,
};

describe("MessageSessionClient", () => {
  it("refreshes a session queue token after a 401", async () => {
    let queueCalls = 0;
    const client = {
      systemInfo: { system: "test", version: "1", commitSha: "", scaleSetId: 1, subsystem: "test" },
      _transportOptions: {
        fetch: async () => {
          queueCalls += 1;
          return queueCalls === 1
            ? new Response("", { status: 401 })
            : new Response(
                JSON.stringify({ messageId: 3, messageType: "RunnerScaleSetJobMessages" }),
              );
        },
      },
      _actionsRequest: async () =>
        new Response(
          JSON.stringify({
            sessionId: "updated",
            messageQueueUrl: "https://queue.example/messages",
            messageQueueAccessToken: "new-token",
          }),
        ),
    } as never;
    const session = new MessageSessionClient(client, 1, "owner", {
      sessionId: "initial",
      messageQueueUrl: "https://queue.example/messages",
      messageQueueAccessToken: "old-token",
    });

    await expect(session.getMessage(0, 4)).resolves.toMatchObject({ messageId: 3 });
    expect(queueCalls).toBe(2);
    expect(session.session.sessionId).toBe("updated");
  });

  it("refreshes a session queue token before retrying delete and acquire operations", async () => {
    let deletes = 0;
    let acquires = 0;
    let refreshes = 0;
    const client = {
      systemInfo: { system: "test", version: "1", commitSha: "", scaleSetId: 1, subsystem: "test" },
      _transportOptions: {
        fetch: async (input: RequestInfo | URL) => {
          const request = new Request(input);
          if (request.method === "DELETE") {
            deletes += 1;
            return deletes === 1
              ? new Response("", { status: 401 })
              : new Response(null, { status: 204 });
          }
          return new Response("", { status: 500 });
        },
      },
      _actionsRequest: async (method: string) => {
        if (method === "PATCH") {
          refreshes += 1;
          return new Response(
            JSON.stringify({
              sessionId: `updated-${refreshes}`,
              messageQueueUrl: "https://queue.example/messages",
              messageQueueAccessToken: `new-token-${refreshes}`,
            }),
          );
        }
        acquires += 1;
        return acquires === 1
          ? new Response("", { status: 401 })
          : new Response(JSON.stringify({ value: [9] }));
      },
    } as never;
    const session = new MessageSessionClient(client, 1, "owner", {
      sessionId: "initial",
      messageQueueUrl: "https://queue.example/messages",
      messageQueueAccessToken: "old-token",
    });

    await expect(session.deleteMessage(4)).resolves.toBeUndefined();
    await expect(session.acquireJobs([9])).resolves.toEqual([9]);
    expect({ deletes, acquires, refreshes }).toEqual({ deletes: 2, acquires: 2, refreshes: 2 });
    expect(session.session.messageQueueAccessToken).toBe("new-token-2");
  });

  it("parses batched lifecycle messages and rejects malformed queue messages", () => {
    const parsed = parseRunnerScaleSetMessage({
      messageId: 7,
      messageType: "RunnerScaleSetJobMessages",
      body: JSON.stringify([
        { messageType: "JobAvailable", runnerRequestId: 1 },
        { messageType: "JobAssigned", runnerRequestId: 2 },
        { messageType: "JobStarted", runnerRequestId: 3 },
        { messageType: "JobCompleted", runnerRequestId: 4 },
        { messageType: "Unknown" },
      ]),
    });

    expect(parsed.jobAvailableMessages).toHaveLength(1);
    expect(parsed.jobAssignedMessages).toHaveLength(1);
    expect(parsed.jobStartedMessages).toHaveLength(1);
    expect(parsed.jobCompletedMessages).toHaveLength(1);
    expect(() => parseRunnerScaleSetMessage({ messageId: 1, messageType: "Unexpected" })).toThrow(
      "unsupported runner scale set message type",
    );
    expect(() =>
      parseRunnerScaleSetMessage({
        messageId: 1,
        messageType: "RunnerScaleSetJobMessages",
        body: "not-json",
      }),
    ).toThrow("failed to parse batched runner messages");
  });

  it("preserves repeated lifecycle records when events arrive out of order", () => {
    const parsed = parseRunnerScaleSetMessage({
      messageId: 8,
      messageType: "RunnerScaleSetJobMessages",
      body: JSON.stringify([
        { messageType: "JobCompleted", runnerRequestId: 41, result: "first-completion" },
        { messageType: "JobAvailable", runnerRequestId: 41 },
        { messageType: "JobStarted", runnerRequestId: 41, runnerName: "runner-1" },
        { messageType: "JobAssigned", runnerRequestId: 41 },
        { messageType: "JobCompleted", runnerRequestId: 41, result: "duplicate-completion" },
      ]),
    });

    expect(parsed.jobAvailableMessages.map((message) => message.runnerRequestId)).toEqual([41]);
    expect(parsed.jobAssignedMessages.map((message) => message.runnerRequestId)).toEqual([41]);
    expect(parsed.jobStartedMessages.map((message) => message.runnerRequestId)).toEqual([41]);
    expect(parsed.jobCompletedMessages.map((message) => message.result)).toEqual([
      "first-completion",
      "duplicate-completion",
    ]);
  });
});

describe("ResumableScaleSetListener", () => {
  it("validates initial session and persisted state before polling", async () => {
    expect(() => new ResumableScaleSetListener(undefined as never)).toThrow("client is required");
    expect(() =>
      new ResumableScaleSetListener({
        session: { statistics },
        getMessage: async () => undefined,
        deleteMessage: async () => {},
        acquireJobs: async () => [],
      }).initialCheckpoint(),
    ).toThrow("initial session is nil");
    expect(() =>
      new ResumableScaleSetListener({
        session: { sessionId: "session" },
        getMessage: async () => undefined,
        deleteMessage: async () => {},
        acquireJobs: async () => [],
      }).initialCheckpoint(),
    ).toThrow("session statistics is nil");

    let polls = 0;
    const listener = resumableListener(async () => {
      polls += 1;
      return undefined;
    });
    await expect(
      listener.poll(
        {
          lastMessageId: 3,
          statistics: { ...statistics, totalBusyRunners: -1 },
        },
        { maxRunners: 1 },
      ),
    ).rejects.toThrow("checkpoint statistics are invalid");
    await expect(
      listener.poll(listener.initialCheckpoint(), { maxRunners: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("maxRunners must be between 0 and MaxInt32");
    expect(polls).toBe(0);
  });

  it("restores a serialized checkpoint and uses its cursor for one poll", async () => {
    const signal = new AbortController().signal;
    const polls: Array<{ lastMessageId: number; maxCapacity: number; signal?: AbortSignal }> = [];
    const message = runnerMessage(42, {
      statistics: { ...statistics, totalAssignedJobs: 9 },
      jobAvailableMessages: [
        { messageType: "JobAvailable", runnerRequestId: 101 } as never,
        { messageType: "JobAvailable", runnerRequestId: 102 } as never,
      ],
    });
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async (lastMessageId, maxCapacity, options) => {
        polls.push({ lastMessageId, maxCapacity, signal: options?.signal });
        return message;
      },
      deleteMessage: async () => {},
      acquireJobs: async () => [],
    });
    const initial = listener.initialCheckpoint();
    const restored = JSON.parse(
      JSON.stringify({ ...initial, lastMessageId: 41 }),
    ) as typeof initial;

    const result = await listener.poll(restored, { maxRunners: 12, signal });

    expect(result.kind).toBe("message");
    expect(result.desiredRunnerCount).toBe(9);
    expect(polls).toEqual([{ lastMessageId: 41, maxCapacity: 12, signal }]);
    expect(restored).toEqual({ lastMessageId: 41, statistics });
  });

  it("preserves every lifecycle record, including repeated jobs and JobAssigned", async () => {
    const available = { messageType: "JobAvailable", runnerRequestId: 21 } as never;
    const assigned = { messageType: "JobAssigned", runnerRequestId: 21 } as never;
    const started = { messageType: "JobStarted", runnerRequestId: 21 } as never;
    const completed = { messageType: "JobCompleted", runnerRequestId: 21 } as never;
    const message = runnerMessage(6, {
      jobAvailableMessages: [available],
      jobAssignedMessages: [assigned],
      jobStartedMessages: [started, started],
      jobCompletedMessages: [completed, completed],
    });
    const listener = resumableListener(async () => message);

    const result = await listener.poll(listener.initialCheckpoint(), { maxRunners: 4 });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("expected a message result");
    expect(result.message).toBe(message);
    expect(result.message.jobAssignedMessages).toEqual([assigned]);
    expect(result.message.jobStartedMessages).toEqual([started, started]);
    expect(result.message.jobCompletedMessages).toEqual([completed, completed]);
  });

  it("retains the checkpoint and desired count after an empty poll", async () => {
    const listener = resumableListener(async () => undefined);
    const saved = {
      lastMessageId: 8,
      statistics: { ...statistics, totalAssignedJobs: 13 },
    };

    const result = await listener.poll(saved, { maxRunners: 20 });

    expect(result).toEqual({
      kind: "idle",
      checkpoint: saved,
      desiredRunnerCount: 13,
    });
    if (result.kind !== "idle") throw new Error("expected an idle result");
    expect(result.checkpoint).not.toBe(saved);
    expect(result.checkpoint.statistics).not.toBe(saved.statistics);
  });

  it("rejects a stale delivery without acknowledging or regressing the checkpoint", async () => {
    let acknowledgements = 0;
    let acquisitions = 0;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () =>
        runnerMessage(11, { statistics: { ...statistics, totalAssignedJobs: 99 } }),
      deleteMessage: async () => {
        acknowledgements += 1;
      },
      acquireJobs: async () => {
        acquisitions += 1;
        return [];
      },
    });
    const saved = {
      lastMessageId: 12,
      statistics: { ...statistics, totalAssignedJobs: 4 },
    };

    await expect(listener.poll(saved, { maxRunners: 5 })).rejects.toThrow(
      "message ID 11 is older than checkpoint 12",
    );
    expect(saved).toEqual({
      lastMessageId: 12,
      statistics: { ...statistics, totalAssignedJobs: 4 },
    });
    expect({ acknowledgements, acquisitions }).toEqual({ acknowledgements: 0, acquisitions: 0 });
  });

  it("rejects missing or invalid message statistics without acknowledging", async () => {
    let acknowledgements = 0;
    for (const invalid of [
      undefined,
      { ...statistics, totalAssignedJobs: -1 },
      { ...statistics, totalRunningJobs: 1.5 },
    ]) {
      const listener = new ResumableScaleSetListener({
        session: { sessionId: "session", statistics },
        getMessage: async () => runnerMessage(9, { statistics: invalid }),
        deleteMessage: async () => {
          acknowledgements += 1;
        },
        acquireJobs: async () => [],
      });
      const saved = listener.initialCheckpoint();

      await expect(listener.poll(saved, { maxRunners: 2 })).rejects.toThrow(
        "message statistics are invalid",
      );
      expect(saved).toEqual({ lastMessageId: 0, statistics });
    }
    expect(acknowledgements).toBe(0);
  });

  it("does not advance after a failed acknowledgement and permits retry", async () => {
    const acknowledgeError = new Error("queue unavailable");
    let attempts = 0;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () =>
        runnerMessage(14, { statistics: { ...statistics, totalAssignedJobs: 7 } }),
      deleteMessage: async () => {
        attempts += 1;
        if (attempts === 1) throw acknowledgeError;
      },
      acquireJobs: async () => [],
    });
    const saved = listener.initialCheckpoint();
    const result = await listener.poll(saved, { maxRunners: 10 });
    if (result.kind !== "message") throw new Error("expected a message result");

    await expect(result.acknowledge()).rejects.toBe(acknowledgeError);
    expect(saved).toEqual({ lastMessageId: 0, statistics });
    await expect(result.acknowledge()).resolves.toEqual({
      lastMessageId: 14,
      statistics: { ...statistics, totalAssignedJobs: 7 },
    });
    expect(attempts).toBe(2);
  });

  it("deduplicates concurrent acknowledgements and makes successful acknowledgement idempotent", async () => {
    let finishAcknowledgement: (() => void) | undefined;
    const acknowledged: number[] = [];
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () => runnerMessage(18),
      deleteMessage: (messageId) => {
        acknowledged.push(messageId);
        return new Promise<void>((resolve) => {
          finishAcknowledgement = resolve;
        });
      },
      acquireJobs: async () => [],
    });
    const result = await listener.poll(listener.initialCheckpoint(), { maxRunners: 1 });
    if (result.kind !== "message") throw new Error("expected a message result");

    const first = result.acknowledge();
    const concurrent = result.acknowledge();
    expect(acknowledged).toEqual([18]);
    finishAcknowledgement?.();

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { lastMessageId: 18, statistics },
      { lastMessageId: 18, statistics },
    ]);
    await expect(result.acknowledge()).resolves.toEqual({ lastMessageId: 18, statistics });
    expect(acknowledged).toEqual([18]);
    await expect(result.acquire([])).rejects.toThrow("message has already been acknowledged");
  });

  it("validates acquisition subsets and returns GitHub's acquired IDs", async () => {
    const acquisitions: number[][] = [];
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () =>
        runnerMessage(2, {
          jobAvailableMessages: [
            { messageType: "JobAvailable", runnerRequestId: 31 } as never,
            { messageType: "JobAvailable", runnerRequestId: 32 } as never,
          ],
        }),
      deleteMessage: async () => {},
      acquireJobs: async (requestIds) => {
        acquisitions.push(requestIds);
        return [32];
      },
    });
    const result = await listener.poll(listener.initialCheckpoint(), { maxRunners: 2 });
    if (result.kind !== "message") throw new Error("expected a message result");

    await expect(result.acquire(undefined as never)).rejects.toThrow("requestIds must be an array");
    await expect(result.acquire([31, 99])).rejects.toThrow(
      "runner request ID 99 is not available in this message",
    );
    await expect(result.acquire([31, 31])).rejects.toThrow("runner request ID 31 is duplicated");
    expect(acquisitions).toEqual([]);
    await expect(result.acquire([31, 32])).resolves.toEqual([32]);
    expect(acquisitions).toEqual([[31, 32]]);
  });

  it("prevents acknowledgement and acquisition from overtaking each other", async () => {
    let finishAcquisition: ((requestIds: number[]) => void) | undefined;
    let finishAcknowledgement: (() => void) | undefined;
    const calls: string[] = [];
    const available = { messageType: "JobAvailable", runnerRequestId: 61 } as never;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () => runnerMessage(21, { jobAvailableMessages: [available] }),
      deleteMessage: () => {
        calls.push("acknowledge");
        return new Promise<void>((resolve) => {
          finishAcknowledgement = resolve;
        });
      },
      acquireJobs: () => {
        calls.push("acquire");
        return new Promise<number[]>((resolve) => {
          finishAcquisition = resolve;
        });
      },
    });
    const result = await listener.poll(listener.initialCheckpoint(), { maxRunners: 1 });
    if (result.kind !== "message") throw new Error("expected a message result");

    const acquisition = result.acquire([61]);
    await expect(result.acknowledge()).rejects.toThrow(
      "cannot acknowledge while job acquisition is in progress",
    );
    expect(calls).toEqual(["acquire"]);

    finishAcquisition?.([61]);
    await expect(acquisition).resolves.toEqual([61]);
    const acknowledgement = result.acknowledge();
    await expect(result.acquire([61])).rejects.toThrow("message acknowledgement is in progress");
    expect(calls).toEqual(["acquire", "acknowledge"]);

    finishAcknowledgement?.();
    await expect(acknowledgement).resolves.toEqual({ lastMessageId: 21, statistics });
  });

  it("keeps a delivery usable after acquisition fails", async () => {
    const acquisitionError = new Error("acquisition unavailable");
    let acquisitionAttempts = 0;
    let acknowledgements = 0;
    const available = { messageType: "JobAvailable", runnerRequestId: 62 } as never;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () => runnerMessage(22, { jobAvailableMessages: [available] }),
      deleteMessage: async () => {
        acknowledgements += 1;
      },
      acquireJobs: async () => {
        acquisitionAttempts += 1;
        if (acquisitionAttempts === 1) throw acquisitionError;
        return [62];
      },
    });
    const saved = listener.initialCheckpoint();
    const result = await listener.poll(saved, { maxRunners: 1 });
    if (result.kind !== "message") throw new Error("expected a message result");

    await expect(result.acquire([62])).rejects.toBe(acquisitionError);
    expect(saved).toEqual({ lastMessageId: 0, statistics });
    expect(acknowledgements).toBe(0);
    await expect(result.acquire([62])).resolves.toEqual([62]);
    await expect(result.acknowledge()).resolves.toEqual({ lastMessageId: 22, statistics });
    expect({ acquisitionAttempts, acknowledgements }).toEqual({
      acquisitionAttempts: 2,
      acknowledgements: 1,
    });
  });

  it("forwards AbortSignal cancellation to the long poll", async () => {
    const controller = new AbortController();
    const aborted = new Error("poll canceled");
    const listener = resumableListener(
      (_lastMessageId, _maxCapacity, options) =>
        new Promise<RunnerScaleSetMessage | undefined>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    const polling = listener.poll(listener.initialCheckpoint(), {
      maxRunners: 1,
      signal: controller.signal,
    });
    controller.abort(aborted);

    await expect(polling).rejects.toBe(aborted);
  });

  it("rejects a pre-aborted poll before contacting the message service", async () => {
    const controller = new AbortController();
    const aborted = new Error("already canceled");
    let polls = 0;
    const listener = resumableListener(async () => {
      polls += 1;
      return undefined;
    });
    controller.abort(aborted);

    await expect(
      listener.poll(listener.initialCheckpoint(), {
        maxRunners: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
    expect(polls).toBe(0);
  });

  it("propagates polling failures without acknowledging or mutating state", async () => {
    const pollingError = new Error("message queue unavailable");
    let acknowledgements = 0;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () => {
        throw pollingError;
      },
      deleteMessage: async () => {
        acknowledgements += 1;
      },
      acquireJobs: async () => [],
    });
    const saved = { lastMessageId: 7, statistics: { ...statistics } };

    await expect(listener.poll(saved, { maxRunners: 1 })).rejects.toBe(pollingError);
    expect(saved).toEqual({ lastMessageId: 7, statistics });
    expect(acknowledgements).toBe(0);
  });

  it("forwards AbortSignal cancellation to job acquisition", async () => {
    const controller = new AbortController();
    const aborted = new Error("acquisition canceled");
    const available = { messageType: "JobAvailable", runnerRequestId: 44 } as never;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () => runnerMessage(19, { jobAvailableMessages: [available] }),
      deleteMessage: async () => {},
      acquireJobs: (_requestIds, options) =>
        new Promise<number[]>((_resolve, reject) => {
          expect(options?.signal).toBe(controller.signal);
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    });
    const result = await listener.poll(listener.initialCheckpoint(), {
      maxRunners: 1,
      signal: controller.signal,
    });
    if (result.kind !== "message") throw new Error("expected a message result");

    const acquisition = result.acquire([44]);
    controller.abort(aborted);

    await expect(acquisition).rejects.toBe(aborted);
  });

  it("rejects invalid checkpoint, delivery, and acquisition identifiers without side effects", async () => {
    let polls = 0;
    let acknowledgements = 0;
    let acquisitions = 0;
    const listener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () => {
        polls += 1;
        return runnerMessage(-1, {
          jobAvailableMessages: [{ messageType: "JobAvailable", runnerRequestId: 55 } as never],
        });
      },
      deleteMessage: async () => {
        acknowledgements += 1;
      },
      acquireJobs: async () => {
        acquisitions += 1;
        return [];
      },
    });

    await expect(
      listener.poll({ lastMessageId: -1, statistics }, { maxRunners: 1 }),
    ).rejects.toThrow("checkpoint lastMessageId must be a non-negative safe integer");
    expect(polls).toBe(0);

    await expect(listener.poll(listener.initialCheckpoint(), { maxRunners: 1 })).rejects.toThrow(
      "message ID must be a non-negative safe integer",
    );
    expect({ polls, acknowledgements, acquisitions }).toEqual({
      polls: 1,
      acknowledgements: 0,
      acquisitions: 0,
    });

    const validListener = new ResumableScaleSetListener({
      session: { sessionId: "session", statistics },
      getMessage: async () =>
        runnerMessage(20, {
          jobAvailableMessages: [{ messageType: "JobAvailable", runnerRequestId: 55 } as never],
        }),
      deleteMessage: async () => {},
      acquireJobs: async () => {
        acquisitions += 1;
        return [];
      },
    });
    const result = await validListener.poll(validListener.initialCheckpoint(), { maxRunners: 1 });
    if (result.kind !== "message") throw new Error("expected a message result");
    await expect(result.acquire([Number.NaN])).rejects.toThrow(
      "runner request IDs must be safe integers",
    );
    expect(acquisitions).toBe(0);
  });
});

describe("ScaleSetListener", () => {
  it("passes full messages to the scaler and acknowledges only after successful handling", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const message: RunnerScaleSetMessage = {
      messageId: 4,
      statistics,
      jobAvailableMessages: [{ messageType: "JobAvailable", runnerRequestId: 9 } as never],
      jobAssignedMessages: [],
      jobStartedMessages: [{ messageType: "JobStarted" } as never],
      jobCompletedMessages: [{ messageType: "JobCompleted" } as never],
    };
    const client = {
      session: { sessionId: "session", statistics },
      getMessage: async () => message,
      deleteMessage: async () => {
        calls.push("ack");
      },
      acquireJobs: async (_requestIds: number[]) => {
        calls.push("acquire");
        return [9];
      },
    };
    const listener = new ScaleSetListener(client, { scaleSetId: 1 });

    await expect(
      listener.run(
        {
          async scale(received) {
            if (received?.messageId === INITIAL_MESSAGE_ID) {
              calls.push("initial");
              expect(received.statistics).toEqual(statistics);
              return;
            }
            expect(received).toBe(message);
            if (!received) throw new Error("expected a message");
            calls.push("scale");
            await client.acquireJobs(
              received.jobAvailableMessages.map((job) => job.runnerRequestId),
            );
            for (const _job of received.jobStartedMessages) calls.push("started");
            for (const _job of received.jobCompletedMessages) calls.push("completed");
            calls.push("desired");
            controller.abort(new Error("done"));
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("done");

    expect(calls).toEqual([
      "initial",
      "scale",
      "acquire",
      "started",
      "completed",
      "desired",
      "ack",
    ]);
  });

  it("passes an empty poll to the scaler without caching prior statistics", async () => {
    const controller = new AbortController();
    const polls: Array<{ lastMessageId: number; maxCapacity: number }> = [];
    const received: Array<number | undefined> = [];
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async (lastMessageId, maxCapacity) => {
          polls.push({ lastMessageId, maxCapacity });
          return undefined;
        },
        deleteMessage: async () => {},
        acquireJobs: async () => [],
      },
      { scaleSetId: 1, maxRunners: 5 },
    );

    await expect(
      listener.run(
        {
          scale(message) {
            received.push(message?.messageId);
            if (!message) controller.abort(new Error("done"));
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("done");

    expect(polls).toEqual([{ lastMessageId: 0, maxCapacity: 5 }]);
    expect(received).toEqual([INITIAL_MESSAGE_ID, undefined]);
  });

  it("acknowledges a handled message after caller cancellation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const message: RunnerScaleSetMessage = {
      messageId: 8,
      statistics,
      jobAvailableMessages: [{ messageType: "JobAvailable", runnerRequestId: 12 } as never],
      jobAssignedMessages: [],
      jobStartedMessages: [],
      jobCompletedMessages: [],
    };
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async () => {
          controller.abort(new Error("shutdown"));
          return message;
        },
        deleteMessage: async () => {
          calls.push("ack");
        },
        acquireJobs: async () => [12],
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run(
        {
          scale(received, options) {
            expect(options?.signal).toBe(controller.signal);
            if (received?.messageId === message.messageId) calls.push("scale");
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("shutdown");

    expect(calls).toEqual(["scale", "ack"]);
  });

  it("does not acknowledge a message when scaling fails", async () => {
    const scaleError = new Error("scale failed");
    let acknowledgements = 0;
    const message: RunnerScaleSetMessage = {
      messageId: 11,
      statistics,
      jobAvailableMessages: [],
      jobAssignedMessages: [],
      jobStartedMessages: [],
      jobCompletedMessages: [],
    };
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async () => message,
        deleteMessage: async () => {
          acknowledgements += 1;
        },
        acquireJobs: async () => [],
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run({
        scale(received) {
          if (received?.messageId === message.messageId) throw scaleError;
        },
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof Error && error.cause === scaleError);
    expect(acknowledgements).toBe(0);
  });

  it("does not poll or acknowledge when the initial statistics handler fails", async () => {
    const initialError = new Error("initial reconciliation failed");
    let polls = 0;
    let acknowledgements = 0;
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async () => {
          polls += 1;
          return undefined;
        },
        deleteMessage: async () => {
          acknowledgements += 1;
        },
        acquireJobs: async () => [],
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run({
        scale(message) {
          expect(message?.messageId).toBe(INITIAL_MESSAGE_ID);
          throw initialError;
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message === "failed to handle initial session statistics" &&
        error.cause === initialError,
    );
    expect({ polls, acknowledgements }).toEqual({ polls: 0, acknowledgements: 0 });
  });

  it("reports acknowledgment failures after handling without polling again", async () => {
    const acknowledgeError = new Error("queue unavailable");
    const received = runnerMessage(17);
    let polls = 0;
    let handled = 0;
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async () => {
          polls += 1;
          return received;
        },
        deleteMessage: async () => {
          throw acknowledgeError;
        },
        acquireJobs: async () => [],
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run({
        scale(message) {
          if (message?.messageId === received.messageId) handled += 1;
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message === "failed to delete the message 17" &&
        error.cause === acknowledgeError,
    );
    expect({ polls, handled }).toEqual({ polls: 1, handled: 1 });
  });

  it("advances the polling cursor only after each handled message", async () => {
    const stopped = new Error("done");
    const controller = new AbortController();
    const messages = [runnerMessage(3), runnerMessage(7)];
    const cursors: number[] = [];
    const handled: number[] = [];
    const acknowledged: number[] = [];
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async (lastMessageId) => {
          cursors.push(lastMessageId);
          const next = messages.shift();
          if (next) return next;
          controller.abort(stopped);
          throw stopped;
        },
        deleteMessage: async (messageId) => {
          acknowledged.push(messageId);
        },
        acquireJobs: async () => [],
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run(
        {
          scale(message) {
            if (message && message.messageId !== INITIAL_MESSAGE_ID) {
              handled.push(message.messageId);
            }
          },
        },
        controller.signal,
      ),
    ).rejects.toBe(stopped);
    expect(cursors).toEqual([0, 3, 7]);
    expect(handled).toEqual([3, 7]);
    expect(acknowledged).toEqual([3, 7]);
  });

  it("stops before handling or acknowledging an out-of-order delivery", async () => {
    const messages = [runnerMessage(5), runnerMessage(4)];
    const handled: number[] = [];
    const acknowledged: number[] = [];
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async () => messages.shift(),
        deleteMessage: async (messageId) => {
          acknowledged.push(messageId);
        },
        acquireJobs: async () => [],
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run({
        scale(message) {
          if (message && message.messageId !== INITIAL_MESSAGE_ID) handled.push(message.messageId);
        },
      }),
    ).rejects.toThrow("message ID 4 is older than checkpoint 5");
    expect(handled).toEqual([5]);
    expect(acknowledged).toEqual([5]);
  });
});

function runnerMessage(
  messageId: number,
  overrides: Partial<RunnerScaleSetMessage> = {},
): RunnerScaleSetMessage {
  return {
    messageId,
    statistics,
    jobAvailableMessages: [],
    jobAssignedMessages: [],
    jobStartedMessages: [],
    jobCompletedMessages: [],
    ...overrides,
  };
}

function resumableListener(getMessage: ListenerClient["getMessage"]): ResumableScaleSetListener {
  return new ResumableScaleSetListener({
    session: { sessionId: "session", statistics },
    getMessage,
    deleteMessage: async () => {},
    acquireJobs: async () => [],
  });
}
