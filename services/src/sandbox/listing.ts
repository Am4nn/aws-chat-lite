import { SKIPPED_DIRS } from "../workspace/limits.js";
import type { ListedFile } from "./sandbox.js";

/** Python 3 run in the workspace: lists regular files, never following or listing symlinks, so a link to /etc/passwd stays invisible. */
export const LIST_CODE = `import hashlib, json, os
skipped = set(${JSON.stringify(SKIPPED_DIRS)})
files = []
for root, dirs, names in os.walk(".", followlinks=False):
    dirs[:] = [d for d in dirs if d not in skipped]
    for name in names:
        full = os.path.join(root, name)
        if os.path.islink(full) or not os.path.isfile(full):
            continue
        with open(full, "rb") as f:
            data = f.read()
        files.append({"path": os.path.relpath(full, ".").replace(os.sep, "/"), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
print(json.dumps(files))
`;

export function parseListing(stdout: string): ListedFile[] {
  try {
    const listing: unknown = JSON.parse(stdout);
    if (Array.isArray(listing)) return listing as ListedFile[];
  } catch {
    // Falls through to the error below.
  }
  throw new Error("Bad sandbox listing");
}
