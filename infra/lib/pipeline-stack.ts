import { type CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as pipelines from "aws-cdk-lib/pipelines";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.js";
import { ProdStage } from "./prod-stage.js";
import type { WebBuild } from "./web.js";

const REPO = "Am4nn/aws-chat-lite";

/**
 * The account-specific values, set once by hand in Parameter Store. GitHub never holds them, and the pipeline's synth
 * reads them where a laptop reads infra/cdk.context.json.
 */
const PARAMETERS = {
  alertEmail: "/chat-lite/alert-email",
  certificateArn: "/chat-lite/certificate-arn",
  connectionArn: "/chat-lite/github-connection-arn",
};

/** How long the alarms must stay quiet after a deploy: three of their five-minute periods. */
const BAKE_SECONDS = 15 * 60;

const RETRY = "--retry 5 --retry-all-errors --retry-delay 10";

export interface PipelineStackProps extends StackProps {
  config: StageConfig;
  /** The OpenNext build the site ships. */
  webBuild?: WebBuild;
}

/**
 * Continuous delivery to prod: every push to master is checked, synthesized once and deployed by a CodePipeline in
 * the account, so no AWS credential ever leaves AWS. The pipeline updates itself from the same commit before it
 * deploys the app.
 */
export class PipelineStack extends Stack {
  readonly prod: ProdStage;

  constructor(scope: Construct, id: string, { config, webBuild, ...props }: PipelineStackProps) {
    super(scope, id, props);
    const { prefix } = config;
    const fromParameterStore = (name: string) => ({ type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE, value: name });

    const source = pipelines.CodePipelineSource.connection(REPO, "master", {
      // Resolved by CloudFormation at deploy time, so neither a laptop nor the pipeline needs the ARN to synthesize.
      connectionArn: ssm.StringParameter.valueForStringParameter(this, PARAMETERS.connectionArn),
    });
    const synth = new pipelines.CodeBuildStep("Synth", {
      input: source,
      buildEnvironment: {
        environmentVariables: {
          ALERT_EMAIL: fromParameterStore(PARAMETERS.alertEmail),
          CERTIFICATE_ARN: fromParameterStore(PARAMETERS.certificateArn),
        },
      },
      // The same gate a pull request passes in CI, run again on the exact commit that ships.
      commands: [
        "npm ci",
        "npm run check",
        "npm test",
        "npm -w web run build:open-next",
        'cd infra && npx cdk synth -c stage=aws -c alertEmail="$ALERT_EMAIL" -c certificateArn="$CERTIFICATE_ARN" --strict --no-notices -q',
      ],
      primaryOutputDirectory: "infra/cdk.out",
    });

    const pipeline = new pipelines.CodePipeline(this, "Pipeline", {
      pipelineName: `${prefix}-pipeline`,
      pipelineType: codepipeline.PipelineType.V2,
      synth,
      selfMutation: true,
      // One account needs no customer-managed KMS key for its artifacts, which would cost $1 a month.
      crossAccountKeys: false,
      // One asset action instead of one per asset: each action bills at least a minute.
      publishAssetsInParallel: false,
      codeBuildDefaults: {
        buildEnvironment: { buildImage: codebuild.LinuxBuildImage.STANDARD_8_0, computeType: codebuild.ComputeType.SMALL },
        partialBuildSpec: codebuild.BuildSpec.fromObject({ phases: { install: { "runtime-versions": { nodejs: 22 } } } }),
      },
    });

    const topic = new sns.Topic(this, "PipelineTopic", { topicName: `${prefix}-pipeline`, enforceSSL: true });
    // AWS mails a confirmation link first; nothing arrives until it is clicked.
    topic.addSubscription(new subs.EmailSubscription(config.prod!.alertEmail));

    this.prod = new ProdStage(this, "Prod", { env: props.env, config, webBuild });
    const output = (name: string) => this.prod.core.node.findChild(name) as CfnOutput;
    // CloudFront and DNS can lag the stack by a few seconds, hence the retries.
    const health = new pipelines.ShellStep("HealthCheck", {
      envFromCfnOutputs: { SITE_URL: output("SiteUrl"), API_URL: output("ApiUrl") },
      commands: [`curl -fsS ${RETRY} -o /dev/null "$SITE_URL/login"`, `curl -fsS ${RETRY} "$API_URL/health"`],
    });
    const watch = new pipelines.CodeBuildStep("WatchAlarms", {
      commands: [watchAlarms(`${prefix}-`)],
      rolePolicyStatements: [
        // DescribeAlarms reads alarm state only, and names no alarm until it runs.
        new iam.PolicyStatement({ actions: ["cloudwatch:DescribeAlarms"], resources: ["*"] }),
      ],
      timeout: Duration.minutes(30),
    });
    watch.addStepDependency(health);
    pipeline.addStage(this.prod, {
      // Approves itself unless the change adds IAM permissions or security group rules; then it mails the topic and
      // waits for a person, as a laptop deploy waits for its y/n.
      pre: [new pipelines.ConfirmPermissionsBroadening("CheckBroadening", { stage: this.prod, notificationTopic: topic })],
      post: [health, watch],
    });

    pipeline.buildPipeline();
    pipeline.pipeline.notifyOn("NotifyOnFailure", topic, {
      events: [codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED],
    });
  }
}

/**
 * Fails if any of the app's alarms is in ALARM at any point during the bake. It can't undo the deploy: a failed run
 * stops here, mails the pipeline topic, and the fix is a revert pushed to master.
 */
const watchAlarms = (alarmPrefix: string) => `deadline=$(( $(date +%s) + ${BAKE_SECONDS} ))
while true; do
  firing=$(aws cloudwatch describe-alarms --alarm-name-prefix ${alarmPrefix} --state-value ALARM --query "MetricAlarms[].AlarmName" --output text)
  if [ -n "$firing" ]; then echo "In ALARM after the deploy: $firing"; exit 1; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  sleep 60
done
echo "No ${alarmPrefix}* alarm fired in the ${BAKE_SECONDS / 60} minutes after the deploy."`;
