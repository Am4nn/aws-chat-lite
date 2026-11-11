import { App } from "aws-cdk-lib";
import { loadConfig } from "../lib/config.js";
import { CoreStack } from "../lib/core-stack.js";
import { SpikeStack } from "../lib/spike-stack.js";

const app = new App();
// The CDK CLI loads the gitignored cdk.context.json into the app's context, so its values arrive like any -c flag.
const config = loadConfig(app.node.tryGetContext("stage"), process.env, {
  alertEmail: app.node.tryGetContext("alertEmail"),
  certificateArn: app.node.tryGetContext("certificateArn"),
});
// Floci always uses account 000000000000. On AWS the account comes from the active profile (CDK puts it in
// CDK_DEFAULT_ACCOUNT); the region is pinned per stage in config.
const env = { account: config.isLocal ? "000000000000" : process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

new CoreStack(app, `${config.prefix}-core`, { env, config });

// The throwaway spike stack exists only when asked for with -c spike=true, on either stage, so a normal deploy
// never creates it.
if (app.node.tryGetContext("spike") === "true") {
  new SpikeStack(app, `${config.prefix}-spike`, { env, config });
}
