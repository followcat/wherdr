// Types of hc.mjs, for the server (server/utils/core.ts).
export const CORE_METHODS: readonly ['hello', 'rpc.discover', 'terminal.list', 'terminal.get',
  'machine.list', 'terminal.run', 'terminal.read', 'terminal.attach', 'terminal.send',
  'terminal.keys', 'terminal.interrupt', 'terminal.put', 'terminal.kill', 'terminal.keep', 'events.subscribe',
  'machine.add', 'machine.connect', 'machine.rename', 'machine.rm', 'server.status']
export class CoreError extends Error {
  kind: string
  hint?: string
  constructor(kind: string, message: string, hint?: string)
}
export const MIGRATION_GUIDE: string
export function missingHcSocket(env?: NodeJS.ProcessEnv): string
export function coreCall<T>(endpoint: string, method: string, params?: object, timeout?: number): Promise<T>
export function checkCore(endpoint: string): Promise<{ version: string, generation: number }>
