import { describe, it, expect } from "vitest";
import { Unavailable } from "./errors.js";
import { errorResponse } from "./http.js";

describe("errorResponse", () => {
  it("answers a busy table with 503 and its message", () => {
    expect(errorResponse(new Unavailable("busy"))).toMatchObject({ statusCode: 503, body: JSON.stringify({ error: "busy" }) });
  });
});
