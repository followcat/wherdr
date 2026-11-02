export type CloseProcess = { state: 'idle' | 'unknown' } | { state: 'running', command: string }

interface ProcessInfo {
  shell_pid?: number
  foreground_process_group_id?: number
  foreground_processes?: { pid: number, argv?: string[], name?: string, cmdline?: string }[]
}

// A lone shell may be executing a blocking builtin (read, read -e). Only
// its preexec/prompt hooks can attest that it is actually at the prompt.
export function closeProcess(info?: ProcessInfo | null, promptToken?: string | null): CloseProcess {
  const procs = info?.foreground_processes
  if (!info?.shell_pid || !Array.isArray(procs) || !procs.length) return { state: 'unknown' }
  if (info.foreground_process_group_id === info.shell_pid && procs.every(p => p.pid === info.shell_pid)
    && promptToken === String(info.shell_pid)) return { state: 'idle' }
  const p = procs.find(p => p.pid !== info.shell_pid)
  const argv = p?.argv?.length ? p.argv : [p?.cmdline || p?.name || '']
  const command = argv.join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160)
  return command ? { state: 'running', command } : { state: 'unknown' }
}

export function closeProcessMessage(p: { agent: string | null, stopped?: unknown }, process: CloseProcess, tl: (en: string, fr: string) => string): string {
  const message = p.agent && !p.stopped
    ? { en: 'The process will be stopped.', fr: 'Le processus sera arrêté.' }
    : process.state === 'running'
      ? { en: `The running command “${process.command}” will be stopped.`, fr: `La commande en cours « ${process.command} » sera arrêtée.` }
      : process.state === 'unknown'
        ? { en: 'Anything running in it will be stopped.', fr: 'Tout ce qui y est en cours d’exécution sera arrêté.' }
        : null
  return message ? tl(message.en, message.fr) : ''
}
