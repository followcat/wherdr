// Types of dictation-files.mjs, for the server that imports it.
export interface FetchEntry { url: string, sha256: string, to?: string, dir?: string, members?: string[] }
export interface FetchOptions {
  fetchImpl?: typeof globalThis.fetch
  tries?: number
  retryMs?: number
  log?: (msg: string) => void
  onBytes?: (got: number, total: number) => void
  onUnpack?: () => void
  has?: (program: string) => Promise<boolean>
}
export const CATALOG: { models: { id: string, set: string, dir: string, files: { path: string, bytes: number }[] }[] }
export const VOICES: { voices: { id: string, set: string, dir: string, members: { path: string, bytes: number }[] }[] }
export const SETS: Record<string, FetchEntry[]>
export const DEFAULT_SETS: string[]
export function sha256Of(file: string): Promise<string>
export function download(url: string, sha256: string, file: string, opts?: FetchOptions): Promise<void>
export function extractCommand(archive: string, dir: string, members: string[], opts?: { stdin?: boolean }): { args: string[], program: string }
export function tarFailure(stderr: string, code: number | null, program: string): string
export type UnpackMode = 'tar' | 'js' | null
export function unpackMode(program: string, opts?: { has?: (program: string) => Promise<boolean> }): Promise<UnpackMode>
export function unpack(archive: string, dir: string, members: string[], opts?: { mode?: UnpackMode }): Promise<void>
export function fetchEntry(modelsDir: string, entry: FetchEntry, opts?: FetchOptions): Promise<void>
export function setsOf(args: string[]): string[]
export function fetchSets(modelsDir: string, names: string[], opts?: FetchOptions): Promise<void>
