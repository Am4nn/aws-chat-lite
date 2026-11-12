import { App } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { describe, it, expect } from "vitest";
import { addComplianceChecks } from "./compliance.js";
import { buildPipelineStack, buildStack } from "./test-templates.js";

/** Every JSON path where two templates differ. */
function differences(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => differences((a as any)[k], (b as any)[k], `${path}/${k}`));
  }
  return [path];
}

const resources = (t: Template) =>
  Object.entries(t.toJSON().Resources as Record<string, { Type: string }>).map(([id, r]) => `${id} ${r.Type}`).sort();

describe("the prod stage", () => {
  // Both apps bundle the Lambdas, because a function version's logical ID hashes its code's asset.
  const laptop = buildStack("aws", {}, new App());
  addComplianceChecks(laptop);
  const before = Template.fromStack(laptop);
  const staged = buildPipelineStack({}, new App()).prod.core;
  const after = Template.fromStack(staged);

  it("updates the stack a laptop deployed, cl-aws-core, rather than creating a new one", () => {
    expect(staged.stackName).toBe("cl-aws-core");
  });

  // CloudFormation matches resources by logical ID, and CDK derives each one from the construct's path inside its
  // stack, so moving the stack into a stage keeps them. A changed ID would replace the table, the user pool and the
  // secrets.
  it("keeps every resource's logical ID and type", () => {
    expect(resources(after).length).toBeGreaterThan(400);
    expect(resources(after)).toEqual(resources(before));
  });

  // A few names CDK builds from the full construct path, stage included, do change. Each is an in-place update.
  it("changes only CloudFront's origin IDs and the site bucket's deployment tags", () => {
    const changed = differences(before.toJSON(), after.toJSON());
    expect(changed.length).toBeGreaterThan(0);
    const inPlace = changed.filter((path) =>
      /^\/Resources\/Site[0-9A-F]{8}\/Properties\/DistributionConfig\/(Origins\/\d+\/Id|(CacheBehaviors\/\d+|DefaultCacheBehavior)\/TargetOriginId)$/.test(path)
      || /^\/Resources\/Web[0-9A-F]{8}\/Properties\/Tags\/\d+\/Key$/.test(path));
    expect(changed).toEqual(inPlace);
  });

  it("runs the AwsSolutions checks on the staged stack too, with every exception still finding its resource", () => {
    const errors = Annotations.fromStack(staged).findError("*", Match.stringLikeRegexp("AwsSolutions-.*"));
    expect(errors.map((e) => e.id)).toEqual([]);
  });
});
