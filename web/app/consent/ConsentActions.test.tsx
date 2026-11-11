// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentActions } from "./ConsentActions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function respond(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("ConsentActions", () => {
  it.each([["Allow", "allow"], ["Cancel", "deny"]])("%s sends the decision once and goes where the server says", async (label, decision) => {
    const fetch = respond(200, { redirectTo: "http://127.0.0.1:5555/cb?code=c&state=s" });
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    render(<ConsentActions requestId="q1" />);

    fireEvent.click(screen.getByRole("button", { name: label }));
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5555/cb?code=c&state=s"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/bff/api/oauth/requests/q1/decision", expect.objectContaining({ method: "POST", body: JSON.stringify({ decision }) }));
  });

  it("re-reads the page when the request is gone, so it shows the expired copy", async () => {
    respond(404, { error: "Not found." });
    render(<ConsentActions requestId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows any other failure and lets you try again", async () => {
    respond(500, { error: "Something went wrong." });
    render(<ConsentActions requestId="q1" />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong.");
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
