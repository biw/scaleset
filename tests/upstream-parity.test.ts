import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import {
  MessageSessionClient,
  RequestError,
  ScaleSetClient,
  ScaleSetListener,
  isScaleSetError,
  personalAccessToken,
  type FetchLike,
  type RunnerScaleSetMessage,
  type RunnerScaleSetStatistic,
} from "../src/index.js";
import { requestError } from "../src/errors.js";
import { githubApiUrl, parseGitHubConfig } from "../src/internal.js";
import { createNodeFetch, readTlsClientCertificate } from "../src/node.js";

const adminToken = `header.${Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
).toString("base64url")}.signature`;
const execFileAsync = promisify(execFile);
const runScaleSetE2e = process.env.RUN_SCALESET_E2E === "true";
const readTlsCertificate = "<test-certificate>";

const statistics: RunnerScaleSetStatistic = {
  totalAvailableJobs: 0,
  totalAcquiredJobs: 0,
  totalAssignedJobs: 2,
  totalRunningJobs: 0,
  totalRegisteredRunners: 0,
  totalBusyRunners: 0,
  totalIdleRunners: 0,
};

describe("actions/scaleset cb0405b parity", () => {
  it("client_test.go › TestNewGitHubAPIRequest", () => {
    const cases = [
      ["https://github.com/org/repo", "https://api.github.com/app/installations/123/access_tokens"],
      [
        "https://www.github.com/org/repo",
        "https://api.github.com/app/installations/123/access_tokens",
      ],
      [
        "http://github.localhost/org/repo",
        "http://api.github.localhost/app/installations/123/access_tokens",
      ],
      [
        "https://my-instance.com/org/repo",
        "https://my-instance.com/api/v3/app/installations/123/access_tokens",
      ],
    ] as const;

    for (const [configUrl, expected] of cases) {
      expect(
        githubApiUrl(
          parseGitHubConfig(configUrl),
          "/app/installations/123/access_tokens",
        ).toString(),
      ).toBe(expected);
    }
  });

  it("client_test.go › TestNewActionsServiceRequest", async () => {
    const { client, actionRequests } = actionsClient(() => json({ id: 1, name: "runner" }));

    await client.getRunner(1);

    expect(actionRequests).toHaveLength(1);
    expect(actionRequests[0]!.headers.get("authorization")).toBe(`Bearer ${adminToken}`);
    expect(actionRequests[0]!.headers.get("content-type")).toBe("application/json");
    expect(new URL(actionRequests[0]!.url).searchParams.get("api-version")).toBe("6.0-preview");
  });

  it("client_test.go › TestGetRunner", async () => {
    const { client } = actionsClient(() => json({ id: 7, name: "runner" }));
    await expect(client.getRunner(7)).resolves.toEqual({ id: 7, name: "runner" });
  });

  it("client_test.go › TestGetRunnerByName", async () => {
    const { client, actionRequests } = actionsClient(() =>
      json({ count: 1, value: [{ id: 7, name: "runner" }] }),
    );

    await expect(client.getRunnerByName("runner")).resolves.toEqual({ id: 7, name: "runner" });
    expect(new URL(actionRequests[0]!.url).searchParams.get("agentName")).toBe("runner");
  });

  it("client_test.go › TestDeleteRunner", async () => {
    const { client, actionRequests } = actionsClient(() => new Response(null, { status: 204 }));
    await expect(client.removeRunner(7)).resolves.toBeUndefined();
    expect(actionRequests[0]!.method).toBe("DELETE");
    expect(new URL(actionRequests[0]!.url).pathname).toContain("/agents/7");
  });

  it("client_test.go › TestGetRunnerGroupByName", async () => {
    const { client, actionRequests } = actionsClient(() =>
      json({ count: 1, value: [{ id: 3, name: "group", size: 1, isDefaultGroup: false }] }),
    );
    await expect(client.getRunnerGroupByName("group")).resolves.toMatchObject({ id: 3 });
    expect(new URL(actionRequests[0]!.url).searchParams.get("groupName")).toBe("group");
  });

  it("client_test.go › TestGetRunnerScaleSet", async () => {
    const { client, actionRequests } = actionsClient(() =>
      json({ count: 1, value: [{ id: 3, name: "scale" }] }),
    );
    await expect(client.getRunnerScaleSet(2, "scale")).resolves.toMatchObject({ id: 3 });
    const url = new URL(actionRequests[0]!.url);
    expect(url.searchParams.get("runnerGroupId")).toBe("2");
    expect(url.searchParams.get("name")).toBe("scale");
  });

  it("client_test.go › TestListRunnerScaleSets", async () => {
    const { client, actionRequests } = actionsClient(() =>
      json({
        count: 2,
        value: [
          { id: 3, name: "alpha" },
          { id: 4, name: "beta" },
        ],
      }),
    );
    await expect(client.listRunnerScaleSets(2)).resolves.toEqual([
      { id: 3, name: "alpha" },
      { id: 4, name: "beta" },
    ]);
    const url = new URL(actionRequests[0]!.url);
    expect(url.searchParams.get("runnerGroupId")).toBe("2");
    expect(url.searchParams.has("name")).toBe(false);
  });

  it("client_test.go › TestGetRunnerScaleSetByID", async () => {
    const { client, actionRequests } = actionsClient(() => json({ id: 3, name: "scale" }));
    await expect(client.getRunnerScaleSetById(3)).resolves.toMatchObject({ id: 3 });
    expect(new URL(actionRequests[0]!.url).pathname).toContain("/runnerscalesets/3");
  });

  it("client_test.go › TestCreateRunnerScaleSet", async () => {
    const { client, actionRequests } = actionsClient(() => json({ id: 3, name: "scale" }));
    await expect(client.createRunnerScaleSet({ name: "scale" })).resolves.toMatchObject({ id: 3 });
    expect(actionRequests[0]!.method).toBe("POST");
    await expect(actionRequests[0]!.text()).resolves.toBe(
      '{"name":"scale","labels":[{"name":"scale","type":"System"}],"RunnerSetting":{},"createdOn":"0001-01-01T00:00:00Z"}',
    );
  });

  it("client_test.go › TestUpdateRunnerScaleSet", async () => {
    const { client, actionRequests } = actionsClient(() => json({ id: 3, name: "scale" }));
    await expect(client.updateRunnerScaleSet(3, { name: "scale" })).resolves.toMatchObject({
      id: 3,
    });
    expect(actionRequests[0]!.method).toBe("PATCH");
    expect(new URL(actionRequests[0]!.url).pathname).toContain("/runnerscalesets/3");
  });

  it("client_test.go › TestDeleteRunnerScaleSet", async () => {
    const { client, actionRequests } = actionsClient(() => new Response(null, { status: 204 }));
    await expect(client.deleteRunnerScaleSet(3)).resolves.toBeUndefined();
    expect(actionRequests[0]!.method).toBe("DELETE");
    expect(new URL(actionRequests[0]!.url).pathname).toContain("/runnerscalesets/3");
  });

  it("client_test.go › TestGenerateJitRunnerConfig", async () => {
    const { client, actionRequests } = actionsClient(() =>
      json({ encodedJITConfig: "jit", runner: { id: 3, name: "runner" } }),
    );
    await expect(
      client.generateJitRunnerConfig({ name: "runner", workFolder: "_work" }, 3),
    ).resolves.toMatchObject({ encodedJITConfig: "jit" });
    expect(new URL(actionRequests[0]!.url).pathname).toContain(
      "/runnerscalesets/3/generatejitconfig",
    );
  });

  for (const [name, options, shouldSucceed] of [
    ["client without ca certs", undefined, false],
    ["client with ca certs", { ca: readTlsCertificate }, true],
    ["client with ca chain certs", { ca: [readTlsCertificate] }, true],
    ["client skipping tls verification", { rejectUnauthorized: false }, true],
  ] as const) {
    it(`client_test.go › TestServerWithSelfSignedCertificates › ${name}`, async () => {
      const { server, url } = await tlsServer();
      const nodeFetch = options
        ? createNodeFetch(await resolveNodeFetchOptions(options))
        : undefined;
      try {
        const request = nodeFetch ?? fetch;
        if (shouldSucceed) await expect(request(url)).resolves.toMatchObject({ status: 200 });
        else await expect(request(url)).rejects.toThrow();
      } finally {
        await nodeFetch?.close();
        await close(server);
      }
    });
  }

  it("common_client_test.go › TestClient_Do", async () => {
    const { client } = actionsClient(
      () =>
        new Response('\uFEFF{"id":7,"name":"runner"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.getRunner(7)).resolves.toEqual({ id: 7, name: "runner" });
  });

  it("common_client_test.go › TestClientProxy", async () => {
    let requests = 0;
    const proxy = createHttpServer((_request, response) => {
      requests += 1;
      response.end("proxied");
    });
    proxy.on("connect", (_request, socket) => {
      requests += 1;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nproxied");
      });
    });
    await listen(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("proxy test server did not bind a port");

    try {
      const response = await createNodeFetch({ proxyUrl: `http://127.0.0.1:${address.port}` })(
        "http://example.invalid/runner",
      );
      expect(await response.text()).toBe("proxied");
      expect(requests).toBe(1);
    } finally {
      await close(proxy);
    }
  });

  it("common_client_test.go › TestUserAgent", () => {
    const { client } = actionsClient(() => json({ id: 1, name: "runner" }));
    expect(JSON.parse(client.debugInfo().systemInfo)).toMatchObject({
      system: "scaleset",
      kind: "scaleset",
    });
    client.setSystemInfo({
      system: "controller",
      version: "1",
      commitSha: "sha",
      scaleSetId: 2,
      subsystem: "test",
    });
    expect(JSON.parse(client.debugInfo().systemInfo)).toMatchObject({
      system: "controller",
      scale_set_id: 2,
    });
  });

  it("common_client_test.go › TestWithLogger", async () => {
    const messages: string[] = [];
    const { client } = actionsClient(() => json({ id: 1, name: "runner" }), {
      logger: { info: (message) => messages.push(message) },
    });
    await client.getRunner(1);
    expect(messages).toContain("refreshing Actions service token");
  });

  it("common_client_test.go › TestWithRetryableHTTPClient", async () => {
    let attempts = 0;
    const { client } = actionsClient(
      () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 503 })
          : json({ id: 1, name: "runner" });
      },
      { retry: { maxRetries: 1, maxDelayMs: 0 }, sleep: async () => {} },
    );
    await expect(client.getRunner(1)).resolves.toMatchObject({ id: 1 });
    expect(attempts).toBe(2);
  });

  it("config_test.go › TestGitHubConfig", () => {
    expect(parseGitHubConfig("https://github.com/org/repo")).toMatchObject({
      scope: "repository",
      organization: "org",
      repository: "repo",
      isHosted: true,
    });
    expect(parseGitHubConfig("https://github.com/enterprises/enterprise")).toMatchObject({
      scope: "enterprise",
      enterprise: "enterprise",
    });
    expect(() => parseGitHubConfig("https://github.com/")).toThrow("invalid GitHub config URL");
  });

  it("trims boundary slashes without pathological regular-expression backtracking", () => {
    expect(parseGitHubConfig(`///https://github.com/org${"/".repeat(128 * 1024)}`)).toMatchObject({
      scope: "organization",
      organization: "org",
    });
  });

  it("config_test.go › TestGitHubConfig_GitHubAPIURL", () => {
    expect(githubApiUrl(parseGitHubConfig("https://github.com/org"), "/some/path").toString()).toBe(
      "https://api.github.com/some/path",
    );
    expect(
      githubApiUrl(parseGitHubConfig("https://ghes.example/org"), "/some/path").toString(),
    ).toBe("https://ghes.example/api/v3/some/path");
    expect(
      githubApiUrl(parseGitHubConfig("https://test.ghe.com/org", true), "/some/path").toString(),
    ).toBe("https://test.ghe.com/api/v3/some/path");
  });

  it("errors_test.go › TestActionsExceptionError", async () => {
    const error = await requestError(
      new Request("https://example.invalid"),
      json({ typeName: "AgentExistsException", message: "runner already exists" }, 409),
      new Error("base"),
    );
    expect(isScaleSetError(error, "RUNNER_EXISTS")).toBe(true);
    expect(error.message).toContain("runner already exists");
  });

  it("errors_test.go › TestNewRequestResponseError", async () => {
    const request = new Request("https://example.invalid/org/repo");
    const error = await requestError(
      request,
      new Response("plain error", {
        status: 400,
        statusText: "Bad Request",
        headers: {
          "content-type": "text/plain",
          ActivityId: "activity",
          "X-GitHub-Request-Id": "request",
        },
      }),
      new Error("base"),
    );
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({
      status: 400,
      activityId: "activity",
      githubRequestId: "request",
    });
    expect(error.message).toContain("plain error");

    const conflict = await requestError(
      request,
      json({ typeName: "AgentExistsException", message: "exists" }, 409),
      new Error("base"),
    );
    expect(isScaleSetError(conflict, "RUNNER_EXISTS")).toBe(true);
    expect(isScaleSetError(conflict, "CONFLICT")).toBe(true);

    for (const [status, code] of [
      [400, "BAD_REQUEST"],
      [401, "UNAUTHORIZED"],
      [404, "NOT_FOUND"],
    ] as const) {
      const statusError = await requestError(
        request,
        new Response("", { status }),
        new Error("base"),
      );
      expect(isScaleSetError(statusError, code)).toBe(true);
    }
  });

  it("common_client_test.go › TestWithTLSClientCertificate", async () => {
    const directory = resolve(import.meta.dirname, "fixtures");
    const [key, cert] = await Promise.all([
      readFile(resolve(directory, "tls-key.pem")),
      readFile(resolve(directory, "tls-cert.pem")),
    ]);
    const server = createHttpsServer(
      { key, cert, ca: cert, requestCert: true, rejectUnauthorized: true },
      (_request, response) => response.end("mtls"),
    );
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("mTLS test server did not bind a port");
    const nodeFetch = createNodeFetch({
      ca: cert.toString(),
      ...(await readTlsClientCertificate(
        resolve(directory, "tls-cert.pem"),
        resolve(directory, "tls-key.pem"),
      )),
    });
    try {
      await expect(nodeFetch(`https://127.0.0.1:${address.port}`)).resolves.toMatchObject({
        status: 200,
      });
      expect(() => createNodeFetch({ clientCertificate: cert.toString() })).toThrow(
        "clientCertificate and clientKey must be provided together",
      );
      const additionalCertificate = createNodeFetch({
        ca: cert.toString(),
        clientCertificate: [cert.toString(), cert.toString()],
        clientKey: [key.toString(), key.toString()],
      });
      await additionalCertificate.close();
      await expect(
        readTlsClientCertificate(
          resolve(directory, "missing.pem"),
          resolve(directory, "tls-key.pem"),
        ),
      ).rejects.toThrow();
    } finally {
      await nodeFetch.close();
      await close(server);
    }
  });

  it("session_client_test.go › TestCreateMessageSession", async () => {
    const session = { sessionId: "session", ownerName: "owner", statistics };
    const { client, actionRequests } = actionsClient((request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toContain("/runnerscalesets/3/sessions");
      return json(session);
    });
    await expect(client.createMessageSession(3, "owner")).resolves.toMatchObject({ session });
    await expect(actionRequests[0]!.text()).resolves.toBe(
      '{"sessionId":"00000000-0000-0000-0000-000000000000","ownerName":"owner"}',
    );
  });

  it("session_client_test.go › TestGetMessage", async () => {
    const requests: Request[] = [];
    const session = new MessageSessionClient(
      queueClient(requests, () => json({ messageId: 4, messageType: "RunnerScaleSetJobMessages" })),
      3,
      "owner",
      queueSession(),
    );
    await expect(session.getMessage(3, 8)).resolves.toMatchObject({ messageId: 4 });
    const request = requests[0]!;
    expect(new URL(request.url).searchParams.get("lastMessageId")).toBe("3");
    expect(request.headers.get("x-scalesetmaxcapacity")).toBe("8");
  });

  it("session_client_test.go › TestGetMessage › Concurrent expired token refreshes once", async () => {
    let refreshes = 0;
    let queueCalls = 0;
    const client = {
      systemInfo: systemInfo(),
      _transportOptions: {
        fetch: async () => {
          queueCalls += 1;
          return queueCalls <= 2
            ? new Response(null, { status: 401 })
            : new Response(null, { status: 202 });
        },
      },
      _actionsRequest: async () => {
        refreshes += 1;
        return json({ ...queueSession(), messageQueueAccessToken: "fresh-token" });
      },
    } as never;
    const session = new MessageSessionClient(client, 3, "owner", queueSession());
    await expect(
      Promise.all([session.getMessage(0, 1), session.getMessage(0, 1)]),
    ).resolves.toEqual([undefined, undefined]);
    expect(refreshes).toBe(1);
  });

  it("session_client_test.go › TestDeleteMessage", async () => {
    const requests: Request[] = [];
    const session = new MessageSessionClient(
      queueClient(requests, () => new Response(null, { status: 204 })),
      3,
      "owner",
      queueSession(),
    );
    await expect(session.deleteMessage(4)).resolves.toBeUndefined();
    expect(requests[0]!.method).toBe("DELETE");
    expect(new URL(requests[0]!.url).pathname).toBe("/messages/4");
  });

  it("session_client_test.go › TestAcquireJobs", async () => {
    const calls: Array<{ body: unknown; headers: Record<string, string> }> = [];
    const client = {
      systemInfo: systemInfo(),
      _transportOptions: {},
      _actionsRequest: async (
        _method: string,
        _path: string,
        body: unknown,
        _statuses: number[],
        _signal: AbortSignal | undefined,
        _retry: unknown,
        headers: Record<string, string>,
      ) => {
        calls.push({ body, headers });
        return json({ value: [1, 2] });
      },
    } as never;
    const session = new MessageSessionClient(client, 3, "owner", queueSession());
    await expect(session.acquireJobs([1, 2])).resolves.toEqual([1, 2]);
    expect(calls).toEqual([{ body: [1, 2], headers: { Authorization: "Bearer queue-token" } }]);
  });

  it("listener/listener_test.go › TestNew", () => {
    const client = listenerClient();
    expect(() => new ScaleSetListener(client, { scaleSetId: 0 })).toThrow("scaleSetId is required");
    expect(() => new ScaleSetListener(client, { scaleSetId: 1, maxRunners: -1 })).toThrow(
      "maxRunners",
    );
    expect(new ScaleSetListener(client, { scaleSetId: 1, maxRunners: 5 })).toMatchObject({
      scaleSetId: 1,
      maxRunners: 5,
    });
  });

  it("listener/listener_test.go › TestListener_Run", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const message: RunnerScaleSetMessage = {
      messageId: 4,
      statistics,
      jobAvailableMessages: [{ messageType: "JobAvailable", runnerRequestId: 9 } as never],
      jobAssignedMessages: [],
      jobStartedMessages: [],
      jobCompletedMessages: [],
    };
    const listener = new ScaleSetListener(
      {
        ...listenerClient(),
        getMessage: async () => message,
        deleteMessage: async () => {
          calls.push("ack");
        },
        acquireJobs: async () => {
          calls.push("acquire");
          return [9];
        },
      },
      { scaleSetId: 1 },
    );

    await expect(
      listener.run(
        {
          handleJobStarted() {},
          handleJobCompleted() {},
          handleDesiredRunnerCount() {
            if (calls.length > 0) controller.abort(new Error("done"));
            return statistics.totalAssignedJobs;
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("done");
    expect(calls).toEqual(["ack", "acquire"]);
  });

  it.runIf(runScaleSetE2e)(
    "examples/dockerscaleset/e2e_test.go › TestE2E — runs against the private GitHub scale-set environment in CI",
    async () => {
      try {
        await execFileAsync(
          "go",
          ["test", "./examples/dockerscaleset", "-run", "^TestE2E$", "-count=1"],
          {
            cwd: resolve(process.cwd(), "actions-scaleset"),
            env: { ...process.env, E2E: "true" },
            timeout: 13 * 60_000,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
      } catch (error) {
        const processError = error as Error & { stderr?: string; stdout?: string };
        const output = [processError.stdout, processError.stderr].filter(Boolean).join("\n");
        throw new Error(`Pinned upstream Docker E2E failed:\n${output || processError.message}`, {
          cause: error,
        });
      }
    },
    14 * 60_000,
  );
});

function actionsClient(
  handler: (request: Request) => Response | Promise<Response>,
  options: Omit<
    ConstructorParameters<typeof ScaleSetClient>[0],
    "githubConfigUrl" | "credential" | "fetch"
  > = {},
): { actionRequests: Request[]; client: ScaleSetClient } {
  const actionRequests: Request[] = [];
  const fetch: FetchLike = async (input) => {
    const request = new Request(input);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/registration-token")) return json({ token: "registration" }, 201);
    if (path.endsWith("/actions/runner-registration")) {
      return json({ url: "https://actions.example/tenant/123/", token: adminToken }, 201);
    }
    actionRequests.push(request);
    return handler(request);
  };
  return {
    actionRequests,
    client: new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: personalAccessToken("pat"),
      fetch,
      ...options,
    }),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queueSession() {
  return {
    sessionId: "session",
    messageQueueUrl: "https://queue.example/messages",
    messageQueueAccessToken: "queue-token",
  };
}

function queueClient(requests: Request[], respond: (request: Request) => Response) {
  return {
    systemInfo: systemInfo(),
    _transportOptions: {
      fetch: async (input: RequestInfo | URL) => {
        const request = new Request(input);
        requests.push(request);
        return respond(request);
      },
    },
    _actionsRequest: async () => json(queueSession()),
  } as never;
}

function listenerClient() {
  return {
    session: { sessionId: "session", statistics },
    getMessage: async () => undefined,
    deleteMessage: async () => {},
    acquireJobs: async () => [],
  };
}

function systemInfo() {
  return { system: "test", version: "1", commitSha: "", scaleSetId: 1, subsystem: "test" };
}

async function tlsServer(): Promise<{ server: ReturnType<typeof createHttpsServer>; url: string }> {
  const directory = resolve(import.meta.dirname, "fixtures");
  const [key, cert] = await Promise.all([
    readFile(resolve(directory, "tls-key.pem")),
    readFile(resolve(directory, "tls-cert.pem")),
  ]);
  const server = createHttpsServer({ key, cert }, (_request, response) => response.end("ok"));
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("TLS test server did not bind a port");
  return { server, url: `https://127.0.0.1:${address.port}` };
}

async function resolveNodeFetchOptions(options: {
  ca?: string | readonly string[];
  rejectUnauthorized?: boolean;
}) {
  if (!options.ca) return { rejectUnauthorized: options.rejectUnauthorized };
  const certificate = await readFile(resolve(import.meta.dirname, "fixtures/tls-cert.pem"), "utf8");
  return {
    ...options,
    ca: Array.isArray(options.ca) ? options.ca.map(() => certificate) : certificate,
  };
}

function listen(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>,
) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
