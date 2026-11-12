import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { CoreStack } from "./core-stack.js";

const OBJECT_ACTIONS = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"];

/**
 * The room's files: an index in the table and the bytes in the files bucket, behind one Lambda on the HTTP API. The
 * files Lambda signs uploads into staging and copies them into the room; the run Lambda's sandbox reads and writes
 * room files directly, but never sees anyone's staged upload.
 */
export function addFiles(stack: CoreStack, files: s3.Bucket) {
  const fn = stack.addFunction("files", "workspace/handler.ts", { tableAccess: true, environment: stack.filesEnvironment(files) });
  stack.allowBroadcast(fn);
  // Object-level actions only, without ListBucket: nothing here needs to browse the bucket.
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: OBJECT_ACTIONS, resources: [files.arnForObjects("staging/*"), files.arnForObjects("workspaces/*")],
  }));

  const { runFn } = stack.runs;
  runFn.addToRolePolicy(new iam.PolicyStatement({ actions: OBJECT_ACTIONS, resources: [files.arnForObjects("workspaces/*")] }));
  runFn.addEnvironment("FILES_BUCKET", files.bucketName);

  stack.route("GET", "/rooms/{roomId}/files", fn);
  stack.route("POST", "/rooms/{roomId}/files/uploads", fn);
  stack.route("PUT", "/rooms/{roomId}/files", fn);
  stack.route("GET", "/rooms/{roomId}/files/download", fn);
  stack.route("DELETE", "/rooms/{roomId}/files", fn);
}
