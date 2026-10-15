import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "../../infrastructure/observability/logger";
import { PROVIDER_IDENTITY } from "./tokens";

/**
 * Authentication is delegated to an external OIDC Identity Provider (Keycloak
 * in docker-compose). Each game provider is a confidential client using the
 * client_credentials grant; its access token carries a `provider_id` claim.
 * This service never stores credentials: it only verifies bearer tokens.
 */
export interface ProviderPrincipal {
  /** Token subject (service account) — or "anonymous" when auth is disabled. */
  subject: string;
  /** OAuth client that obtained the token (`azp`). */
  clientId: string;
  /** Provider ids this principal may act for; `"*"` = any (auth disabled). */
  providerIds: readonly string[] | "*";
  roles: readonly string[];
}

export interface ProviderIdentityPort {
  /** undefined = no valid credentials (→ 401). */
  authenticate(request: Request): Promise<ProviderPrincipal | undefined>;
}

/** AUTH_ENABLED=false: every request is an all-powerful anonymous principal. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  constructor(private readonly operatorRole = "operator") {}

  async authenticate(): Promise<ProviderPrincipal> {
    return { subject: "anonymous", clientId: "anonymous", providerIds: "*", roles: [this.operatorRole] };
  }
}

export interface OidcOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/**
 * Verifies `Authorization: Bearer <jwt>` locally: signature against the IdP
 * JWKS (fetched once, cached, refreshed on unknown `kid`), plus `iss`, `aud`,
 * `exp` / `nbf`. No call to the IdP per request.
 */
export class OidcProviderIdentity implements ProviderIdentityPort {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly options: OidcOptions,
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(options.jwksUri), { cooldownDuration: 30_000 });
  }

  async authenticate(request: Request): Promise<ProviderPrincipal | undefined> {
    const token = bearerToken(request.header("authorization"));
    if (!token) return undefined;
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: 5,
      });
      return toPrincipal(payload);
    } catch (error) {
      logger.warn("bearer token rejected", { reason: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+([A-Za-z0-9\-_.]+)$/i.exec(header?.trim() ?? "");
  return match?.[1];
}

function toPrincipal(payload: JWTPayload): ProviderPrincipal {
  const claim = payload.provider_id;
  const providerIds = typeof claim === "string" ? [claim] : Array.isArray(claim) ? claim.filter((c) => typeof c === "string") : [];
  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles.filter((r): r is string => typeof r === "string") : [];
  return {
    subject: payload.sub ?? "unknown",
    clientId: typeof payload.azp === "string" ? payload.azp : "unknown",
    providerIds,
    roles,
  };
}

const IS_PUBLIC = "isPublic";
const REQUIRED_ROLES = "requiredRoles";

/** Health, metrics and the token endpoint stay open. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Requires at least one of the given realm roles (e.g. "operator"). */
export const Roles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES, roles);

/** May this principal submit / read operations of `providerId`? */
export function principalCanActFor(principal: ProviderPrincipal | undefined, providerId: string): boolean {
  if (!principal) return false;
  return principal.providerIds === "*" || principal.providerIds.includes(providerId);
}

/** Reads: the provider itself, or an operator. */
export function principalCanRead(principal: ProviderPrincipal | undefined, providerId: string, operatorRole: string): boolean {
  return principalCanActFor(principal, providerId) || (principal?.roles.includes(operatorRole) ?? false);
}

export type AuthenticatedRequest = Request & { principal?: ProviderPrincipal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.identity.authenticate(request);
    if (!principal) {
      throw new UnauthorizedException({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token" });
    }
    request.principal = principal;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_ROLES, targets);
    if (required?.length && !required.some((role) => principal.roles.includes(role))) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: `Requires role: ${required.join(" or ")}` });
    }
    return true;
  }
}
