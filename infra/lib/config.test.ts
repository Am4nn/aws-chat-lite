import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";
import { TEST_CONTEXT } from "./test-templates.js";

const FLOCI = { AWS_ENDPOINT_URL: "http://localhost:4566" };

describe("loadConfig", () => {
  it("builds the local stage when pointed at Floci", () => {
    expect(loadConfig("local", FLOCI)).toEqual({
      stage: "local", prefix: "cl-local", isLocal: true, region: "us-east-1",
      siteOrigins: ["http://localhost:3000", "http://localhost:3100"], s3PublicEndpoint: "http://localhost:4566",
      modelGateway: "fake", toolMode: "fake", pushMode: "fake", voiceMode: "fake", transcribeLocalUrl: "ws://localhost:4601",
      streamLocalUrl: "http://localhost:4600", sandboxLocalUrl: "http://host.docker.internal:4700",
    });
  });

  it("sends real pushes locally only when asked with PUSH_MODE=live", () => {
    expect(loadConfig("local", { ...FLOCI, PUSH_MODE: "live" }).pushMode).toBe("live");
    expect(loadConfig("local", { ...FLOCI, PUSH_MODE: "anything" }).pushMode).toBe("fake");
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
    expect(loadConfig("aws", { SANDBOX_TOKEN: "t" }, TEST_CONTEXT).sandboxToken).toBeUndefined();
  });

  it("accepts the *.floci.io endpoint", () => {
    expect(loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost.floci.io:4566" }).isLocal).toBe(true);
  });

  it("builds the aws stage in ap-southeast-2 with its prod settings and no endpoint override", () => {
    expect(loadConfig("aws", {}, TEST_CONTEXT)).toEqual({
      stage: "aws", prefix: "cl-aws", isLocal: false, region: "ap-southeast-2", siteOrigins: ["https://chat.amanarya.com"],
      mcpBaseUrl: "https://chat.amanarya.com", modelGateway: "live", toolMode: "live", pushMode: "live", voiceMode: "live",
      prod: { domainName: "chat.amanarya.com", ...TEST_CONTEXT },
    });
  });

  it("refuses aws without its context, naming each missing value", () => {
    expect(() => loadConfig("aws", {})).toThrow(
      /stage=aws is missing alertEmail, certificateArn in infra\/cdk\.context\.json \(copy infra\/cdk\.context\.example\.json\)/,
    );
    expect(() => loadConfig("aws", {}, { alertEmail: TEST_CONTEXT.alertEmail })).toThrow(/stage=aws is missing certificateArn in/);
    expect(() => loadConfig("aws", {}, { certificateArn: TEST_CONTEXT.certificateArn, alertEmail: "" })).toThrow(
      /stage=aws is missing alertEmail in/,
    );
  });

  it("refuses a malformed alert email", () => {
    expect(() => loadConfig("aws", {}, { ...TEST_CONTEXT, alertEmail: "nope" })).toThrow(/alertEmail "nope" is not an email address/);
  });

  it("refuses a certificate outside us-east-1", () => {
    const sydney = TEST_CONTEXT.certificateArn.replace("us-east-1", "ap-southeast-2");
    expect(() => loadConfig("aws", {}, { ...TEST_CONTEXT, certificateArn: sydney })).toThrow(
      /certificateArn must be an ACM certificate in us-east-1 \(CloudFront only reads certificates there\)/,
    );
  });

  it("local ignores the context", () => {
    expect(loadConfig("local", FLOCI, TEST_CONTEXT).prod).toBeUndefined();
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
