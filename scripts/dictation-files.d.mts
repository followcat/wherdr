// Types of dictation-files.mjs, for the server that imports it.
export interface FetchEntry { url: string, sha256: string, to?: string, dir?: string, members?: string[] }
export interface FetchOptions {
  fetchImpl?: typeof globalThis.fetch
  tries?: number
  retryMs?: number
  log?: (msg: string) => void
  onBytes?: (got: number, total: number) => void
  onUnpack?: () => void
}
export const CATALOG: { models: { id: string, set: string, dir: string, files: { path: string, bytes: number }[] }[] }
export const SETS: Record<string, FetchEntry[]>
export const DEFAULT_SETS: string[]
export function sha256Of(file: string): Promise<string>
export function download(url: string, sha256: string, file: string, opts?: FetchOptions): Promise<void>
export function fetchEntry(modelsDir: string, entry: FetchEntry, opts?: FetchOptions): Promise<void>
export function setsOf(args: string[]): string[]
export function fetchSets(modelsDir: string, names: string[], opts?: FetchOptions): Promise<void>
