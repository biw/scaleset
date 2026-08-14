/** Node-only helpers. The core package remains Fetch/Web-Crypto based. */
import { readFile } from "node:fs/promises";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { FetchLike } from "./types.js";

export type { FetchLike } from "./types.js";

/** Read a GitHub App PKCS#8 PEM key without exposing filesystem APIs in the portable export. */
export async function readGitHubAppPrivateKey(path: string | URL): Promise<string> {
  return readFile(path, "utf8");
}

/** Read an mTLS certificate/key pair for use with createNodeFetch. */
export async function readTlsClientCertificate(
  certificatePath: string | URL,
  keyPath: string | URL,
): Promise<Pick<NodeFetchOptions, "clientCertificate" | "clientKey">> {
  const [clientCertificate, clientKey] = await Promise.all([
    readFile(certificatePath, "utf8"),
    readFile(keyPath, "utf8"),
  ]);
  return { clientCertificate, clientKey };
}

export interface NodeFetchOptions {
  /** Proxy URL used for GitHub and Actions-service requests. */
  proxyUrl?: string | URL;
  /** Additional PEM root certificates for GitHub Enterprise Server. */
  ca?: string | string[];
  /** Disable TLS verification only for explicitly trusted development environments. */
  rejectUnauthorized?: boolean;
  /** PEM client certificate presented for mutual TLS authentication. */
  clientCertificate?: string | string[];
  /** PEM private key paired with clientCertificate for mutual TLS authentication. */
  clientKey?: string | string[];
}

export interface NodeFetch extends FetchLike {
  /** Gracefully release sockets when the associated client is no longer needed. */
  close(): Promise<void>;
}

/**
 * Create an injected Fetch implementation with Node proxy and custom-CA support.
 * Keep the returned dispatcher alive for the same lifetime as the ScaleSetClient.
 */
export function createNodeFetch(options: NodeFetchOptions = {}): NodeFetch {
  if (Boolean(options.clientCertificate) !== Boolean(options.clientKey)) {
    throw new Error("clientCertificate and clientKey must be provided together");
  }
  const requestTls = {
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    ...(options.clientCertificate && options.clientKey
      ? { cert: options.clientCertificate, key: options.clientKey }
      : {}),
  };
  const dispatcher: Dispatcher = options.proxyUrl
    ? new ProxyAgent({ uri: options.proxyUrl.toString(), requestTls })
    : new Agent({
        connect: {
          ...requestTls,
        },
      });
  return Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      }) as unknown as Promise<Response>,
    {
      close: async () => {
        await dispatcher.close();
      },
      scalesetTransportInfo: {
        hasProxy: options.proxyUrl !== undefined,
        hasRootCA: options.ca !== undefined,
      },
    },
  ) satisfies NodeFetch;
}
