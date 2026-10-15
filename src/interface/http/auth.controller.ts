import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { logger } from "../../infrastructure/observability/logger";
import { APP_CONFIG, type AppConfig } from "../../shared/config";
import { Public } from "./auth";

const credentialsSchema = z.object({ clientId: z.string().min(1).max(128), clientSecret: z.string().min(1).max(256) }).strict();

/**
 * Convenience endpoint: exchanges client credentials for a bearer token at the
 * Identity Provider (OAuth2 client_credentials) and returns it. The IdP issues
 * and signs the token; this service never sees or stores user passwords.
 * Credentials come in the JSON body or as HTTP Basic auth.
 */
@Public()
@Controller("auth")
export class AuthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Post("token")
  @HttpCode(200)
  async token(@Body() body: unknown, @Headers("authorization") authorization: string | undefined) {
    if (!this.config.auth.enabled) {
      throw new NotFoundException({ code: "AUTH_DISABLED", message: "Authentication is disabled (AUTH_ENABLED=false)" });
    }
    const { clientId, clientSecret } = this.credentials(body, authorization);

    let response: Response;
    try {
      response = await fetch(this.config.auth.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      logger.warn("identity provider unreachable", { error });
      throw new HttpException(
        { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "Identity provider unavailable" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (response.status === 400 || response.status === 401) {
      throw new UnauthorizedException({ code: "INVALID_CLIENT_CREDENTIALS", message: "Invalid client credentials" });
    }
    if (!response.ok) {
      throw new HttpException(
        { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: `Identity provider answered ${response.status}` },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const token = (await response.json()) as { access_token: string; expires_in: number };
    return { access_token: token.access_token, token_type: "Bearer", expires_in: token.expires_in };
  }

  private credentials(body: unknown, authorization: string | undefined): { clientId: string; clientSecret: string } {
    const basic = /^Basic\s+(.+)$/i.exec(authorization ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
    }
    return credentialsSchema.parse(body ?? {});
  }
}
