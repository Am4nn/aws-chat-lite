import { Stage, type StageProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { addComplianceChecks } from "./compliance.js";
import { CoreStack, type CoreStackProps } from "./core-stack.js";

type ProdStageProps = StageProps & Pick<CoreStackProps, "config" | "webBuild">;

/** What the pipeline deploys to prod: the core stack, under the name and logical IDs a laptop deploy gave it. */
export class ProdStage extends Stage {
  readonly core: CoreStack;

  constructor(scope: Construct, id: string, { config, webBuild, ...props }: ProdStageProps) {
    super(scope, id, props);
    // A stack in a stage is named <stage>-<id> unless told otherwise, and a new name would be a second stack beside
    // the live one. Logical IDs come from the construct path inside the stack, so the stage leaves them as they were.
    this.core = new CoreStack(this, `${config.prefix}-core`, { stackName: `${config.prefix}-core`, config, webBuild });
    addComplianceChecks(this.core);
  }
}
