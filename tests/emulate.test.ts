import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";
import { createEmulator } from "emulate";
import { expect, it } from "vitest";
import { ScaleSetClient, githubAppJwtProvider, type FetchLike } from "../src/index.js";

it("exchanges an externally signed GitHub App JWT against the GitHub emulator", async () => {
  const appId = 900;
  const installationId = 901;
  const github = await createGitHubAppEmulator(appId, installationId);

  try {
    const privateKey = github.generatedSecrets.find(
      (secret) => secret.kind === "github.app_private_key" && secret.id === String(appId),
    )?.value;
    if (!privateKey) throw new Error("emulator did not generate a GitHub App private key");

    const signals: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const client = new ScaleSetClient({
      githubConfigUrl: "http://github.localhost/acme",
      credential: githubAppJwtProvider({
        installationId,
        jwtProvider: {
          getJwt(signal) {
            signals.push(signal);
            return signGitHubAppJwt(String(appId), privateKey);
          },
        },
      }),
      fetch: routeGitHubAppExchangeTo(github.url, installationId),
    });

    await expect(client.getRunner(7, { signal: controller.signal })).resolves.toEqual({
      id: 7,
      name: "runner",
    });
    expect(signals).toEqual([controller.signal]);

    await expect(
      fetch(`${github.url}/_emulate/installation-tokens`).then((response) => response.json()),
    ).resolves.toMatchObject({
      installation_tokens: [
        {
          app: { id: appId },
          installation: { id: installationId },
          status: "active",
        },
      ],
    });
  } finally {
    await github.close();
  }
});

it("rejects an incorrectly signed GitHub App JWT without minting an installation token", async () => {
  const appId = 910;
  const installationId = 911;
  const github = await createGitHubAppEmulator(appId, installationId);

  try {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const client = new ScaleSetClient({
      githubConfigUrl: "http://github.localhost/acme",
      credential: githubAppJwtProvider({
        installationId,
        jwtProvider: {
          getJwt: () => signGitHubAppJwt(String(appId), privateKey),
        },
      }),
      fetch: routeGitHubAppExchangeTo(github.url, installationId),
    });

    await expect(client.getRunner(7)).rejects.toMatchObject({
      status: 401,
      httpStatusCode: "UNAUTHORIZED",
    });
    await expect(
      fetch(`${github.url}/_emulate/installation-tokens`).then((response) => response.json()),
    ).resolves.toMatchObject({ installation_tokens: [] });
  } finally {
    await github.close();
  }
});

async function createGitHubAppEmulator(appId: number, installationId: number) {
  return createEmulator({
    service: "github",
    port: await availablePort(),
    seed: {
      github: {
        users: [{ login: "octocat" }],
        orgs: [{ login: "acme", members: [{ login: "octocat", role: "admin" }] }],
        apps: [
          {
            app_id: appId,
            slug: "scaleset-test",
            name: "Scale Set Test",
            installations: [{ installation_id: installationId, account: "acme" }],
          },
        ],
      },
    },
  });
}

function routeGitHubAppExchangeTo(emulatorUrl: string, installationId: number): FetchLike {
  return async (input) => {
    const request = new Request(input);
    const url = new URL(request.url);
    if (url.pathname === `/app/installations/${installationId}/access_tokens`) {
      return fetch(`${emulatorUrl}${url.pathname}`, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      });
    }
    if (url.pathname.endsWith("/actions/runners/registration-token")) {
      return json({ token: "registration" }, 201);
    }
    if (url.pathname.endsWith("/actions/runner-registration")) {
      return json({ url: "https://actions.example/", token: adminToken() }, 201);
    }
    return json({ id: 7, name: "runner" });
  };
}

function signGitHubAppJwt(appId: string, privateKey: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000) - 60;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: appId, iat: issuedAt, exp: issuedAt + 9 * 60 }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function adminToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // emulate listens on the wildcard address, so probe the same address family
    // instead of selecting a port that may only be free on IPv4.
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a test port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
