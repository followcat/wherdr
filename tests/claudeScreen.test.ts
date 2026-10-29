// Long "!" command: the transcript only has it at the end, Claude Code's
// screen shows it running (bug t-0106: wherdr showed "En attente").
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { elapsedMs, parseClaudeNotice, parseClaudeScreen } from '../server/utils/claudeScreen'
import { queuedPhase } from '../shared/queuedPhase'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const NOW = 1_000_000

describe('Claude Code screen', () => {
  it('"!" command running: command, output, hidden lines, start', () => {
    const s = parseClaudeScreen(fx('claude-bash-running.txt'), NOW)!
    expect(s.shell).toEqual({
      command: './scripts/build.sh --all',
      lines: ['step 4 of 30', 'step 5 of 30', 'step 6 of 30', 'step 7 of 30'],
      hidden: 3,
      since: NOW - 7000,
    })
    expect(s.sent).toBe('!./scripts/build.sh --all')
    expect(s.queued).toEqual(['Résume la sortie du build'])
  })

  it('command without output yet: "Running… (7s)"', () => {
    const s = parseClaudeScreen(fx('claude-bash-starting.txt'), NOW)!
    expect(s.shell).toEqual({ command: 'sleep 12; echo fini', lines: [], hidden: 0, since: NOW - 7000 })
    expect(s.queued).toEqual([])
  })

  it('"! cmd" sent from wherdr: Claude shows "!  cmd" (two spaces)', () => {
    const s = parseClaudeScreen(fx('claude-bash-starting.txt').replace('! sleep', '!  sleep'), NOW)!
    expect(s.shell && s.shell.command).toBe('sleep 12; echo fini')
    expect(queuedPhase('! sleep 12; echo fini', s)).toBe('running')
  })

  it('long "!" command wrapped mid-word by the screen still matches the message sent (t-0242)', () => {
    // Real Claude Code 2.1 screen: the paths break at the line's end ("seg" / "ment10").
    const s = parseClaudeScreen(fx('claude-bash-wrapped.txt'), NOW)!
    expect(s.shell && s.shell.command).toContain('segment09-seg\nment10')
    const long = `/tmp/hwt0242/${Array.from({ length: 14 }, (_, i) => `segment${String(i).padStart(2, '0')}`).join('-')}/scripts/update-fork.sh`
    expect(queuedPhase(`! LOCK=/tmp/x.lock sleep 10; echo ${long} ${long}`, s)).toBe('running')
    expect(queuedPhase(`! LOCK=/tmp/x.lock sleep 10; echo ${long.replace('segment03', 'segment33')}`, s)).toBe('queued')
    // Narrow pane: the break falls within the first 80 characters compared.
    const narrow = parseClaudeScreen(fx('claude-bash-starting.txt').replace('! sleep 12; echo fini', '!  LOCK=/tmp/x.lock sh /work/tr\n  ees/project-a1b2c3/scripts/updat\n  e-fork.sh'), NOW)!
    expect(queuedPhase('! LOCK=/tmp/x.lock sh /work/trees/project-a1b2c3/scripts/update-fork.sh', narrow)).toBe('running')
  })

  it('command finished: no longer running, but sent', () => {
    const s = parseClaudeScreen(fx('claude-bash-finished.txt'), NOW)!
    expect(s.shell).toBeNull()
    expect(s.sent).toBe('!./scripts/build.sh --all')
  })

  it('normal turn: message sent (on two lines) and two queued messages', () => {
    const s = parseClaudeScreen(fx('claude-queued-turn.txt'), NOW)!
    expect(s.shell).toBeNull()
    expect(s.sent).toBe('Corrige le titre de la page\nd\'accueil, puis relance les tests')
    expect(s.queued).toEqual(['Ajoute aussi un test', 'Et mets à jour le changelog'])
    expect(s.sendNow).toBe(true)
    expect(parseClaudeScreen(fx('claude-queued-turn.txt').replace('ctrl+enter to send now', ''))?.sendNow).toBeUndefined()
    // A hint quoted earlier in the conversation does not advertise a current action.
    expect(parseClaudeScreen('  ctrl+enter to send now\n\n' + fx('claude-idle.txt'))?.sendNow).toBeUndefined()
  })

  it('existing screen without command or queue', () => {
    const s = parseClaudeScreen(fx('claude-working.txt'), NOW)!
    expect(s.shell).toBeNull()
    expect(s.queued).toEqual([])
    expect(parseClaudeScreen('', NOW)).toBeNull()
  })

  it('counter durations', () => {
    expect(elapsedMs('7s')).toBe(7000)
    expect(elapsedMs('1m 14s')).toBe(74000)
    expect(elapsedMs('1h 2m 3s')).toBe(3723000)
    expect(elapsedMs('bientôt')).toBeNull()
  })
})

describe('queued message against the screen', () => {
  const running = parseClaudeScreen(fx('claude-bash-running.txt'), NOW)
  const turn = parseClaudeScreen(fx('claude-queued-turn.txt'), NOW)
  const done = parseClaudeScreen(fx('claude-bash-finished.txt'), NOW)

  it('the "!" command sent is running, no longer queued', () => {
    expect(queuedPhase('! ./scripts/build.sh --all', running)).toBe('running')
    expect(queuedPhase('!./scripts/build.sh   --all', running)).toBe('running')
  })

  it('a message still in Claude\'s queue stays queued', () => {
    expect(queuedPhase('Résume la sortie du build', running)).toBe('queued')
    expect(queuedPhase('Ajoute aussi un test', turn)).toBe('queued')
    expect(queuedPhase('Et mets à jour le changelog', turn)).toBe('queued')
  })

  it('a message visible as sent is no longer "queued"', () => {
    expect(queuedPhase('Corrige le titre de la page d\'accueil, puis relance les tests', turn)).toBe('sent')
    // Command finished, not yet in the transcript.
    expect(queuedPhase('! ./scripts/build.sh --all', done)).toBe('sent')
  })

  it('no confusion: other text, start too short, command ≠ message', () => {
    expect(queuedPhase('Corrige', turn)).toBe('queued')
    expect(queuedPhase('! ./scripts/deploy.sh', running)).toBe('queued')
    expect(queuedPhase('./scripts/build.sh --all', running)).toBe('queued')
    expect(queuedPhase('Lance les tests unitaires', running)).toBe('queued')
    expect(queuedPhase('Lance les tests', null)).toBe('queued')
  })

  it('photos: the paths sent do not count, nor does "[Image #1]"', () => {
    const s = { shell: null, sent: '[Image #1] Que vois-tu sur cette capture ?', queued: [] }
    expect(queuedPhase('/home/user/.cache/herdr-web/uploads/a.png\nQue vois-tu sur cette capture ?', s)).toBe('sent')
  })
})

describe('parseClaudeNotice', () => {
  const screen = (foot: string) => [
    ' ▐▛███▜▌   Claude Code',
    '',
    '❯ /clear',
    '',
    '─'.repeat(40),
    '❯ ',
    '─'.repeat(40),
    foot,
  ].join('\n')
  it('reads "Update installed" on the right of the footer', () => {
    expect(parseClaudeNotice(screen('  ? for shortcuts                 ✔ Update installed · Restart to update'))).toBe('✔ Update installed · Restart to update')
  })
  it('lit le statut au-dessus du cadre', () => {
    const s = ['❯ /clear', '                ✔ Update installed · Restart to update', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n')
    expect(parseClaudeNotice(s)).toBe('✔ Update installed · Restart to update')
  })
  it('ignore un statut inconnu ou absent', () => {
    expect(parseClaudeNotice(screen('  ? for shortcuts'))).toBeNull()
    expect(parseClaudeNotice(null)).toBeNull()
  })
})
