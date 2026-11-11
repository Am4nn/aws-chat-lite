import type { OpenNextConfig } from "@opennextjs/aws/types/open-next.js";

/**
 * How OpenNext turns the Next.js build into one Lambda: a plain request/response handler (no response streaming)
 * that reads API Gateway v2 events, which is also the shape of a Function URL event. Every page is personal, so
 * nothing is cached between users and there is no ISR cache, tag cache or revalidation queue to run.
 */
const config = {
  default: {
    override: {
      wrapper: "aws-lambda",
      converter: "aws-apigw-v2",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
  dangerous: { disableIncrementalCache: true, disableTagCache: true },
} satisfies OpenNextConfig;

export default config;
