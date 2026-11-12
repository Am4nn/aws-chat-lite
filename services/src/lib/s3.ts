import { S3Client } from "@aws-sdk/client-s3";
import { requiredEnv } from "./env.js";

let signing: S3Client | undefined;
let calling: S3Client | undefined;

/**
 * Signing is local computation, so this client only has to produce URLs the browser can reach. Locally that is
 * Floci's host as the browser sees it (the Lambda's own endpoint is an address inside Docker), path style because
 * that's how Floci serves buckets; on AWS it is the regional S3 endpoint.
 */
export function s3() {
  const endpoint = process.env.S3_PUBLIC_ENDPOINT;
  return (signing ??= new S3Client(endpoint ? { endpoint, forcePathStyle: true } : {}));
}

/**
 * For the Lambda's own calls to S3. An endpoint override (AWS_ENDPOINT_URL, which Floci sets inside its Lambdas and the
 * config forbids on AWS) means Floci, which serves buckets path-style.
 */
export function objects() {
  return (calling ??= new S3Client(process.env.AWS_ENDPOINT_URL ? { forcePathStyle: true } : {}));
}

export const filesBucket = () => requiredEnv("FILES_BUCKET");

/** S3 answers a missing key with 403, not 404, to a caller without ListBucket (as these Lambdas are on AWS). */
export const missingObject = (e: unknown) => ["NotFound", "Forbidden"].includes((e as Error).name);
