/** web/.env.development.local: where `next dev` finds the local API and Cognito. */
export function devEnvFile(v: { apiUrl: string; userPoolClientId: string }): string {
  return [
    `API_URL=${v.apiUrl}`,
    `USER_POOL_CLIENT_ID=${v.userPoolClientId}`,
    "COGNITO_ENDPOINT=http://localhost:4566",
    "COGNITO_REGION=us-east-1",
    "",
  ].join("\n");
}
