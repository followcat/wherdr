// A new task worktree gets the npm dependencies of the project's main checkout
// instead of its own npm ci, when both have the same package-lock.json and the
// main checkout's install matches it. It is a copy, never hard links: a task
// that writes into its node_modules (a patch, a tool's cache) leaves the main
// checkout's alone. On a copy-on-write file system (btrfs, XFS, APFS) the copy
// shares the blocks; elsewhere it is a plain copy, still much lighter than
// npm ci (no network, no resolver, a few MB of memory instead of about 1 GB).
//
// Prints one word: none (no package-lock.json), kept (the worktree has its
// node_modules already: an earlier attempt), shared (copied from the main
// checkout), install (the lock differs, or the main checkout has no install
// up to date with it, or the copy failed).
export const DEPS_SCRIPT = `repo=$1 dir=$2
[ -f "$dir/package-lock.json" ] || { echo none; exit 0; }
[ -e "$dir/node_modules" ] && { echo kept; exit 0; }
src=$repo/node_modules
if ! cmp -s "$repo/package-lock.json" "$dir/package-lock.json" || [ ! -f "$src/.package-lock.json" ] || [ "$repo/package-lock.json" -nt "$src/.package-lock.json" ]; then echo install; exit 0; fi
tmp=$dir/.node_modules.partial
for how in "-a --reflink=auto" "-cRp" "-Rp"; do
  rm -rf "$tmp"; cp $how "$src" "$tmp" 2>/dev/null && mv "$tmp" "$dir/node_modules" && { echo shared; exit 0; }
done
rm -rf "$tmp"; echo install`

export type DepsResult = 'none' | 'kept' | 'shared' | 'install'

// The line the worker's instructions get; nothing when the script said nothing
// known (it failed): the worker then does as the project's instructions say.
export function depsNote(result: string): string | undefined {
  if (result === 'shared' || result === 'kept')
    return `Dependencies are installed (node_modules, ${result === 'shared' ? 'copied from the main checkout' : 'from an earlier attempt'}). Run npm ci only if package-lock.json changes.`
  if (result === 'install')
    return 'Run npm ci first: package-lock.json differs from the main checkout\'s, or the main checkout has no install matching it.'
  return undefined
}
