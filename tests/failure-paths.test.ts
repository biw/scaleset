import { describe, expect, it } from "vitest";
import {
  MessageSessionClient,
  RequestError,
  isScaleSetError,
  messageQueueTokenExpiredError,
} from "../src/index.js";
import { requestError } from "../src/errors.js";
import { send } from "../src/internal.js";

describe("request errors", () => {
  it("preserves a typed cause, response body, and request diagnostics", async () => {
    const cause = messageQueueTokenExpiredError();
    const error = await requestError(
      new Request("https://queue.example/messages/7", { method: "DELETE" }),
      new Response("expired queue token", {
        status: 401,
        headers: {
          ActivityId: "activity-1",
          "X-GitHub-Request-Id": "request-1",
        },
      }),
      cause,
    );

    expect(error).toMatchObject({
      code: "MESSAGE_QUEUE_TOKEN_EXPIRED",
      status: 401,
      httpStatusCode: "UNAUTHORIZED",
      activityId: "activity-1",
      githubRequestId: "request-1",
      responseBody: "expired queue token",
      cause,
    });
    expect(isScaleSetError(error, "MESSAGE_QUEUE_TOKEN_EXPIRED")).toBe(true);
  });

  it("maps job-running exceptions and retains malformed or incomplete JSON", async () => {
    const request = new Request("https://actions.example/jobs/1");
    const running = await requestError(
      request,
      json({ typeName: "JobStillRunningException", message: "job is active" }, 409),
      new Error("base"),
    );
    expect(isScaleSetError(running, "JOB_STILL_RUNNING")).toBe(true);
    expect(running.responseBody).toContain("JobStillRunningException");

    const incompleteBody = JSON.stringify({ detail: "no Actions exception fields" });
    const incomplete = await requestError(
      request,
      new Response(incompleteBody, {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      new Error("base"),
    );
    expect(incomplete.responseBody).toBe(incompleteBody);
    expect(incomplete.message).toContain(incompleteBody);

    const malformed = await requestError(
      request,
      new Response("{not-json", {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
      new Error("base"),
    );
    expect(malformed.responseBody).toBe("{not-json");
    expect(malformed.message).toContain("failed to parse error response body");
  });
});

describe("request retries", () => {
  it("aborts during the default retry backoff without sending another request", async () => {
    const controller = new AbortController();
    const canceled = new Error("shutdown during backoff");
    let requests = 0;

    const result = send(
      new Request("https://actions.example/transient", { signal: controller.signal }),
      {
        retry: { maxRetries: 1, minDelayMs: 60_000, maxDelayMs: 60_000 },
        fetch: async () => {
          requests += 1;
          setTimeout(() => controller.abort(canceled), 0);
          return new Response("unavailable", { status: 503 });
        },
      },
    );

    await expect(result).rejects.toSatisfy(
      (error: unknown) => error instanceof RequestError && error.cause === canceled,
    );
    expect(requests).toBe(1);
  });

  it("handles HTTP-date and malformed Retry-After values deterministically", async () => {
    const waits: number[] = [];
    let requests = 0;
    await expect(
      send(new Request("https://actions.example/rate-limited"), {
        retry: { maxRetries: 1, minDelayMs: 100, maxDelayMs: 1_000, random: () => 0 },
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
        fetch: async () => {
          requests += 1;
          return requests === 1
            ? new Response(null, {
                status: 429,
                headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" },
              })
            : new Response(null, { status: 204 });
        },
      }),
    ).resolves.toMatchObject({ status: 204 });
    expect(waits).toEqual([0]);

    waits.length = 0;
    requests = 0;
    await expect(
      send(new Request("https://actions.example/rate-limited"), {
        retry: {
          maxRetries: 1,
          minDelayMs: 100,
          maxDelayMs: 1_000,
          random: () => Number.NaN,
        },
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
        fetch: async () => {
          requests += 1;
          return requests === 1
            ? new Response(null, { status: 503, headers: { "Retry-After": "eventually" } })
            : new Response(null, { status: 204 });
        },
      }),
    ).resolves.toMatchObject({ status: 204 });
    expect(waits).toEqual([100]);
  });
});

describe("message session failures", () => {
  it("closes the session with the caller signal and exposes its owner", async () => {
    const calls: unknown[][] = [];
    const controller = new AbortController();
    const client = {
      systemInfo: systemInfo(),
      _transportOptions: {},
      _actionsRequest: async (...arguments_: unknown[]) => {
        calls.push(arguments_);
        return new Response(null, { status: 204 });
      },
    } as never;
    const session = new MessageSessionClient(client, 3, "octo-org", queueSession());

    expect(session.owner).toBe("octo-org");
    await expect(session.close({ signal: controller.signal })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual([
      "DELETE",
      "/_apis/runtime/runnerscalesets/3/sessions/session",
      undefined,
      [204],
    ]);
    expect(calls[0]?.[4]).toBe(controller.signal);
  });

  it("surfaces non-authentication queue failures without refreshing the session", async () => {
    let refreshes = 0;
    const client = {
      systemInfo: systemInfo(),
      _transportOptions: {
        retry: { maxRetries: 0 },
        fetch: async () =>
          new Response("queue unavailable", {
            status: 418,
            headers: { "content-type": "text/plain" },
          }),
      },
      _actionsRequest: async () => {
        refreshes += 1;
        return json(queueSession());
      },
    } as never;
    const session = new MessageSessionClient(client, 3, "owner", queueSession());

    await expect(session.getMessage(0, 1)).rejects.toMatchObject({
      status: 418,
      responseBody: "queue unavailable",
    });
    await expect(session.deleteMessage(7)).rejects.toMatchObject({
      status: 418,
      responseBody: "queue unavailable",
    });
    expect(refreshes).toBe(0);
  });

  it("rejects malformed acquired IDs and incomplete session credentials", async () => {
    const malformedClient = {
      systemInfo: systemInfo(),
      _transportOptions: {},
      _actionsRequest: async () => json({ value: [1, "not-a-number"] }),
    } as never;
    const malformed = new MessageSessionClient(malformedClient, 3, "owner", queueSession());
    await expect(malformed.acquireJobs([1])).rejects.toThrow("failed to decode acquired job IDs");

    const unusedClient = {
      systemInfo: systemInfo(),
      _transportOptions: {
        fetch: async () => {
          throw new Error("request should not be sent");
        },
      },
      _actionsRequest: async () => {
        throw new Error("request should not be sent");
      },
    } as never;
    await expect(
      new MessageSessionClient(unusedClient, 3, "owner", {
        ...queueSession(),
        messageQueueUrl: undefined,
      }).getMessage(0, 1),
    ).rejects.toThrow("message session is missing a message queue URL");
    await expect(
      new MessageSessionClient(unusedClient, 3, "owner", {
        ...queueSession(),
        messageQueueAccessToken: undefined,
      }).getMessage(0, 1),
    ).rejects.toThrow("message session is missing a queue access token");
    await expect(
      new MessageSessionClient(unusedClient, 3, "owner", {
        ...queueSession(),
        sessionId: undefined,
      }).close(),
    ).rejects.toThrow("message session is missing a session ID");
  });
});

function queueSession() {
  return {
    sessionId: "session",
    messageQueueUrl: "https://queue.example/messages",
    messageQueueAccessToken: "queue-token",
  };
}

function systemInfo() {
  return { system: "test", version: "1", commitSha: "", scaleSetId: 3, subsystem: "test" };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
