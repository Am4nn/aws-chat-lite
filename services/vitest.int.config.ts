import { defineConfig } from "vitest/config";

// Integration tests against DynamoDB on Floci (npm run floci:up && npm run deploy:local first).
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    testTimeout: 20000,
    env: {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_REGION: "us-east-1",
      TABLE_NAME: "cl-local-main",
    },
  },
});
