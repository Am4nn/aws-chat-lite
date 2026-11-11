import { MAX_ROOM_FILE_BYTES, SKIPPED_DIRS } from "../workspace/limits.js";
import type { ListedFile } from "./sandbox.js";

/**
 * What the working directory holds. `unreadable` paths (files or folders the code locked) and `badNames` (names that
 * aren't UTF-8, shown with U+FFFD) are left out of `files`; `more` counts entries past the listing's cap.
 */
export type Listing = { files: ListedFile[]; unreadable: string[]; badNames: string[]; more: number };

// A room keeps 1,000 files, so a longer listing would only add notes. The byte cap keeps it well under the 1 MB the
// local sandbox server keeps of any output.
const MAX_LISTED = 2000;
const MAX_LISTING_BYTES = 512 * 1024;

/**
 * Lists regular files only, never following or listing symlinks, so a link to /etc/passwd stays invisible. A file
 * too big to be a room file isn't hashed, and the rest are hashed 1 MB at a time, so a huge file costs time but no
 * memory. Python runs isolated (-I): the working directory and the user's site-packages hold code the agent wrote,
 * and a planted json.py or .pth file would otherwise run in its place.
 */
const LIST_PY = `import hashlib, json, os, stat
skipped = set(${JSON.stringify(SKIPPED_DIRS)})
out = {"files": [], "unreadable": [], "badNames": [], "more": 0}
left = {"entries": ${MAX_LISTED}, "bytes": ${MAX_LISTING_BYTES}}

def add(key, value):
    cost = len(json.dumps(value))
    if left["entries"] < 1 or left["bytes"] < cost:
        out["more"] += 1
        return
    left["entries"] -= 1
    left["bytes"] -= cost
    out[key].append(value)

def shown(path):
    return os.fsencode(path).decode("utf-8", "replace")

def hashed(full):
    h = hashlib.sha256()
    with open(full, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

for root, dirs, names in os.walk(".", onerror=lambda e: add("unreadable", shown(os.path.relpath(e.filename, "."))), followlinks=False):
    dirs[:] = [d for d in dirs if d not in skipped]
    for name in names:
        full = os.path.join(root, name)
        path = os.path.relpath(full, ".")
        try:
            st = os.lstat(full)
            if not stat.S_ISREG(st.st_mode):
                continue
            path.encode("utf-8")
        except UnicodeEncodeError:
            add("badNames", shown(path))
            continue
        except OSError:
            add("unreadable", shown(path))
            continue
        try:
            digest = hashed(full) if st.st_size <= ${MAX_ROOM_FILE_BYTES} else ""
        except OSError:
            add("unreadable", path)
            continue
        add("files", {"path": path, "size": st.st_size, "sha256": digest})
print(json.dumps(out))
`;

/** A shell script, so the same code runs Python isolated on every sandbox. */
export const LIST_CODE = `exec python3 -I - <<'EOF'\n${LIST_PY}EOF\n`;

const isTexts = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isListed = (f: Partial<ListedFile> | null) =>
  typeof f?.path === "string" && Number.isInteger(f.size) && typeof f.sha256 === "string";

export function parseListing(stdout: string): Listing {
  try {
    const l = JSON.parse(stdout) as Listing | null;
    if (l && Array.isArray(l.files) && l.files.every(isListed) && isTexts(l.unreadable) && isTexts(l.badNames)
      && Number.isInteger(l.more)) return l;
  } catch {
    // Falls through to the error below.
  }
  throw new Error("Bad sandbox listing");
}

/**
 * Removes files, then any folders that leaves empty, so a room file can take the place of a folder the room no longer
 * has. Room paths hold no newline, so one per line is safe; a path that can't be removed is left for the next step.
 */
export const removeCode = (paths: string[]) =>
  `printf %s ${Buffer.from(`${paths.join("\n")}\n`).toString("base64")} | base64 -d | while IFS= read -r p; do `
  + `rm -f -- "$p"; d=$(dirname -- "$p"); [ "$d" = . ] || rmdir -p --ignore-fail-on-non-empty -- "$d"; done 2>/dev/null; true`;
