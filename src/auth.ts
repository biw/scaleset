import type { TokenProvider } from "./types.js";

export interface PersonalAccessTokenCredential {
  type: "personal-access-token";
  token: string;
}

export interface GitHubAppCredential {
  type: "github-app";
  clientId: string;
  installationId: number;
  privateKey: string;
}

export interface TokenProviderCredential {
  type: "token-provider";
  tokenProvider: TokenProvider;
}

export type Credential =
  | PersonalAccessTokenCredential
  | GitHubAppCredential
  | TokenProviderCredential;

export function personalAccessToken(token: string): PersonalAccessTokenCredential {
  if (!token) throw new Error("personal access token is required");
  return { type: "personal-access-token", token };
}

export function githubApp(credential: Omit<GitHubAppCredential, "type">): GitHubAppCredential {
  if (!credential.clientId) throw new Error("GitHub App client ID is required");
  if (!credential.installationId) throw new Error("GitHub App installation ID is required");
  if (!credential.privateKey) throw new Error("GitHub App private key is required");
  return { type: "github-app", ...credential };
}

export function tokenProvider(tokenProvider: TokenProvider): TokenProviderCredential {
  if (!tokenProvider || typeof tokenProvider.getToken !== "function") {
    throw new Error("token provider with getToken is required");
  }
  return { type: "token-provider", tokenProvider };
}

/**
 * Validate credentials supplied directly to the client constructor.
 *
 * The helpers above make invalid credentials difficult to construct, but this
 * check retains the Go client's constructor-time validation for callers that
 * construct a credential object themselves.
 */
export function validateCredential(credential: Credential): void {
  switch (credential.type) {
    case "personal-access-token":
      if (!credential.token)
        throw new Error("either GitHub App credentials or personal access token is required");
      return;
    case "github-app":
      if (!credential.clientId) throw new Error("client ID is required");
      if (!credential.installationId) throw new Error("app installation ID is required");
      if (!credential.privateKey) throw new Error("app private key is required");
      return;
    case "token-provider":
      if (!credential.tokenProvider || typeof credential.tokenProvider.getToken !== "function") {
        throw new Error("token provider with getToken is required");
      }
  }
}

export async function createGitHubAppJwt(
  credential: GitHubAppCredential,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: credential.clientId }),
  );
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(credential.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function pemToBytes(pem: string): ArrayBuffer {
  const pkcs1 = pemBlock(pem, "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----");
  const pkcs8 = pemBlock(pem, "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----");
  const body = pkcs1 && (!pkcs8 || pkcs1.position < pkcs8.position) ? pkcs1.body : pkcs8?.body;
  if (!body) throw new Error("GitHub App private key is not valid PEM");
  const decoded = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  const der =
    pkcs1 && (!pkcs8 || pkcs1.position < pkcs8.position) ? pkcs1ToPkcs8(decoded) : decoded;
  return new Uint8Array(der).buffer;
}

function pemBlock(
  pem: string,
  header: string,
  footer: string,
): { position: number; body: string } | undefined {
  const position = pem.indexOf(header);
  if (position < 0) return undefined;
  const bodyStart = position + header.length;
  const bodyEnd = pem.indexOf(footer, bodyStart);
  if (bodyEnd < 0) return undefined;
  const body = pem.slice(bodyStart, bodyEnd).replace(/\s/g, "");
  return body ? { position, body } : undefined;
}

/**
 * Go's jwt.ParseRSAPrivateKeyFromPEM accepts both PKCS#1 and PKCS#8 PEM keys.
 * Web Crypto only imports PKCS#8, so wrap the PKCS#1 RSAPrivateKey in the
 * standard PrivateKeyInfo envelope to retain that compatibility portably.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  if (pkcs1[0] !== 0x30) throw new Error("GitHub App RSA private key is not valid DER");
  const algorithm = derSequence(
    new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]),
  );
  const privateKey = derTag(0x04, pkcs1);
  return derSequence(concat(new Uint8Array([0x02, 0x01, 0x00]), algorithm, privateKey));
}

function derSequence(contents: Uint8Array): Uint8Array {
  return derTag(0x30, contents);
}

function derTag(tag: number, contents: Uint8Array): Uint8Array {
  const length = derLength(contents.length);
  return concat(new Uint8Array([tag]), length, contents);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...values: Uint8Array[]): Uint8Array {
  const size = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
