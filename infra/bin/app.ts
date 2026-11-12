import { App } from "aws-cdk-lib";
import { addPipelineComplianceChecks } from "../lib/compliance.js";
import { loadConfig } from "../lib/config.js";
import { CoreStack } from "../lib/core-stack.js";
import { PipelineStack } from "../lib/pipeline-stack.js";

const app = new App();
// The CDK CLI loads the gitignored cdk.context.json into the app's context, so its values arrive like any -c flag.
const config = loadConfig(app.node.tryGetContext("stage"), process.env, {
  alertEmail: app.node.tryGetContext("alertEmail"),
  certificateArn: app.node.tryGetContext("certificateArn"),
});
// Floci always uses account 000000000000. On AWS the account comes from the active profile (CDK puts it in
// CDK_DEFAULT_ACCOUNT); the region is pinned per stage in config.
const env = { account: config.isLocal ? "000000000000" : process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

if (config.isLocal) new CoreStack(app, `${config.prefix}-core`, { env, config });
// On AWS, cl-aws-core lives only inside the pipeline's prod stage, so a break-glass laptop deploy (by the path
// cl-aws-pipeline/Prod/cl-aws-core) ships the very template the pipeline does.
else addPipelineComplianceChecks(new PipelineStack(app, `${config.prefix}-pipeline`, { env, config }));
