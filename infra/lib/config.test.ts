import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const FLOCI = { AWS_ENDPOINT_URL: "http://localhost:4566" };

describe("loadConfig", () => {
  it("builds the local stage when pointed at Floci", () => {
    expect(loadConfig("local", FLOCI)).toEqual({
      stage: "local", prefix: "cl-local", isLocal: true, region: "us-east-1",
      siteOrigins: ["http://localhost:3000", "http://localhost:3100"], s3PublicEndpoint: "http://localhost:4566",
      modelGateway: "fake", toolMode: "fake",
    });
  });

  it("serves real models locally only when asked with MODEL_GATEWAY=live", () => {
    expect(loadConfig("local", { ...FLOCI, MODEL_GATEWAY: "live" }).modelGateway).toBe("live");
    expect(loadConfig("local", { ...FLOCI, MODEL_GATEWAY: "anything" }).modelGateway).toBe("fake");
  });

  it("calls real tools locally only when asked with TOOL_MODE=live", () => {
    expect(loadConfig("local", { ...FLOCI, TOOL_MODE: "live" }).toolMode).toBe("live");
    expect(loadConfig("local", { ...FLOCI, TOOL_MODE: "anything" }).toolMode).toBe("fake");
  });

  it("carries the local sandbox token, and never on aws", () => {
    expect(loadConfig("local", { ...FLOCI, SANDBOX_TOKEN: "t" }).sandboxToken).toBe("t");
    expect(loadConfig("aws", { SANDBOX_TOKEN: "t" }).sandboxToken).toBeUndefined();
  });

  it("accepts the *.floci.io endpoint", () => {
    expect(loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost.floci.io:4566" }).isLocal).toBe(true);
  });

  it("builds the aws stage in ap-southeast-2 with no endpoint override", () => {
    expect(loadConfig("aws", {})).toEqual({
      stage: "aws", prefix: "cl-aws", isLocal: false, region: "ap-southeast-2", siteOrigins: ["https://chat.amanarya.com"],
      mcpBaseUrl: "https://chat.amanarya.com", modelGateway: "live", toolMode: "live",
    });
  });

  it("refuses local without a Floci endpoint (would hit real AWS)", () => {
    expect(() => loadConfig("local", {})).toThrow(/AWS_ENDPOINT_URL must point at Floci/);
    expect(() => loadConfig("local", { AWS_ENDPOINT_URL: "https://s3.amazonaws.com" })).toThrow(/AWS_ENDPOINT_URL must point at Floci/);
  });

  it("refuses aws while an endpoint override is set", () => {
    expect(() => loadConfig("aws", FLOCI)).toThrow(/unset AWS_ENDPOINT_URL/);
  });

  it("refuses unknown or missing stage", () => {
    expect(() => loadConfig(undefined, FLOCI)).toThrow(/stage must be local or aws/);
    expect(() => loadConfig("prod", FLOCI)).toThrow(/stage must be local or aws/);
  });
});
