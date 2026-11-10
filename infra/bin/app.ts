import { App } from "aws-cdk-lib";
import { loadConfig } from "../lib/config.js";
import { CoreStack } from "../lib/core-stack.js";

const app = new App();
const config = loadConfig(app.node.tryGetContext("stage"), process.env);
// aws: the account comes from your profile (CDK sets CDK_DEFAULT_ACCOUNT); the region is pinned in config.
const env = { account: config.isLocal ? "000000000000" : process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

new CoreStack(app, `${config.prefix}-core`, { env, config });
