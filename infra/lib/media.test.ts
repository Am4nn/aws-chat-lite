import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

const PUSH_ROUTES = ["GET /push/key", "PUT /me/push", "DELETE /me/push/{id}"];
const VOICE_ROUTES = [
  "POST /rooms/{roomId}/voice/sessions", "POST /rooms/{roomId}/voice/sessions/{sessionId}/done", "POST /rooms/{roomId}/speech",
];

const routes = () => Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
/** The function a route's integration points at, by logical id. */
const targetOf = (route: any) => {
  const integration = template().findResources("AWS::ApiGatewayV2::Integration")[route.Target["Fn::Join"][1][1].Ref];
  return JSON.stringify(integration);
};
const actionsOf = (name: string) => statementsOf(fnNamed(name)).flatMap((s: any) => [s.Action].flat());
const s3Statements = (name: string) => statementsOf(fnNamed(name)).filter((s: any) => JSON.stringify(s.Resource).includes("Files"));
/** Each S3 object pattern the function may touch (e.g. "/speech/*"), with its sorted actions. */
const s3Rights = (name: string) => Object.fromEntries(s3Statements(name).flatMap((s: any) =>
  [s.Resource].flat().map((r: any) => [r["Fn::Join"][1].at(-1), [s.Action].flat().sort()])));
const secretNamed = (name: string) => template().findResources("AWS::SecretsManager::Secret", { Properties: { Name: name } });
const secretId = (name: string) => Object.keys(secretNamed(name))[0];
const secretReads = (name: string) => statementsOf(fnNamed(name))
  .filter((s: any) => [s.Action].flat().includes("secretsmanager:GetSecretValue")).map((s: any) => s.Resource.Ref);

describe("media: push and voice", () => {
  it("the 6 push and voice routes are behind the JWT authorizer, on their own Lambdas", () => {
    for (const [keys, fn] of [[PUSH_ROUTES, "cl-local-push-routes"], [VOICE_ROUTES, "cl-local-voice"]] as const) {
      for (const key of keys) {
        const route = routes().find((p) => p.RouteKey === key);
        expect(route, key).toBeDefined();
        expect(route.AuthorizationType, key).toBe("JWT");
        expect(targetOf(route), key).toContain(fnNamed(fn).logicalId);
      }
    }
  });

  it("the push keys and a copy of the public key live in their own secrets, kept on AWS", () => {
    for (const secret of ["push-keys", "push-public-key"]) {
      const [local] = Object.values(secretNamed(`cl-local-${secret}`)) as any[];
      expect(local.DeletionPolicy, secret).toBe("Delete");
      // CloudFormation would otherwise fill a new secret with a random password, which isn't JSON.
      expect(local.Properties.GenerateSecretString, secret).toEqual({ SecretStringTemplate: "{}", GenerateStringKey: "unset" });
      template("aws").hasResource("AWS::SecretsManager::Secret", { Properties: { Name: `cl-aws-${secret}` }, DeletionPolicy: "Retain" });
    }
  });

  it("only the push worker may read the private key; the routes facing browsers read only the public one", () => {
    expect(secretReads("cl-local-push")).toEqual([secretId("cl-local-push-keys")]);
    expect(fnNamed("cl-local-push").props.Environment.Variables).toMatchObject({ PUSH_KEYS_SECRET: "cl-local-push-keys" });
    expect(secretReads("cl-local-push-routes")).toEqual([secretId("cl-local-push-public-key")]);
    expect(fnNamed("cl-local-push-routes").props.Environment.Variables).toEqual(expect.objectContaining({
      PUSH_PUBLIC_KEY_SECRET: "cl-local-push-public-key",
    }));
    expect(fnNamed("cl-local-push-routes").props.Environment.Variables).not.toHaveProperty("PUSH_KEYS_SECRET");
    for (const name of ["cl-local-run", "cl-local-voice", "cl-local-live"]) expect(secretReads(name), name).not.toContain(secretId("cl-local-push-keys"));
  });

  it("the push worker gets 30 s and is never retried: a late duplicate notification is worse than a missed one", () => {
    const { logicalId, props } = fnNamed("cl-local-push");
    expect(props.Timeout).toBe(30);
    const configs = Object.values(template().findResources("AWS::Lambda::EventInvokeConfig")).map((c: any) => c.Properties);
    expect(configs).toEqual([expect.objectContaining({
      FunctionName: { Ref: logicalId }, MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 300,
    })]);
  });

  it("the push Lambdas read the table and write only puts and deletes", () => {
    for (const name of ["cl-local-push", "cl-local-push-routes"]) {
      const table = actionsOf(name).filter((a: string) => a.startsWith("dynamodb:"));
      expect(table, name).toEqual(expect.arrayContaining(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"]));
      expect(table.filter((a: string) => /UpdateItem|BatchWriteItem/.test(a)), name).toEqual([]);
    }
  });

  it("sends fake pushes locally unless the deploy asks for live ones, and real ones on AWS", () => {
    expect(fnNamed("cl-local-push").props.Environment.Variables.PUSH_MODE).toBe("fake");
    expect(fnNamed("cl-local-push", "local", { PUSH_MODE: "live" }).props.Environment.Variables.PUSH_MODE).toBe("live");
    expect(fnNamed("cl-aws-push", "aws").props.Environment.Variables.PUSH_MODE).toBe("live");
  });

  it("every Lambda that posts a message, ends a run or asks for an approval may queue a push, and no other", () => {
    const push = fnNamed("cl-local-push").logicalId;
    const senders = Object.values(template().findResources("AWS::Lambda::Function"))
      .filter((f: any) => f.Properties.Environment?.Variables?.PUSH_FN_NAME).map((f: any) => f.Properties.FunctionName);
    expect(senders.sort()).toEqual(["cl-local-live", "cl-local-mcp", "cl-local-run", "cl-local-schedule-fire", "cl-local-threads"]);
    for (const name of senders) {
      expect(fnNamed(name).props.Environment.Variables.PUSH_FN_NAME, name).toEqual({ Ref: push });
      const invokes = statementsOf(fnNamed(name)).filter((s: any) => [s.Action].flat().includes("lambda:InvokeFunction"));
      expect(JSON.stringify(invokes), name).toContain(`"${push}"`);
    }
  });

  it("the voice Lambda has 25 s and 512 MB, speaks with Polly and signs Transcribe streams, fake locally", () => {
    const { props } = fnNamed("cl-local-voice");
    expect(props.Timeout).toBe(25);
    expect(props.MemorySize).toBe(512);
    expect(props.Environment.Variables).toMatchObject({
      VOICE_MODE: "fake", TRANSCRIBE_LOCAL_URL: "ws://localhost:4601", S3_PUBLIC_ENDPOINT: "http://localhost:4566",
    });
    expect(props.Environment.Variables.FILES_BUCKET).toBeDefined();
    const aws = fnNamed("cl-aws-voice", "aws").props.Environment.Variables;
    expect(aws.VOICE_MODE).toBe("live");
    expect(aws).not.toHaveProperty("TRANSCRIBE_LOCAL_URL");
    expect(actionsOf("cl-local-voice")).toEqual(expect.arrayContaining(["polly:SynthesizeSpeech", "transcribe:StartStreamTranscriptionWebSocket"]));
  });

  it("the voice Lambda reads and writes only the read-aloud audio in the files bucket", () => {
    expect(s3Rights("cl-local-voice")).toEqual({ "/speech/*": ["s3:GetObject", "s3:PutObject"] });
  });

  it("the run function reads attachments (to show images to the model) and stages generated images", () => {
    const rights = s3Rights("cl-local-run");
    expect(rights["/rooms/*"]).toEqual(["s3:GetObject"]);
    expect(rights["/generated/*"]).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(rights).not.toHaveProperty("/staging/*");
  });

  it("read-aloud audio expires after 30 days, staged generated images after a day", () => {
    const [bucket] = Object.values(template().findResources("AWS::S3::Bucket", { Properties: { BucketName: "cl-local-files" } })) as any[];
    expect(bucket.Properties.LifecycleConfiguration.Rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ Prefix: "speech/", ExpirationInDays: 30, Status: "Enabled" }),
      expect.objectContaining({ Prefix: "generated/", ExpirationInDays: 1, Status: "Enabled" }),
    ]));
  });

  it("no Lambda holds a key in its environment, live push and models included, only the names of the secrets that do", () => {
    for (const stage of ["local", "aws"] as const) {
      const env = stage === "local" ? { PUSH_MODE: "live", MODEL_GATEWAY: "live", TOOL_MODE: "live" } : {};
      const names = Object.values(template(stage, env).findResources("AWS::Lambda::Function"))
        .flatMap((fn: any) => Object.keys(fn.Properties.Environment?.Variables ?? {}));
      expect(names.filter((n) => /KEY|PEM|VAPID|PRIVATE/.test(n) && !n.endsWith("_SECRET")), stage).toEqual([]);
    }
  });
});
