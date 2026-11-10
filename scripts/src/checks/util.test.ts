import { describe, it, expect } from "vitest";
import { withTimeout } from "./util.js";

describe("withTimeout", () => {
  it("rejects after ms", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "ws echo")).rejects.toThrow(/ws echo: no result within 0.02s/);
  });
  it("passes the value through", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });
});

import { flociHost } from "./util.js";
describe("flociHost", () => {
  it("maps execute-api URLs to the floci.io host", () => {
    expect(flociHost("wss://e6da6455e8.execute-api.us-east-1.amazonaws.com/spike")).toBe("e6da6455e8.execute-api.localhost.floci.io:4566");
  });
  it("maps Floci's own Function URL form (…lambda-url.us-east-1.127.0.0.1:4566)", () => {
    expect(flociHost("http://8768e5a553.lambda-url.us-east-1.127.0.0.1:4566/")).toBe("8768e5a553.lambda-url.us-east-1.localhost.floci.io:4566");
  });
});
