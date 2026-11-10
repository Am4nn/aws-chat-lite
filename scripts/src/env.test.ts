import { describe, it, expect } from "vitest";
import { flociEnv, assertFlociUp, FLOCI_ENDPOINT, flociHost, localEnv, awsEnv } from "./env.js";

describe("localEnv", () => {
  it("drops real-AWS credential settings so Floci always gets test/test", () => {
    const env = localEnv({
      PATH: "/bin", AWS_PROFILE: "ig", AWS_SESSION_TOKEN: "tok",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_ACCESS_KEY_ID: "AKIAREAL",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
  });
});

describe("flociEnv", () => {
  it("points the AWS SDK/CLI at Floci with test keys", () => {
    const env = flociEnv();
    expect(FLOCI_ENDPOINT).toBe("http://localhost:4566");
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("test");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
  });
});

describe("assertFlociUp", () => {
  it("throws a helpful message when Floci is unreachable", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(assertFlociUp(down)).rejects.toThrow(/run `npm run floci:up`/);
  });

  it("resolves when Floci answers any HTTP response", async () => {
    const up = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(assertFlociUp(up)).resolves.toBeUndefined();
  });
});

describe("awsEnv (real AWS, stage aws)", () => {
  it("uses the ig profile by default and pins ap-southeast-2", () => {
    const env = awsEnv({ PATH: "/bin" });
    expect(env).toMatchObject({ PATH: "/bin", AWS_PROFILE: "ig", AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2" });
    expect(awsEnv({ AWS_PROFILE: "work" }).AWS_PROFILE).toBe("work");
  });

  it("refuses while pointed at an emulator or holding Floci's fake keys", () => {
    expect(() => awsEnv({ AWS_ENDPOINT_URL: "http://localhost:4566" })).toThrow(/unset AWS_ENDPOINT_URL/);
    expect(() => awsEnv({ AWS_ACCESS_KEY_ID: "test" })).toThrow(/Floci/);
  });
});

describe("flociHost", () => {
  it("maps execute-api URLs to the floci.io host", () => {
    expect(flociHost("wss://e6da6455e8.execute-api.us-east-1.amazonaws.com/spike")).toBe("e6da6455e8.execute-api.localhost.floci.io:4566");
  });
  it("maps Floci's own Function URL form (…lambda-url.us-east-1.127.0.0.1:4566)", () => {
    expect(flociHost("http://8768e5a553.lambda-url.us-east-1.127.0.0.1:4566/")).toBe("8768e5a553.lambda-url.us-east-1.localhost.floci.io:4566");
  });
});
