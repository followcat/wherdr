import { REPO } from './site'

// What the v3 installer prints for its plan on a Linux machine that runs
// wherdr v2 (scripts/install-v3-beside-v2.mjs, its say / OK / PLAN lines),
// replayed by InstallTerminal. Versions, commits and names are examples.
// `wait` is the pause before the line shows, in ms.
export type InstallLine = { kind: 'blank' | 'title' | 'step' | 'ok' | 'say' | 'strong' | 'dim', text: string, wait: number }
// A command typed at `prompt`; `fast` types it quicker (ssh, short commands).
export type CommandLine = { kind: 'cmd', prompt: string, text: string, wait: number, fast?: boolean }
export type TermLine = InstallLine | CommandLine
export type TermDemo = { title: string, lines: TermLine[] }

const SETUP = '/tmp/wherdr-setup'
export const CLONE_COMMAND = `git clone -b v3 ${REPO}.git ${SETUP}`
export const PLAN_COMMAND = `sh ${SETUP}/scripts/install-v3-beside-v2.sh`
// By hand: clone, then read the plan; the same command with --yes applies it.
export const INSTALL_COMMANDS = [CLONE_COMMAND, PLAN_COMMAND]

const HOME = '/home/you'
const PROMPT = 'you@devbox:~$'

export const PLAN_OUTPUT: InstallLine[] = [
  { kind: 'say', text: 'v2 install: found', wait: 500 },
  { kind: 'dim', text: '  service: wherdr.service (running)', wait: 80 },
  { kind: 'dim', text: `  data: ${HOME}/wherdr/data (12 files), port 7683`, wait: 80 },
  { kind: 'dim', text: '  Herdr SSH machines: laptop (you@laptop)', wait: 80 },
  { kind: 'say', text: 'OK prerequisites: node v22.20.0, git, npm, systemd --user, hc 0.4.2', wait: 700 },
  { kind: 'say', text: `PLAN start herdr-core session "default" as wherdr-v3-hc.service`, wait: 400 },
  { kind: 'say', text: `PLAN clone ${REPO} (v3 at 1a2b3c4) into ${HOME}/wherdr-v3/src`, wait: 120 },
  { kind: 'say', text: 'PLAN npm ci && npm run build, swapped in once built', wait: 120 },
  { kind: 'say', text: `PLAN import from v2 into ${HOME}/wherdr-v3/data (v2 is only read)`, wait: 120 },
  { kind: 'dim', text: '  machines to add: laptop (you@laptop)', wait: 80 },
  { kind: 'dim', text: '  projects: 2 on the v2 board: Alfred offers them at its first start', wait: 80 },
  { kind: 'say', text: 'PLAN start wherdr-v3.service on 127.0.0.1:7684', wait: 120 },
  { kind: 'say', text: 'PLAN tailscale serve --bg --https=8104 127.0.0.1:7684 (added beside the existing entries)', wait: 120 },
  { kind: 'say', text: `PLAN write ${HOME}/wherdr-v3/update.sh`, wait: 120 },
  { kind: 'blank', text: '', wait: 120 },
  { kind: 'strong', text: 'Dry run: nothing changed. Run again with --yes to apply.', wait: 200 },
]

// The plan, on the Linux machine that runs v2.
export const PLAN_DEMO: TermDemo = {
  title: 'you@devbox — bash',
  lines: [
    { kind: 'cmd', prompt: PROMPT, text: CLONE_COMMAND, wait: 300, fast: true },
    { kind: 'dim', text: `Cloning into '${SETUP}'...`, wait: 600 },
    { kind: 'cmd', prompt: PROMPT, text: PLAN_COMMAND, wait: 400, fast: true },
    ...PLAN_OUTPUT,
  ],
}
