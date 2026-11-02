import { expect, it } from 'vitest'
import { closeProcess, closeProcessMessage } from '../shared/closeProcess'

const en = (en: string, _fr: string) => en
const fr = (_en: string, fr: string) => fr
const idle = { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: 'zsh' }] }
it('recognizes an idle shell only with process-group evidence and a matching prompt attestation', () => {
  expect(closeProcess(idle, '10')).toEqual({ state: 'idle' })
  for (const info of [undefined, {}, { ...idle, foreground_processes: [] }, { ...idle, foreground_process_group_id: 20 }]) expect(closeProcess(info)).toEqual({ state: 'unknown' })
  expect(closeProcessMessage({ agent: null }, closeProcess(idle, '10'), en)).toBe('')
})
it.each(['npm run dev', 'ssh example.test', 'vim', 'bash script.sh'])('names the foreground command %s', command => {
  const state = closeProcess({ ...idle, foreground_process_group_id: 20, foreground_processes: [{ pid: 20, argv: command.split(' ') }] })
  expect(closeProcessMessage({ agent: null }, state, en)).toBe(`The running command “${command}” will be stopped.`)
  expect(closeProcessMessage({ agent: null }, state, fr)).toBe(`La commande en cours « ${command} » sera arrêtée.`)
})
it('uses a conditional warning when inspection is unavailable', () => {
  expect(closeProcessMessage({ agent: null }, { state: 'unknown' }, en)).toBe('Anything running in it will be stopped.')
})
it('preserves active agent behavior and inspects the shell of stopped agents', () => {
  expect(closeProcessMessage({ agent: 'codex' }, { state: 'unknown' }, en)).toBe('The process will be stopped.')
  expect(closeProcessMessage({ agent: 'codex', stopped: {} }, { state: 'idle' }, en)).toBe('')
  expect(closeProcessMessage({ agent: 'codex', stopped: {} }, { state: 'unknown' }, en)).toBe('Anything running in it will be stopped.')
})

it('keeps a conditional warning for blocking builtins and shells without hooks', () => {
  for (const token of [undefined, null, '', '9']) {
    const state = closeProcess(idle, token)
    expect(state).toEqual({ state: 'unknown' })
    expect(closeProcessMessage({ agent: null }, state, en)).toBe('Anything running in it will be stopped.')
  }
})
