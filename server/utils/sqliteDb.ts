// Lazy node:sqlite loading.
//
// node:sqlite is a builtin only from Node 22.13 (flagged before) and still
// warns when it loads. It must never load eagerly at startup — only when an
// Antigravity conversation is actually read — and a Node built without it
// must keep running, so the loader reports `unsupported`, never a crash.
//
// The builtin's name appears here once, in the dynamic import below; the
// static `import type` spelling would bind the module at load time, which
// both defeats laziness and hides the import from the test suite's mocks.

export const SQLITE_UNSUPPORTED = 'wherdr-sqlite-unsupported'
export const isSqliteUnsupported = (e: unknown) =>
  (e as { code?: string } | null)?.code === SQLITE_UNSUPPORTED

// The shape of the builtin used by the readers — spelled out so no static
// reference to `node:sqlite` is needed for types.
export interface DatabaseSync {
  prepare(sql: string): { get(...args: unknown[]): unknown, all(...args: unknown[]): unknown }
  exec(sql: string): void
  close(): void
}
export interface DatabaseSyncCtor {
  new (path: string, opts?: { readOnly?: boolean }): DatabaseSync
}
interface SqliteModule { DatabaseSync?: DatabaseSyncCtor }

const loadSqlite = () => import('node:sqlite') as Promise<SqliteModule>

let ctor: DatabaseSyncCtor | null | undefined
export async function databaseSyncCtor(): Promise<DatabaseSyncCtor> {
  if (ctor === undefined) ctor = await loadSqlite().then(m => m.DatabaseSync ?? null, () => null)
  if (!ctor) throw Object.assign(new Error('node:sqlite is not available on this Node.js'), { code: SQLITE_UNSUPPORTED })
  return ctor
}
export async function sqliteReady(): Promise<boolean> {
  return await databaseSyncCtor().then(() => true, () => false)
}
