import { describe, it, expect } from "vitest";
import { devEnvFile } from "./dev-env.js";

describe("devEnvFile", () => {
  it("points next dev at the emulated API, Cognito and MCP server", () => {
    const text = devEnvFile({ apiUrl: "http://abc.execute-api.localhost.floci.io:4566", userPoolClientId: "client123", mcpBaseUrl: "http://def.execute-api.localhost.floci.io:4566" });
    expect(text.split("\n")).toEqual([
      "API_URL=http://abc.execute-api.localhost.floci.io:4566",
      "USER_POOL_CLIENT_ID=client123",
      "COGNITO_ENDPOINT=http://localhost:4566",
      "COGNITO_REGION=us-east-1",
      "MCP_BASE_URL=http://def.execute-api.localhost.floci.io:4566",
      "",
    ]);
  });
});
