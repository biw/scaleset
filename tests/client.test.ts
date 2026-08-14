import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  ScaleSetClient,
  RequestError,
  createGitHubAppJwt,
  githubApp,
  isScaleSetError,
  personalAccessToken,
  type FetchLike,
} from "../src/index.js";
import { createNodeFetch } from "../src/node.js";

const adminToken = `header.${base64Url(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }))}.signature`;

describe("ScaleSetClient", () => {
  it("discovers the Actions service and issues scale-set requests", async () => {
    const requests: Request[] = [];
    const client = new ScaleSetClient({
      githubConfigUrl: "https://github.example/acme/repo",
      credential: personalAccessToken("pat"),
      fetch: async (input) => {
        const request = new Request(input);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/registration-token"))
          return json({ token: "registration" }, 201);
        if (url.pathname.endsWith("/actions/runner-registration")) {
          return json({ url: "https://actions.example/tenant/123/", token: adminToken }, 201);
        }
        return json({ id: 7, name: "runner" });
      },
    });

    await expect(client.getRunner(7)).resolves.toEqual({ id: 7, name: "runner" });
    expect(requests).toHaveLength(3);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/api/v3/repos/acme/repo/actions/runners/registration-token",
    );
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer pat");
    expect(requests[1]!.headers.get("authorization")).toBe("RemoteAuth registration");
    expect(new URL(requests[2]!.url).pathname).toBe(
      "/tenant/123/_apis/distributedtask/pools/0/agents/7",
    );
    expect(new URL(requests[2]!.url).searchParams.get("api-version")).toBe("6.0-preview");
    expect(requests[2]!.headers.get("authorization")).toBe(`Bearer ${adminToken}`);
  });

  it("validates direct credentials when constructing a client", () => {
    const options = { githubConfigUrl: "https://github.example/org" };
    expect(
      () =>
        new ScaleSetClient({
          ...options,
          credential: { type: "personal-access-token", token: "" },
        }),
    ).toThrow(
      "invalid credentials: either GitHub App credentials or personal access token is required",
    );
    expect(
      () =>
        new ScaleSetClient({
          ...options,
          credential: { type: "github-app", clientId: "", installationId: 1, privateKey: "key" },
        }),
    ).toThrow("invalid credentials: client ID is required");
    expect(
      () =>
        new ScaleSetClient({
          ...options,
          credential: { type: "github-app", clientId: "1", installationId: 0, privateKey: "key" },
        }),
    ).toThrow("invalid credentials: app installation ID is required");
    expect(
      () =>
        new ScaleSetClient({
          ...options,
          credential: { type: "github-app", clientId: "1", installationId: 1, privateKey: "" },
        }),
    ).toThrow("invalid credentials: app private key is required");
  });

  it("adds labels when creating a scale set", async () => {
    const requests: Request[] = [];
    const client = clientFor((request) => {
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("registration-token"))
        return json({ token: "registration" }, 201);
      if (new URL(request.url).pathname.endsWith("runner-registration")) {
        return json({ url: "https://actions.example/", token: adminToken }, 201);
      }
      return json({ id: 1, name: "macos" });
    });

    await client.createRunnerScaleSet({ name: "macos" });
    expect(await requests[2]!.text()).toBe(
      '{"name":"macos","labels":[{"name":"macos","type":"System"}],"RunnerSetting":{},"createdOn":"0001-01-01T00:00:00Z"}',
    );
  });

  it("uses a custom token provider and refreshes concurrent callers once", async () => {
    let provided = 0;
    const client = new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: {
        type: "token-provider",
        tokenProvider: { getToken: async () => `token-${++provided}` },
      },
      fetch: async (input) => {
        const request = new Request(input);
        const path = new URL(request.url).pathname;
        if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
        if (path.endsWith("runner-registration"))
          return json({ url: "https://actions.example/", token: adminToken }, 201);
        return json({ id: 1, name: "runner" });
      },
    });

    await Promise.all([client.getRunner(1), client.getRunner(2)]);
    expect(provided).toBe(1);
  });

  it("covers scale-set, group, runner, and JIT API operations", async () => {
    const actionRequests: Request[] = [];
    const client = clientFor((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
      if (path.endsWith("runner-registration")) {
        return json({ url: "https://actions.example/", token: adminToken }, 201);
      }
      actionRequests.push(request);
      if (path.includes("runnergroups"))
        return json({
          count: 1,
          value: [{ id: 2, name: "group", size: 1, isDefaultGroup: false }],
        });
      if (request.method === "GET" && path.endsWith("runnerscalesets"))
        return json({ count: 1, value: [{ id: 3, name: "scale" }] });
      if (path.endsWith("generatejitconfig"))
        return json({ encodedJITConfig: "jit", runner: { id: 4, name: "runner" } });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return json({ id: 3, name: "scale" });
    });

    await expect(client.getRunnerGroupByName("group")).resolves.toMatchObject({
      id: 2,
      name: "group",
    });
    await expect(client.getRunnerScaleSet(2, "scale")).resolves.toMatchObject({ id: 3 });
    await expect(client.listRunnerScaleSets(2)).resolves.toMatchObject([{ id: 3 }]);
    await expect(client.getRunnerScaleSetById(3)).resolves.toMatchObject({ id: 3 });
    await expect(client.createRunnerScaleSet({ name: "scale" })).resolves.toMatchObject({ id: 3 });
    await expect(client.updateRunnerScaleSet(3, { name: "scale" })).resolves.toMatchObject({
      id: 3,
    });
    await expect(
      client.generateJitRunnerConfig({ name: "runner", workFolder: "_work" }, 3),
    ).resolves.toMatchObject({ encodedJITConfig: "jit" });
    await expect(client.deleteRunnerScaleSet(3)).resolves.toBeUndefined();
    await expect(client.removeRunner(4)).resolves.toBeUndefined();

    expect(new URL(actionRequests[0]!.url).searchParams.get("groupName")).toBe("group");
    expect(new URL(actionRequests[1]!.url).searchParams).toMatchObject({});
    expect(await actionRequests[4]!.text()).toContain('"labels"');
    expect(new URL(actionRequests.at(-1)!.url).pathname).toContain("/agents/4");
  });

  it("maps Actions exceptions and retries transient responses", async () => {
    let calls = 0;
    const client = new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: personalAccessToken("pat"),
      retry: { maxRetries: 1, maxDelayMs: 0 },
      sleep: async () => {},
      fetch: async (input) => {
        const request = new Request(input);
        const path = new URL(request.url).pathname;
        if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
        if (path.endsWith("runner-registration"))
          return json({ url: "https://actions.example/", token: adminToken }, 201);
        calls += 1;
        if (calls === 1) return new Response("", { status: 503 });
        return json({ typeName: "AgentNotFoundException", message: "missing" }, 404);
      },
    });

    await expect(client.getRunner(1)).rejects.toSatisfy((error: unknown) =>
      isScaleSetError(error, "RUNNER_NOT_FOUND"),
    );
    expect(calls).toBe(2);
  });

  it("rejects ambiguous runner and scale-set lookup results", async () => {
    const client = clientFor((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
      if (path.endsWith("runner-registration"))
        return json({ url: "https://actions.example/", token: adminToken }, 201);
      return json({
        count: 2,
        value: [
          { id: 1, name: "first" },
          { id: 2, name: "second" },
        ],
      });
    });

    await expect(client.getRunnerByName("runner")).rejects.toThrow("multiple runners found");
    await expect(client.getRunnerScaleSet(1, "scale")).rejects.toThrow(
      "multiple runner scale sets found",
    );
  });

  it("returns no result for an empty scale-set lookup", async () => {
    const client = clientFor((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
      if (path.endsWith("runner-registration"))
        return json({ url: "https://actions.example/", token: adminToken }, 201);
      return json({ count: 0, value: [] });
    });

    await expect(client.getRunnerScaleSet(1, "missing")).resolves.toBeUndefined();
  });

  it("creates Web Crypto compatible GitHub App JWTs", async () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const credential = githubApp({ clientId: "123", installationId: 456, privateKey: key });
    const jwt = await createGitHubAppJwt(credential, new Date("2026-01-01T00:00:00Z"));
    const [, payload] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      iss: "123",
      iat: 1_767_225_540,
      exp: 1_767_226_080,
    });
  });

  it("accepts traditional PKCS#1 GitHub App private keys", async () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const jwt = await createGitHubAppJwt(
      githubApp({ clientId: "123", installationId: 456, privateKey: key }),
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("rejects a whitespace-only GitHub App PEM body", async () => {
    await expect(
      createGitHubAppJwt(
        githubApp({
          clientId: "123",
          installationId: 456,
          privateKey: `-----BEGIN PRIVATE KEY-----${" ".repeat(128 * 1024)}-----END PRIVATE KEY-----`,
        }),
      ),
    ).rejects.toThrow("GitHub App private key is not valid PEM");
  });

  it("uses the injected clock for GitHub App authentication", async () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let appJwt = "";
    const client = new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: githubApp({ clientId: "123", installationId: 456, privateKey: key }),
      clock: () => new Date("2026-01-01T00:00:00Z"),
      fetch: async (input) => {
        const request = new Request(input);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/access_tokens")) {
          appJwt = request.headers.get("authorization")!.slice("Bearer ".length);
          return json({ token: "installation-token", expires_at: "2026-01-01T01:00:00Z" }, 201);
        }
        if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
        if (path.endsWith("runner-registration"))
          return json({ url: "https://actions.example/", token: adminToken }, 201);
        return json({ id: 1, name: "runner" });
      },
    });

    await client.getRunner(1);
    const [, payload] = appJwt.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      iat: 1_767_225_540,
      exp: 1_767_226_080,
    });
  });

  it("wraps transport failures and honors Retry-After", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: personalAccessToken("pat"),
      retry: { maxRetries: 1, minDelayMs: 0, maxDelayMs: 10_000, random: () => 0 },
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async (input) => {
        const path = new URL(new Request(input).url).pathname;
        if (path.endsWith("registration-token")) return json({ token: "registration" }, 201);
        if (path.endsWith("runner-registration"))
          return json({ url: "https://actions.example/", token: adminToken }, 201);
        calls += 1;
        return calls === 1
          ? new Response("temporary", { status: 503, headers: { "Retry-After": "2" } })
          : json({ id: 1, name: "runner" });
      },
    });
    await expect(client.getRunner(1)).resolves.toMatchObject({ id: 1 });
    expect(waits).toEqual([2_000]);

    const unavailable = new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: personalAccessToken("pat"),
      retry: { maxRetries: 0 },
      fetch: async () => {
        throw new Error("network down");
      },
    });
    await expect(unavailable.getRunner(1)).rejects.toBeInstanceOf(RequestError);
  });

  it("exposes Node transport diagnostics and a close lifecycle", async () => {
    const nodeFetch = createNodeFetch({ proxyUrl: "http://proxy.example", ca: "test-ca" });
    const client = new ScaleSetClient({
      githubConfigUrl: "https://github.example/org",
      credential: personalAccessToken("pat"),
      fetch: nodeFetch,
    });
    expect(client.debugInfo()).toMatchObject({ hasProxy: true, hasRootCA: true });
    await expect(nodeFetch.close()).resolves.toBeUndefined();
  });
});

function clientFor(handler: (request: Request) => Response): ScaleSetClient {
  const fetch: FetchLike = async (input) => handler(new Request(input));
  return new ScaleSetClient({
    githubConfigUrl: "https://github.example/org",
    credential: personalAccessToken("pat"),
    fetch,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
