// Types of userpath.mjs, for the server (server/utils/env.ts, projectsTasks.ts).
export const USER_BIN_DIRS: string[]
export const LEAD_BIN_DIRS: string[]
export const TAIL_BIN_DIRS: string[]
export const SYSTEM_BIN_DIRS: string[]
export function mergePath(...parts: Array<string | string[] | undefined | null>): string
export function knownBinDirs(home?: string, exists?: (p: string) => boolean): string[]
export function projectsHome(env?: NodeJS.ProcessEnv, home?: string): string
export function inProjectsHome(dir: string, env?: NodeJS.ProcessEnv, home?: string): boolean
export function projectsDataDir(env?: NodeJS.ProcessEnv, home?: string): string
export function projectsEnvPath(env?: NodeJS.ProcessEnv, home?: string): string
export function pathFromEnvOutput(text: string): string
export function loginShellPath(env?: NodeJS.ProcessEnv, run?: unknown): string
export function userPath(opts?: { env?: NodeJS.ProcessEnv, home?: string, first?: string[], login?: string, exists?: (p: string) => boolean }): string
export const JSON_PATH_AWK: string
export const USER_PATH_SH: string
