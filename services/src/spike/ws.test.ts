import { describe, it, expect } from "vitest";
import { callbackEndpoint } from "./ws.js";

describe("callbackEndpoint", () => {
  it("AWS: https://<domain>/<stage>", () => {
    expect(callbackEndpoint({ apiId: "abc", domainName: "abc.execute-api.ap-southeast-2.amazonaws.com", stage: "spike" }, {}))
      .toBe("https://abc.execute-api.ap-southeast-2.amazonaws.com/spike");
  });
  it("Floci (AWS_ENDPOINT_URL set in the Lambda): the API's own host under localhost.floci.io", () => {
    expect(callbackEndpoint({ apiId: "abc", domainName: "whatever", stage: "spike" }, { AWS_ENDPOINT_URL: "http://localhost.floci.io:4566" }))
      .toBe("http://abc.execute-api.localhost.floci.io:4566/spike");
  });
  it("WS_CALLBACK_URL overrides both", () => {
    expect(callbackEndpoint({ apiId: "abc", domainName: "d", stage: "s" }, { WS_CALLBACK_URL: "http://x/y" })).toBe("http://x/y");
  });
});
