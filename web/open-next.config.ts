import type { OpenNextConfig } from "@opennextjs/aws/types/open-next.js";

/**
 * How OpenNext turns the Next.js build into one Lambda: a streaming handler, so a page's loading skeleton is sent
 * before its data has arrived, on a Function URL in RESPONSE_STREAM mode. It reads API Gateway v2 events, which is
 * also the shape of a Function URL event. Every page is personal, so nothing is cached between users and there is no
 * ISR cache, tag cache or revalidation queue to run.
 */
const config = {
  default: {
    override: {
      wrapper: "aws-lambda-streaming",
      converter: "aws-apigw-v2",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
  dangerous: { disableIncrementalCache: true, disableTagCache: true },
} satisfies OpenNextConfig;

export default config;
