import { Annotations, Match } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { describe, it, expect } from "vitest";
import { addComplianceChecks } from "./compliance.js";
import type { CoreStack, CoreStackProps } from "./core-stack.js";
import { buildStack } from "./test-templates.js";

// Aspects change the stack's annotations, so these tests check a fresh stack rather than the shared template.
const checked = (props: Partial<CoreStackProps> = {}, change: (stack: CoreStack) => void = () => {}) => {
  const stack = buildStack("aws", props);
  change(stack);
  addComplianceChecks(stack);
  return Annotations.fromStack(stack);
};
const text = (found: { id: string; entry: { data?: unknown } }[]) => found.map((f) => `${f.id}: ${String(f.entry.data)}`);
const nagErrors = (annotations: Annotations) => text(annotations.findError("*", Match.stringLikeRegexp("AwsSolutions-.*")));

describe("compliance", () => {
  // A deploy knows the account; a synth without credentials leaves it to CloudFormation, which ARNs then show.
  describe.each([
    ["with the account", {}],
    ["without credentials", { env: { region: "ap-southeast-2" } }],
  ])("%s", (_, props) => {
    const annotations = checked(props);

    it("the aws stack passes AwsSolutions", () => {
      expect(nagErrors(annotations)).toEqual([]);
    });

    it("the aws stack has no warnings, so cdk synth --strict passes", () => {
      expect(text(annotations.findWarning("*", Match.anyValue()))).toEqual([]);
    });
  });

  it("the exceptions are narrow: a new public route or wildcard grant still fails", () => {
    const changed = checked({}, (stack) => {
      const fn = stack.addFunction("extra", "health.ts");
      stack.route("GET", "/extra", fn, { public: true });
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:*"], resources: ["*"] }));
    });
    expect(nagErrors(changed)).toEqual([
      expect.stringMatching(/^\/cl-aws-core\/Api\/GET--extra\/Resource: AwsSolutions-APIG4/),
      expect.stringMatching(/^\/cl-aws-core\/Fn-extra\/ServiceRole\/DefaultPolicy\/Resource: AwsSolutions-IAM5\[Action::s3:\*\]/),
      expect.stringMatching(/^\/cl-aws-core\/Fn-extra\/ServiceRole\/DefaultPolicy\/Resource: AwsSolutions-IAM5\[Resource::\*\]/),
    ]);
  });
});
