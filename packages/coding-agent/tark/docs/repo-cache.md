# Local repository cache

Tark's `builtin:tark-cache` keeps a reconstructible SHA-256 index under
`~/.tark/cache/repo-index/`. It makes no model calls and does not replace native
read, grep, find, or shell tools. Disable it with `-builtin:tark-cache` in the
`extensions` setting if persistent source-derived metadata is undesirable.

- `get_workspace_changes`: changes accumulated since the previous call, HEAD, and
  Git staged/unstaged/untracked status. Each list is capped at 200 entries;
  truncation is explicit. Use native discovery for larger results.
- `get_file_outline`: fresh working-tree hash and a deterministic declaration or
  heading outline, not a semantic summary. At most 32 entries per 64-line chunk,
  100 overall. Read the actual file before editing or when exact code matters.
- `/repo-cache-status`: file counts, hits/misses, hashes, pending work, time, and disk size.
- `tark --repo-cache-exclude fixtures,third-party/generated`: additional relative
  path prefixes, not globs.

Git supplies inventory and changes. Without Git a bounded directory walk is
used. Startup and idle batches process at most 100 entries. Watch notifications,
periodic audits, and query-time metadata validation detect updates. Unchanged
file/chunk outlines are reused. A query fails rather than intentionally returning
a stale outline when indexing fails. Results describe a point in time, not an
atomic snapshot of a concurrently edited repository.

The index contains declaration snippets: treat it as private source-derived
data. It excludes configuration/build/dependency directories, common credential
paths, environment files, binary/media formats, ignored paths, and oversized
files. These exclusions are best-effort, not general secret detection. Do not
store secrets in ordinary source files.

Limits: 20,000 eligible files, 80,000 visited entries without Git, 1 MiB per file,
64 MiB per index, 16 MiB Git output, ten seconds per Git command. Startup is
bounded by entry counts, not a guaranteed wall-clock deadline. In-process
operations are serialized; separate processes may replace the same reconstructible
index. Stop Tark before removing an index to reclaim disk space.

Offline regression coverage lives in `test/tark.test.ts`. Historical PieXis
benchmark timings are not measurements of this Tark integration.
