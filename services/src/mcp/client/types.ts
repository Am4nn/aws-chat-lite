import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** A room's sign-in to a remote MCP server. `expiresAt` is in milliseconds. */
export type StoredAuth = {
  issuer: string;
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  expiresAt: number;
  resource?: string;
};

/** What an OAuth flow keeps between sending the admin to the authorize page and their return. */
export type PendingAuth = {
  issuer: string;
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInformationMixed;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
};

export interface TokenStore {
  /** Null also when the sealed tokens won't open. */
  load(): Promise<{ auth: StoredAuth; version: number } | null>;
  /** False when someone saved a newer version first. */
  save(auth: StoredAuth, version: number): Promise<boolean>;
  markNeedsAuth(): Promise<void>;
}

export class NeedsAuth extends Error {}
