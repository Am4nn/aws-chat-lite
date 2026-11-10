import { describe, it, expect } from "vitest";
import { devEnvFile } from "./dev-env.js";

describe("devEnvFile", () => {
  it("points next dev at the emulated API and Cognito", () => {
    const text = devEnvFile({ apiUrl: "http://abc.execute-api.localhost.floci.io:4566", userPoolClientId: "client123" });
    expect(text.split("\n")).toEqual([
      "API_URL=http://abc.execute-api.localhost.floci.io:4566",
      "USER_POOL_CLIENT_ID=client123",
      "COGNITO_ENDPOINT=http://localhost:4566",
      "COGNITO_REGION=us-east-1",
      "",
    ]);
  });
});
