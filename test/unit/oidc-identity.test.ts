import { beforeAll, describe, expect, test } from "bun:test";
import type { Request } from "express";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { OidcProviderIdentity, principalCanActFor, principalCanRead } from "../../src/interface/http/auth";

const issuer = "http://idp.test/realms/wagering";
const audience = "wagering-api";
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let identity: OidcProviderIdentity;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  otherKey = (await generateKeyPair("RS256")).privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  identity = new OidcProviderIdentity({ issuer, audience, jwksUri: "unused" }, createLocalJWKSet({ keys: [jwk] }));
});

function sign(claims: Record<string, unknown>, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? audience)
    .setSubject("service-account-provider-a")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

const request = (authorization?: string) => ({ header: (name: string) => (name === "authorization" ? authorization : undefined) }) as unknown as Request;

describe("OidcProviderIdentity", () => {
  test("valid bearer token → principal with provider id and roles", async () => {
    const token = await sign({ azp: "provider-a", provider_id: "provider-a", realm_access: { roles: ["provider"] } });
    const principal = await identity.authenticate(request(`Bearer ${token}`));
    expect(principal).toEqual({
      subject: "service-account-provider-a",
      clientId: "provider-a",
      providerIds: ["provider-a"],
      roles: ["provider"],
    });
  });

  test("missing or malformed header → unauthenticated", async () => {
    expect(await identity.authenticate(request())).toBeUndefined();
    expect(await identity.authenticate(request("Basic abc"))).toBeUndefined();
    expect(await identity.authenticate(request("Bearer not-a-jwt"))).toBeUndefined();
  });

  test("rejects wrong signature, issuer, audience and expired tokens", async () => {
    const claims = { provider_id: "provider-a" };
    expect(await identity.authenticate(request(`Bearer ${await sign(claims, { key: otherKey })}`))).toBeUndefined();
    expect(await identity.authenticate(request(`Bearer ${await sign(claims, { iss: "http://evil" })}`))).toBeUndefined();
    expect(await identity.authenticate(request(`Bearer ${await sign(claims, { aud: "other-api" })}`))).toBeUndefined();
    const expired = await sign(claims, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await identity.authenticate(request(`Bearer ${expired}`))).toBeUndefined();
  });
});

describe("authorization helpers", () => {
  const provider = { subject: "s", clientId: "provider-a", providerIds: ["provider-a"], roles: ["provider"] };
  const operator = { subject: "s", clientId: "backoffice", providerIds: [], roles: ["operator"] };

  test("a provider acts only for itself", () => {
    expect(principalCanActFor(provider, "provider-a")).toBe(true);
    expect(principalCanActFor(provider, "provider-b")).toBe(false);
    expect(principalCanActFor(undefined, "provider-a")).toBe(false);
  });

  test("operators can read everything but cannot submit as a provider", () => {
    expect(principalCanRead(operator, "provider-b", "operator")).toBe(true);
    expect(principalCanActFor(operator, "provider-b")).toBe(false);
    expect(principalCanRead(provider, "provider-b", "operator")).toBe(false);
  });
});
