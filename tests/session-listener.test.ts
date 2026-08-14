import { describe, expect, it } from "vite-plus/test";
import {
  MessageSessionClient,
  ScaleSetListener,
  parseRunnerScaleSetMessage,
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
        { messageType: "JobStarted", runnerRequestId: 2 },
        { messageType: "JobCompleted", runnerRequestId: 3 },
        { messageType: "Unknown" },
      ]),
    });

    expect(parsed.jobAvailableMessages).toHaveLength(1);
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
});

describe("ScaleSetListener", () => {
  it("preserves upstream acknowledge, acquire, lifecycle, and desired-count order", async () => {
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
    const listener = new ScaleSetListener(
      {
        session: { sessionId: "session", statistics },
        getMessage: async () => message,
        deleteMessage: async () => {
          calls.push("ack");
        },
        acquireJobs: async () => {
          calls.push("acquire");
          return [9];
        },
      },
      { scaleSetId: 1, metricsRecorder: metrics(calls) },
    );

    await expect(
      listener.run(
        {
          handleJobStarted: () => {
            calls.push("started");
          },
          handleJobCompleted: () => {
            calls.push("completed");
          },
          handleDesiredRunnerCount: () => {
            calls.push("desired");
            if (calls.filter((call) => call === "desired").length === 2)
              controller.abort(new Error("done"));
            return 2;
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("done");

    expect(calls).toEqual([
      "statistics",
      "desired",
      "desired-metric",
      "statistics",
      "ack",
      "acquire",
      "started-metric",
      "started",
      "completed-metric",
      "completed",
      "desired",
      "desired-metric",
    ]);
  });

  it("refreshes desired capacity after an empty poll", async () => {
    const controller = new AbortController();
    const polls: Array<{ lastMessageId: number; maxCapacity: number }> = [];
    let desiredCalls = 0;
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
          handleJobStarted() {},
          handleJobCompleted() {},
          handleDesiredRunnerCount(count) {
            desiredCalls += 1;
            if (desiredCalls === 2) controller.abort(new Error("done"));
            return count;
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("done");

    expect(polls).toEqual([{ lastMessageId: 0, maxCapacity: 5 }]);
  });

  it("acknowledges and acquires a received message after caller cancellation", async () => {
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
        acquireJobs: async () => {
          calls.push("acquire");
          return [12];
        },
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run(
        {
          handleJobStarted() {},
          handleJobCompleted() {},
          handleDesiredRunnerCount: () => statistics.totalAssignedJobs,
        },
        controller.signal,
      ),
    ).rejects.toThrow("shutdown");

    expect(calls).toEqual(["ack", "acquire"]);
  });
});

function metrics(calls: string[]) {
  return {
    recordStatistics: () => calls.push("statistics"),
    recordJobStarted: () => calls.push("started-metric"),
    recordJobCompleted: () => calls.push("completed-metric"),
    recordDesiredRunners: () => calls.push("desired-metric"),
  };
}
