import { describe, expect, it } from "vitest";
import { agentCoreSandbox } from "./agentcore.js";
import { SandboxGone } from "./sandbox.js";

type Cmd = { constructor: { name: string }; input: any };
const events = (...results: any[]) => ({ stream: (async function* () { for (const result of results) yield { result }; })() });
const failure = (name: string, message = "x") => Object.assign(new Error(message), { name });

function setup(respond: (c: Cmd) => any) {
  const calls: Cmd[] = [];
  const client = {
    send: async (c: any) => {
      calls.push(c);
      const r = respond(c);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { calls, sb: agentCoreSandbox({ client: client as any, offlineId: "off-id", onlineId: "on-id" }) };
}
const done = { content: [], structuredContent: { stdout: "", stderr: "", exitCode: 0 } };
const started = (c: Cmd) => (c.constructor.name === "StartCodeInterpreterSessionCommand" ? { sessionId: "s1" } : events(done));

describe("agentCoreSandbox", () => {
  it("starts on the offline interpreter unless internet is on", async () => {
    const { sb, calls } = setup(started);
    expect(await sb.start({ runId: "r1", internet: false, lifetimeSec: 900 })).toEqual({ handle: "off:s1", internet: false });
    expect(calls[0]!.input).toMatchObject({ codeInterpreterIdentifier: "off-id", name: "run-r1", sessionTimeoutSeconds: 900 });
    expect(await sb.start({ runId: "r1", internet: true, lifetimeSec: 900 })).toEqual({ handle: "on:s1", internet: true });
    expect(calls[1]!.input.codeInterpreterIdentifier).toBe("on-id");
  });

  it("runs code through one base64 command, never quoting user text", async () => {
    const { sb, calls } = setup(() => events({ content: [{ type: "text", text: "42\n" }], structuredContent: { stdout: "42\n", stderr: "", exitCode: 0 } }));
    const r = await sb.exec("off:s1", { language: "python", code: "print(6*7)", timeoutSec: 60 });
    expect(r).toEqual({ stdout: "42\n", stderr: "", exitCode: 0, timedOut: false });
    const input = calls[0]!.input;
    expect(input).toMatchObject({ codeInterpreterIdentifier: "off-id", sessionId: "s1", name: "executeCommand" });
    expect(input.arguments.command).toMatch(/^printf %s [A-Za-z0-9+/=]+ \| base64 -d > \/tmp\/cl-run\.py && timeout -k 5 60 python3 /);
  });

  it("uses sh and node for the other languages", async () => {
    const { sb, calls } = setup(() => events(done));
    await sb.exec("on:s1", { language: "shell", code: "echo 'it\"s'", timeoutSec: 5 });
    await sb.exec("on:s1", { language: "javascript", code: "1", timeoutSec: 5 });
    expect(calls[0]!.input.arguments.command).toMatch(/cl-run\.sh && timeout -k 5 5 sh \/tmp\/cl-run\.sh$/);
    expect(calls[1]!.input.arguments.command).toMatch(/cl-run\.js && timeout -k 5 5 node \/tmp\/cl-run\.js$/);
    expect(calls[0]!.input.arguments.command).not.toContain("echo");
  });

  it("falls back to the text content, with the error flag as exit 1", async () => {
    const { sb } = setup(() => events({ content: [{ type: "text", text: "boom" }], isError: true }));
    expect(await sb.exec("off:s1", { language: "shell", code: "x", timeoutSec: 60 })).toEqual({ stdout: "boom", stderr: "", exitCode: 1, timedOut: false });
  });

  it("calls exit 124 a timeout, and a 137 well before the limit a kill", async () => {
    const exited = (exitCode: number) => setup(() => events({ content: [], structuredContent: { stdout: "", stderr: "", exitCode } })).sb;
    expect((await exited(124).exec("off:s1", { language: "shell", code: "x", timeoutSec: 1 })).timedOut).toBe(true);
    expect(await exited(137).exec("off:s1", { language: "shell", code: "x", timeoutSec: 60 }))
      .toMatchObject({ timedOut: false, stderr: "\nkilled (likely out of memory)" });
  });

  it("writes long code in pieces that each fit in one command argument, then runs it", async () => {
    const { sb, calls } = setup(() => events(done));
    const code = "x".repeat(150 * 1024);
    await sb.exec("off:s1", { language: "python", code, timeoutSec: 5 });
    const commands = calls.map((c) => c.input.arguments.command as string);
    expect(commands).toHaveLength(3);
    expect(commands.every((c) => c.length < 128 * 1024)).toBe(true);
    expect(commands[0]).toMatch(/ > \/tmp\/cl-run\.py$/);
    expect(commands[1]).toMatch(/ >> \/tmp\/cl-run\.py$/);
    expect(commands[2]).toMatch(/ >> \/tmp\/cl-run\.py && timeout -k 5 5 python3 /);
    const sent = commands.map((c) => Buffer.from(c.match(/^printf %s (\S+) \|/)![1]!, "base64").toString()).join("");
    expect(sent).toBe(code);
  });

  it("writes files in batches of at most 5 MB", async () => {
    const { sb, calls } = setup(() => events({ content: [] }));
    const mb4 = new Uint8Array(4 * 1024 * 1024);
    await sb.writeFiles("off:s1", ["a", "b", "c"].map((path) => ({ path, bytes: mb4 })));
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.input.name).toBe("writeFiles");
      expect(c.input.arguments.content[0].blob).toBeInstanceOf(Uint8Array);
    }
  });

  it("puts small files in one batch", async () => {
    const { sb, calls } = setup(() => events({ content: [] }));
    await sb.writeFiles("off:s1", [{ path: "a", bytes: new Uint8Array(3) }, { path: "b/c", bytes: new Uint8Array(3) }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.arguments.content.map((x: any) => x.path)).toEqual(["a", "b/c"]);
  });

  it("reads files back under the requested relative path, from blob or text", async () => {
    const { sb, calls } = setup(() => events(
      { content: [{ type: "resource", resource: { type: "blob", uri: "file:///opt/work/a/b.bin", blob: new Uint8Array([1, 2]) } }] },
      { content: [{ type: "resource", resource: { type: "text", uri: "file:///opt/work/c.txt", text: "hi" } }] },
    ));
    const files = await sb.readFiles("off:s1", ["a/b.bin", "c.txt"]);
    expect(calls[0]!.input.arguments.paths).toEqual(["a/b.bin", "c.txt"]);
    expect(files.map((f) => f.path)).toEqual(["a/b.bin", "c.txt"]);
    expect(Array.from(files[0]!.bytes)).toEqual([1, 2]);
    expect(new TextDecoder().decode(files[1]!.bytes)).toBe("hi");
  });

  it("turns a missing session into SandboxGone, but not on stop", async () => {
    const { sb } = setup(() => failure("ResourceNotFoundException"));
    await expect(sb.exec("off:s1", { language: "shell", code: "x", timeoutSec: 1 })).rejects.toBeInstanceOf(SandboxGone);
    await expect(sb.stop("off:s1")).resolves.toBeUndefined();
  });

  it("treats a validation error naming the session as gone, any other as a failure", async () => {
    await expect(setup(() => failure("ValidationException", "Session s1 is not active")).sb.readFiles("off:s1", ["a"])).rejects.toBeInstanceOf(SandboxGone);
    await expect(setup(() => failure("ValidationException", "bad path")).sb.readFiles("off:s1", ["a"])).rejects.not.toBeInstanceOf(SandboxGone);
  });
});
