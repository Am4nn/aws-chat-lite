import { defineConfig } from "vitest/config";

// Integration tests against DynamoDB on Floci (npm run floci:up && npm run deploy:local first).
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    testTimeout: 20000,
    // Floci applies DynamoDB writes one at a time, each rewriting its whole store, so files run side by side only
    // queue behind each other's writes and their timings depend on which other files happen to be running.
    fileParallelism: false,
    env: {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_REGION: "us-east-1",
      TABLE_NAME: "cl-local-main",
      FILES_BUCKET: "cl-local-files",
      S3_PUBLIC_ENDPOINT: "http://localhost:4566",
      // The deployed key, so tokens sealed here open in the Lambdas and the other way round.
      TOKEN_KEY_SECRET: "cl-local-token-key",
      SITE_ORIGINS: "http://localhost:3000,http://localhost:3100",
    },
  },
});
