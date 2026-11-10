import WebSocket from "ws";
import { flociHost } from "../env.js";
import { check, withTimeout, assert, sleep, type Outputs, type Stage } from "./util.js";

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode} on upgrade`)));
  });
}

/** Next message on `ws` whose `echo` equals `say`. */
function nextEcho(ws: WebSocket, say: string): Promise<{ echo: string; from: string }> {
  return new Promise((resolve) => {
    const on = (data: WebSocket.RawData) => {
      try {
        const m = JSON.parse(String(data));
        if (m.echo === say) { ws.off("message", on); resolve(m); }
      } catch { /* not ours */ }
    };
    ws.on("message", on);
  });
}

export async function run(o: Outputs, stage: Stage) {
  const url = stage === "local" ? `ws://${flociHost(o.WsUrl)}/spike` : o.WsUrl;
  let a: WebSocket | undefined;
  let b: WebSocket | undefined;
  const results = [
    await check("API Gateway WebSocket", "two clients connect; one message reaches both (postToConnection fan-out)", async () => {
      [a, b] = await withTimeout(Promise.all([open(url), open(url)]), 20_000, `connect ${url}`);
      await sleep(500); // let $connect finish storing both connections
      const t0 = Date.now();
      const echoes = Promise.all([nextEcho(a, "hi"), nextEcho(b, "hi")]);
      a.send(JSON.stringify({ say: "hi" }));
      const [ea, eb] = await withTimeout(echoes, 20_000, "echo to both clients");
      assert(ea.from === eb.from, "both echoes should name the same sender");
      return `${url} · round trip ${Date.now() - t0} ms`;
    }),
    await check("API Gateway WebSocket", "after one client leaves, the other still gets messages ($disconnect / Gone cleanup)", async () => {
      assert(a && b, "needs the previous check's connections");
      a.close();
      await sleep(1000);
      const echo = nextEcho(b, "still here");
      b.send(JSON.stringify({ say: "still here" }));
      const got = await withTimeout(echo, 20_000, "echo after a client left");
      return `ok (${got.echo})`;
    }),
  ];
  a?.terminate();
  b?.terminate();
  return results;
}
