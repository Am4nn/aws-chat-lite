import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const FLOCI = { AWS_ENDPOINT_URL: "http://localhost:4566" };

describe("loadConfig", () => {
  it("builds the local stage when pointed at Floci", () => {
    expect(loadConfig("local", FLOCI)).toEqual({ stage: "local", prefix: "cl-local", isLocal: true, region: "us-east-1" });
  });

  it("accepts the *.floci.io endpoint", () => {
    expect(loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost.floci.io:4566" }).isLocal).toBe(true);
  });

  it("builds the aws stage in ap-southeast-2 with no endpoint override", () => {
    expect(loadConfig("aws", {})).toEqual({ stage: "aws", prefix: "cl-aws", isLocal: false, region: "ap-southeast-2" });
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
