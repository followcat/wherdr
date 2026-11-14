import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STATUS_SCRIPT, awakeWarning, controlScript, inhibitorLaunch, parseAwakeStatus, parseControl } from '../shared/awake'

describe('keep awake: command and state', () => {
  it('builds the inhibitor per platform, detached from the exec that starts it', () => {
    expect(inhibitorLaunch('mac', true)).toMatch(/POSIX::setsid\(\).*exec @ARGV' caffeinate -i -s -t "\$seconds"$/)
    expect(inhibitorLaunch('mac', false)).toMatch(/caffeinate -i -s$/)
    expect(inhibitorLaunch('linux', true)).toContain('systemd-run --user --quiet --collect --unit="$u" -- systemd-inhibit --what=idle:sleep --who=wherdr --why="Keep awake" sleep "$seconds"')
    expect(inhibitorLaunch('linux', false)).toContain('sleep infinity')
    expect(inhibitorLaunch('linux', false)).toContain('systemctl --user show -p MainPID --value "$u"')
    expect(inhibitorLaunch('other', true)).toBe('false')
  })
  it('reads the recorded inhibitor, the battery and the lid', () => {
    expect(parseAwakeStatus('platform=mac\nawake=123|1727500000\n')).toMatchObject({ supported: true, active: true, until: 1727500000000 })
    expect(parseAwakeStatus('platform=linux\nawake=123|0\ninhibit=1\n')).toMatchObject({ supported: true, active: true, until: null, battery: null, lidClosed: null })
    expect(parseAwakeStatus('platform=linux\n')).toMatchObject({ supported: false, active: false })
    expect(parseAwakeStatus("platform=mac\nNow drawing from 'Battery Power'\n -InternalBattery-0 43%; discharging\nlid=closed\n"))
      .toMatchObject({ battery: { percent: 43, source: 'battery' }, lidClosed: true })
    expect(parseAwakeStatus('platform=linux\ninhibit=1\nbattery=87\nac=1\n')).toMatchObject({ battery: { percent: 87, source: 'ac' }, lidClosed: false })
    expect(parseAwakeStatus('platform=mac\nclock=1959\n').eveningPast).toBe(false)
    expect(parseAwakeStatus('platform=mac\nclock=2000\n').eveningPast).toBe(true)
  })
  it('warns a laptop on battery only', () => {
    const s = parseAwakeStatus('platform=linux\ninhibit=1\nbattery=50\nac=0\n')
    expect(awakeWarning(s)).toBe('On battery: closing the lid puts it to sleep')
    expect(awakeWarning({ ...s, lidClosed: true })).toBe('Lid closed on battery: this machine will sleep')
    expect(awakeWarning(parseAwakeStatus('platform=linux\nbattery=50\nac=1\n'))).toBe('')
    expect(awakeWarning(parseAwakeStatus('platform=linux\n'))).toBe('')
  })
})

// The real scripts (macOS launch: real perl, a fake caffeinate) in a temporary HOME.
let root: string, home: string, bin: string, log: string
let spawned: number[] = []
const pidFile = () => join(home, '.cache/herdr-web/awake.pid')
const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: home })
function control(mode: string) {
  const out = execFileSync('sh', ['-c', controlScript('mac'), 'sh', mode], { env: env(), encoding: 'utf8' })
  const pid = Number(/^started=(\d+)$/m.exec(out)?.[1])
  if (pid) spawned.push(pid)
  return out
}
const started = (mode: string) => (parseControl(control(mode)) as { started: number }).started
const status = () => parseAwakeStatus(execFileSync('sh', ['-c', STATUS_SCRIPT], { env: env(), encoding: 'utf8' }))
function alive(pid: number) {
  try { process.kill(pid, 0) }
  catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) }
  catch { return true }
}
async function gone(pid: number) {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100))
  return !alive(pid)
}
const events = () => readFileSync(log, 'utf8').trim().split('\n')

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/perl'))('keep awake: our inhibitor', { timeout: 20000 }, () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'awake-'))
    home = join(root, 'home'); bin = join(root, 'bin'); log = join(root, 'events.log')
    mkdirSync(home); mkdirSync(bin); writeFileSync(log, '')
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n'); chmodSync(join(bin, 'uname'), 0o755)
    writeFileSync(join(bin, 'caffeinate'), `#!/bin/sh\necho "start $$" >> "${log}"; trap 'echo "stop $$" >> "${log}"; kill $! 2>/dev/null; exit 0' TERM; sleep 30 & wait\n`)
    chmodSync(join(bin, 'caffeinate'), 0o755)
  })
  afterEach(async () => {
    for (const pid of spawned) { try { process.kill(pid) } catch {} }
    for (const pid of spawned) await gone(pid)
    spawned = []
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('re-arming starts the new inhibitor before stopping the old one', async () => {
    const a = started('fourHours')
    const b = started('hour')
    expect(b).not.toBe(a)
    await gone(a)
    expect(events()).toEqual([`start ${a}`, `start ${b}`, `stop ${a}`])
    const s = status()
    expect(s.active).toBe(true)
    expect(Math.round((s.until! - Date.now()) / 1000)).toBeGreaterThan(3590)
  })

  it('extends by one hour, and only an active timed inhibitor', () => {
    expect(parseControl(control('extend'))).toEqual({ error: 'not_active' })
    started('hour')
    const before = status().until!
    started('extend')
    expect(Math.abs(status().until! - (before + 3600_000))).toBeLessThanOrEqual(2000)
  })

  it('does not adopt a recycled PID started at another time, nor kill it', () => {
    const a = started('hour')
    writeFileSync(pidFile(), `${a}|0|0|999\n`)
    expect(status().active).toBe(false)
    writeFileSync(pidFile(), `${a}|0|0|999\n`)
    control('off')
    expect(alive(a)).toBe(true)
  })

  it('turns off by exact PID, and a dead one reads as not awake', async () => {
    const a = started('untilOff')
    expect(status()).toMatchObject({ active: true, until: null })
    expect(control('off')).toContain('stopped')
    expect(await gone(a)).toBe(true)
    expect(status().active).toBe(false)
    const b = started('hour')
    process.kill(b)
    expect(await gone(b)).toBe(true)
    expect(status().active).toBe(false)
    expect(existsSync(pidFile())).toBe(false)
  })
})
