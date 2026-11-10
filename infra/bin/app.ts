import { App } from "aws-cdk-lib";
import { loadConfig } from "../lib/config.js";
import { CoreStack } from "../lib/core-stack.js";
import { SpikeStack } from "../lib/spike-stack.js";

const app = new App();
const config = loadConfig(app.node.tryGetContext("stage"), process.env);
// aws: the account comes from your profile (CDK sets CDK_DEFAULT_ACCOUNT); the region is pinned in config.
const env = { account: config.isLocal ? "000000000000" : process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

new CoreStack(app, `${config.prefix}-core`, { env, config });

// Throwaway probes (npm run spike / spike:aws). Allowed on both stages: spike:aws checks real AWS.
if (app.node.tryGetContext("spike") === "true") {
  new SpikeStack(app, `${config.prefix}-spike`, { env, config });
}
