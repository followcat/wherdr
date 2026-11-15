<script setup lang="ts">
// The landing page (`/`): dotted background grid with travelling packets,
// live demos in the hero (phone + desktop on one clock) and next to the
// feature stories, and an install that types itself.
import { AGENT_PROMPT, DISCORD, REPO } from '~/utils/site'
import { BREW_COMMANDS, INSTALL_COMMAND, ONE_COMMAND_DEMO, PLUGIN_COMMAND, RUNNERS } from '~/utils/installDemo'
import { SITE_URL, softwareApplication } from '~/utils/seo'

// Only this page is the site's address for search engines: the generated
// 404 page shares the rest of the head (nuxt.config.ts) but not these.
useHead({
  link: [{ rel: 'canonical', href: `${SITE_URL}/` }],
  meta: [{ property: 'og:url', content: `${SITE_URL}/` }],
  // "<" escaped: nothing in the data can close the script element.
  script: [{ type: 'application/ld+json', innerHTML: JSON.stringify(softwareApplication()).replace(/</g, '\\u003c') }],
})

const stories = [
  {
    id: 'conversation',
    label: 'Conversation · terminal',
    title: 'The real transcript. The real terminal.',
    text: 'wherdr reads each agent\'s own transcript — Claude Code, Codex, omp — and renders it as clean Markdown with grouped tool calls, images and search. Switch to the live terminal (xterm.js) to take over. Reading never resizes a pane.',
    points: ['Composer with queue, attachments and slash commands', 'Model and effort pickers, for the current session only', 'Copy or run the commands the agent proposes'],
  },
  {
    id: 'phone',
    label: 'Phone · notifications',
    title: 'Your turn? Answer in one tap.',
    text: 'Install wherdr on your phone as a PWA. A push tells you when an agent finishes or needs you, with its question and options. Answer right from the agent list, without opening the conversation.',
    points: ['Web Push when an agent is done or blocked, and for herdr notification show', 'Do not disturb, per device or for all', 'Offline reading of recent conversations'],
  },
] as const

// What sets wherdr apart, in five lines. Each one is detailed further down the page.
const why = [
  { k: 'SPLITS', title: 'Herdr\'s splits, live', text: 'A tab with several panes is drawn in Herdr\'s real layout, every pane live. Drag a pane to move it or a divider to resize: the change goes to Herdr itself.' },
  { k: 'LOCK', title: 'A passkey lock', text: 'Face ID, Touch ID, Windows Hello or Android unlock the app. Once a passkey exists, nothing about your agents is served to a locked session.' },
  { k: 'DIFF', title: 'The agent\'s diff', text: 'Git status and diff of each agent\'s working folder, one click away from its conversation.' },
  { k: 'KEYS', title: 'Keyboard and global search', text: 'One shortcut searches every agent and conversation. Next agent, new tab, pane swaps and 1–9 answers never need the mouse.' },
  { k: 'LIVE', title: 'Real time, and private', text: 'The real terminal over a WebSocket, a push when an agent needs you, and your phone through Tailscale. Nothing is on the Internet.' },
]

const features = [
  { icon: 'i-lucide-columns-2', title: 'Split panes, live', text: 'Herdr\'s real layout on a computer: every pane live, drag to move, drag a divider to resize.' },
  { icon: 'i-lucide-server', title: 'Several machines', text: 'Agents of the SSH machines registered in Herdr appear in their own section. Same features, remote.' },
  { icon: 'i-lucide-gauge', title: 'Claude & Codex quotas', text: '5-hour window and week, with reset times, for every online machine.' },
  { icon: 'i-lucide-git-branch', title: 'New agent, new worktree', text: 'Pick an agent, a folder, optionally a Git worktree and branch, and queue the first message.' },
  { icon: 'i-lucide-file-diff', title: 'Changes view', text: 'Git status and diff of an agent\'s working folder, worktree management.' },
  { icon: 'i-lucide-keyboard', title: 'Keyboard first', text: 'Global search, next agent, new tab, pane swaps, 1–9 to answer. Everything without the mouse.' },
  { icon: 'i-lucide-fingerprint', title: 'Passkey lock', text: 'Face ID, Touch ID, Windows Hello, Android. Unlock lasts as long as you choose, devices can be locked remotely.' },
  { icon: 'i-lucide-palette', title: 'Themes, compact list', text: 'wherdr Titanium, herdr.dev, Herdr\'s own themes or follow Herdr. English and French.' },
  { icon: 'i-lucide-puzzle', title: 'Herdr plugins', text: 'Actions declared by your installed Herdr plugins show up in the menus.' },
]

const security = [
  { k: 'NET', title: 'Private network only', text: 'wherdr listens on 127.0.0.1. Reach it from your devices through Tailscale Serve — never a public route, port forward or tunnel.' },
  { k: 'KEY', title: 'Passkey lock', text: 'Once a passkey exists, the API, images and WebSockets need an unlocked session. Lock every device in one tap.' },
  { k: 'LOCAL', title: 'Nothing in the cloud', text: 'No account, no telemetry, no hosted service. wherdr talks to the Herdr socket on your server and reads transcripts read-only.' },
  { k: 'CSP', title: 'Strict by default', text: 'Host allow-list, Origin checks on every write and WebSocket, strict Content Security Policy, no framing.' },
]

// Other install methods, after the recommended agent prompt and the installer.
const installTabs = [
  { id: 'pm', label: 'Package managers', short: 'Packages' },
  { id: 'plugin', label: 'Herdr plugin', short: 'Plugin' },
] as const
const tab = ref<typeof installTabs[number]['id']>('pm')
const managers = [
  { id: 'brew', label: 'Homebrew' },
  { id: 'npx', label: 'npx' },
  { id: 'bunx', label: 'bunx' },
  { id: 'pnpm', label: 'pnpm dlx' },
] as const
const pm = ref<typeof managers[number]['id']>('brew')
const runner = computed(() => pm.value === 'brew' ? null : RUNNERS[pm.value])

const faq = [
  { label: 'Is wherdr free?', content: 'Yes. It is open source under the MIT license, with no account, no paid plan and no hosted version. You run it on your own machine.' },
  { label: 'What do I need?', content: 'Herdr 0.9.1 or newer running on a Mac or a Linux machine, and Node.js 22: the installer offers to install it when it is missing (Homebrew, or the official build in ~/wherdr/node, no sudo). For your phone: a private HTTPS address, which Tailscale Serve gives you in one command.' },
  { label: 'Can I put it on the Internet?', content: 'No. wherdr is a remote shell on your machine: whoever reaches it can start agents and run commands as your user. Use it on localhost or over a private network such as Tailscale, and enable the passkey lock.' },
  { label: 'Does my code or my conversations leave my machine?', content: 'No. wherdr reads the agents\' transcript files and the Herdr socket locally and serves them to your own devices. Push notifications travel through your browser\'s push service, encrypted as the Web Push standard requires. The only other outgoing request is an optional daily check of the latest GitHub release (WHERDR_UPDATE_CHECK=off disables it).' },
  { label: 'Which agents are supported?', content: 'Every agent Herdr recognizes appears in the list with its terminal. Claude Code, Codex and omp also get the full conversation view, model and effort pickers and one-tap answers.' },
  { label: 'Does it work on macOS?', content: 'Yes, natively, with the same one command: it installs the wherdr Herdr plugin, which runs wherdr with Node.js and starts it at login with a LaunchAgent.' },
  { label: 'Will it change my agents\' settings?', content: 'No. Model and effort changes apply to the current session only; wherdr never changes your default model or your agents\' configuration.' },
  { label: 'Is it an official Herdr project?', content: 'No. wherdr is an independent project built on Herdr\'s public socket API. It is not affiliated with Herdr, Anthropic or OpenAI.' },
]
</script>

<template>
  <div id="top">
    <SiteHeader />

    <main>
      <!-- ============================================================ HERO -->
      <section class="hero">
        <GridBackground />
        <div class="wrap hero-in">
          <div class="hero-copy">
            <p class="label eyebrow">
              <span class="dot" aria-hidden="true" /> Self-hosted · open source · MIT
            </p>
            <h1 class="display hero-title">
              Your coding agents.<br>
              <span class="acc"><EncryptedText text="Wherever you are." :delay="250" :duration="1300" /></span>
            </h1>
            <p class="lead">
              wherdr is a web app and phone PWA for the agents running in <a href="https://herdr.dev" target="_blank" rel="noopener">Herdr</a>
              on your machines — <b>Claude Code, Codex, omp</b> and more. Read their work, answer their questions,
              take over their terminal. From your laptop or your pocket, over your own private network.
            </p>
            <div class="hero-ctas">
              <a class="btn primary" href="#install">Ask your AI agent <UIcon name="i-lucide-arrow-right" class="size-4" /></a>
              <a class="btn" href="/demo/"><UIcon name="i-lucide-play" class="size-4" /><span>Try it in your browser<span class="demo-install-note"> — no install</span></span></a>
              <a class="btn" :href="REPO" target="_blank" rel="noopener"><GithubMark /> Star on GitHub</a>
            </div>
            <p class="hero-note label">macOS and Linux · needs Herdr ≥ 0.9.1 · phone through Tailscale</p>
          </div>

          <div class="hero-visual">
            <BrowserFrame class="hv-desk" alt="wherdr on a computer, on the same session as the phone: agent sidebar with live states, the conversation and the message field">
              <DesktopDemo />
            </BrowserFrame>
            <div class="hv-phone">
              <PhoneFrame alt="wherdr on a phone: a message is sent, the agent works in its console, then asks a question with numbered answers">
                <PhoneDemo />
              </PhoneFrame>
            </div>
          </div>
        </div>

        <div class="wrap">
          <WorksWith class="agents-band" />
        </div>
      </section>

      <!-- ============================================================== WHY -->
      <section id="why" class="section">
        <div class="wrap why-wrap">
          <div v-reveal class="section-head">
            <p class="label"><span class="k">01</span> Why wherdr</p>
            <h2 class="display h2">Herdr, whole.<br>In a browser.</h2>
            <p class="lead">The layout, the terminal and the diff of your Herdr session, behind your own lock.</p>
          </div>
          <ul v-reveal class="why">
            <li v-for="w in why" :key="w.k" class="why-row">
              <span class="why-k">[ {{ w.k }} ]</span>
              <div>
                <h3 class="cell-title">{{ w.title }}</h3>
                <p class="cell-text">{{ w.text }}</p>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <!-- ========================================================= FEATURES -->
      <section id="features" class="section">
        <div class="wrap">
          <div v-reveal class="section-head">
            <p class="label"><span class="k">02</span> Features</p>
            <h2 class="display h2">A full workspace on a computer.<br>A companion in your pocket.</h2>
            <p class="lead">Same Herdr session, same agents, nothing copied. On a computer wherdr can replace the terminal client day to day; on a phone it follows your agents while you are away.</p>
          </div>

          <article v-for="(s, i) in stories" :id="s.id" :key="s.id" v-reveal class="story" :class="{ flip: i % 2 === 1, phones: s.id === 'phone' }">
            <div class="story-copy">
              <p class="label"><span class="k">2.{{ i + 1 }}</span> {{ s.label }}</p>
              <h3 class="display story-title">{{ s.title }}</h3>
              <p class="story-text">{{ s.text }}</p>
              <ul class="ticks">
                <li v-for="p in s.points" :key="p">{{ p }}</li>
              </ul>
            </div>
            <div class="story-shot">
              <BrowserFrame v-if="s.id === 'conversation'" alt="wherdr on a computer: grouped tool calls unfold, the effort picker switches to high, the proposed command is copied and run in the live terminal">
                <ConversationDemo />
              </BrowserFrame>
              <div v-else class="duo">
                <PhoneFrame alt="Lock screen: a wherdr notification says the agent needs you, with its question and options, then that it is done">
                  <NotifyDemo />
                </PhoneFrame>
                <PhoneFrame alt="wherdr's agent list on a phone: the question's options are on the agent's card, one tap answers and the agent goes back to work">
                  <AgentListDemo />
                </PhoneFrame>
              </div>
            </div>
          </article>

          <div v-reveal class="cells">
            <div v-for="(f, i) in features" :key="f.title" class="cell">
              <div class="cell-top">
                <UIcon :name="f.icon" class="size-5 cell-icon" />
                <span class="label">2.{{ stories.length + i + 1 }}</span>
              </div>
              <h3 class="cell-title">{{ f.title }}</h3>
              <p class="cell-text">{{ f.text }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ===================================================== HOW IT WORKS -->
      <section id="how" class="section">
        <div class="wrap">
          <div v-reveal class="section-head">
            <p class="label"><span class="k">03</span> How it works</p>
            <h2 class="display h2">Next to Herdr. Never in between.</h2>
            <p class="lead">wherdr runs on the same machine as the Herdr server. It uses Herdr's local socket API and CLI, reads the agents' transcript files, and serves the app to your devices through your private network. Your other computers join through Herdr's SSH machines.</p>
          </div>
          <FlowDiagram v-reveal />
          <div v-reveal class="how-notes">
            <div><p class="label"><span class="k">→</span> Gateway</p><p>Nitro server: API, WebSockets, Web Push and lock, on 127.0.0.1:7683.</p></div>
            <div><p class="label"><span class="k">→</span> Read-only</p><p>Transcripts of <code>~/.claude</code>, <code>~/.codex</code>, <code>~/.omp</code> are read, never written.</p></div>
            <div><p class="label"><span class="k">→</span> Passive client</p><p>Notifications come from Herdr's client socket without resizing anything.</p></div>
          </div>
        </div>
      </section>

      <!-- ========================================================= SECURITY -->
      <section id="security" class="section">
        <div class="wrap">
          <div v-reveal class="section-head">
            <p class="label"><span class="k">04</span> Security</p>
            <h2 class="display h2">It is a shell on your machine.<br>It is treated like one.</h2>
            <p class="lead">Anyone who reaches wherdr can drive your agents as your user. So it stays on your private network, behind a passkey, with nothing in the cloud.</p>
          </div>
          <div v-reveal class="sec-grid">
            <div v-for="s in security" :key="s.k" class="sec">
              <span class="sec-k">[ {{ s.k }} ]</span>
              <h3 class="cell-title">{{ s.title }}</h3>
              <p class="cell-text">{{ s.text }}</p>
            </div>
          </div>
          <p v-reveal class="warn">
            <span class="label">Never</span>
            port forwarding · public reverse proxy · ngrok · <code>tailscale funnel</code> · Cloudflare Tunnel without Access
          </p>
        </div>
      </section>

      <!-- ========================================================== INSTALL -->
      <section id="install" class="section">
        <div class="wrap">
          <div v-reveal class="section-head">
            <p class="label"><span class="k">05</span> Install</p>
            <h2 class="display h2">Set up wherdr.</h2>
          </div>

          <div v-reveal class="install">
            <div class="panel agent">
              <p class="label agent-note">Recommended</p>
              <h3 class="label agent-label"><UIcon name="i-lucide-sparkles" class="size-3.5" /> Ask your AI agent</h3>
              <p class="agent-text">Paste this into Claude Code, Codex or any coding agent: it installs and sets up wherdr for you.</p>
              <InstallCommand :command="AGENT_PROMPT" prompt="›" what="prompt" wrap big />
              <p class="agent-note">It follows <a href="/agent.md" target="_blank">our setup guide for agents</a>: checks what you already have, asks before installing anything, sets up your phone over Tailscale, never exposes wherdr to the Internet.</p>
            </div>

            <div aria-labelledby="installer-title" class="panel one">
              <h3 id="installer-title" class="cell-title">Or run the installer yourself</h3>
              <p class="cell-text">On the computer that runs Herdr — your Mac, or an always-on Linux box (a Raspberry Pi works). It installs the wherdr Herdr plugin with the verified GitHub release: wherdr in <code>~/wherdr</code>, listening on 127.0.0.1 only, running as your user and started at login on macOS (LaunchAgent), or at boot on Linux when lingering is enabled (otherwise at login, with a systemd user service). No Node.js 22? It offers to install it. No sudo, and a wherdr that already runs is never replaced. Run it again to update. <a href="/install" target="_blank">Read the script first.</a></p>
              <InstallCommand :command="INSTALL_COMMAND" />
              <InstallTerminal :demo="ONE_COMMAND_DEMO" />
              <p class="prereq">
                Needs <a href="https://herdr.dev" target="_blank" rel="noopener">Herdr</a> 0.9.1+ <span class="sep" aria-hidden="true">·</span> macOS or Linux <span class="sep" aria-hidden="true">·</span> phone through <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a>.
                <a :href="`${REPO}/blob/main/docs/networks.md#other-private-networks`" target="_blank" rel="noopener">Other private networks</a>.
              </p>
            </div>

            <p class="or"><span>Other methods</span></p>
            <p class="cell-text other-note">The same app from npm or Homebrew. npm can hold a new release for up to two days: the installer gets it from GitHub at once.</p>
            <div class="tabs" role="tablist" aria-label="Installation methods">
              <button v-for="t in installTabs" :id="`tab-${t.id}`" :key="t.id" type="button" role="tab" class="tab" :aria-label="t.label" :aria-selected="tab === t.id" :aria-controls="`panel-${t.id}`" @click="tab = t.id">
                <span class="tab-long">{{ t.label }}</span><span class="tab-short" aria-hidden="true">{{ t.short }}</span>
              </button>
            </div>

            <div v-show="tab === 'pm'" id="panel-pm" role="tabpanel" aria-labelledby="tab-pm" class="panel">
              <div class="pills" role="radiogroup" aria-label="Package manager">
                <button v-for="p in managers" :key="p.id" type="button" role="radio" class="pill" :aria-checked="pm === p.id" @click="pm = p.id">{{ p.label }}</button>
              </div>
              <template v-if="pm === 'brew'">
                <InstallCommand :command="BREW_COMMANDS.join('\n')" what="commands" wrap />
                <ol class="steps">
                  <li><b>Install</b> on the machine that runs Herdr, macOS or Linux. The first install also brings Homebrew's Node.js; the package is prebuilt, nothing compiles.</li>
                  <li><b>Start it:</b> <code>brew services start wherdr</code> runs it now and at every login; <code>wherdr open</code> opens the setup guide.</li>
                  <li><b>Update:</b> <code>brew upgrade wherdr</code>, then <code>brew services restart wherdr</code>. Stuck? <code>wherdr doctor</code>.</li>
                </ol>
              </template>
              <template v-if="runner">
                <InstallCommand :command="runner.run" />
                <ol class="steps">
                  <li><b>Try it</b> on the machine that runs Herdr, macOS or Linux, with Node.js 22{{ pm === 'bunx' ? ' or Bun' : '' }}. The package is prebuilt: nothing compiles. Open <code>http://localhost:7683</code>.</li>
                  <li><b>Keep it:</b> <code>{{ runner.keep }}</code>, then <code>wherdr service install</code> configures startup: at login on macOS; at boot on Linux with lingering enabled, otherwise at login.</li>
                  <li><b>Stuck?</b> <code>wherdr doctor</code> checks Node, Herdr and its socket, the port and the service.</li>
                </ol>
              </template>
            </div>

            <div v-show="tab === 'plugin'" id="panel-plugin" role="tabpanel" aria-labelledby="tab-plugin" class="panel">
              <InstallCommand :command="PLUGIN_COMMAND" />
              <ol class="steps">
                <li><b>Run it</b> on the machine that runs Herdr (≥ 0.9.1): what the one command does, minus its checks. It installs wherdr in <code>~/wherdr</code> with Node.js 22 (no sudo), starts it with Herdr and, the first time, opens its setup guide. <b>A</b> in its panel adds the login service.</li>
                <li><b>Press <code>prefix+i</code></b> in Herdr: the wherdr panel — start, stop, log, update, phone.</li>
              </ol>
            </div>

            <div class="as-app">
              <p class="as-app-title">Install it as an app</p>
              <ul class="as-app-list">
                <li><b>iPhone</b><span>Safari › Share › Add to Home Screen <span class="as-app-note">(needed for notifications)</span></span></li>
                <li><b>Android</b><span>Chrome › menu › Install app</span></li>
                <li><b>Mac, Safari</b><span>File › Add to Dock <span class="as-app-note">(macOS 14+)</span></span></li>
                <li><b>Chrome · Edge · Brave</b><span>install icon in the address bar</span></li>
                <li><b>Arc</b><span>cannot install web apps: use Safari or Chrome for this</span></li>
              </ul>
            </div>

            <p class="install-foot">
              Full guide, configuration and troubleshooting in the <a :href="`${REPO}/blob/main/docs/README.md`" target="_blank" rel="noopener">documentation</a>.
            </p>
          </div>
        </div>
      </section>

      <!-- ============================================================== FAQ -->
      <section id="faq" class="section">
        <div class="wrap faq-wrap">
          <div v-reveal class="section-head">
            <p class="label"><span class="k">06</span> FAQ</p>
            <h2 class="display h2">Questions.</h2>
          </div>
          <UAccordion v-reveal :items="faq" type="multiple" class="faq" :ui="{ item: 'faq-item', trigger: 'faq-trigger', label: 'faq-label', body: 'faq-body' }" />
        </div>
      </section>

      <!-- ============================================================== CTA -->
      <section class="section cta">
        <GridBackground />
        <div v-reveal class="wrap cta-in">
          <PixelMark class="cta-logo" />
          <h2 class="display h2">Follow your agents from anywhere.</h2>
          <p class="lead">Free and open source. Watch the repository to hear about new releases.</p>
          <div class="hero-ctas">
            <a class="btn primary" :href="REPO" target="_blank" rel="noopener"><GithubMark /> Star on GitHub</a>
            <a class="btn" :href="`${REPO}/releases`" target="_blank" rel="noopener">Releases</a>
          </div>
        </div>
      </section>
    </main>

    <footer class="foot">
      <div class="wrap foot-in">
        <div class="foot-brand">
          <PixelMark class="foot-logo" :boot="false" :glow="false" />
          <span>wherdr</span>
        </div>
        <nav class="foot-links" aria-label="Links">
          <a :href="REPO" target="_blank" rel="noopener">GitHub</a>
          <a :href="DISCORD" target="_blank" rel="noopener">Community: Discord</a>
          <a :href="`${REPO}/blob/main/LICENSE`" target="_blank" rel="noopener">MIT license</a>
          <a :href="`${REPO}/blob/main/SECURITY.md`" target="_blank" rel="noopener">Security policy</a>
          <a href="https://herdr.dev" target="_blank" rel="noopener">Herdr</a>
        </nav>
        <p class="foot-note">
          Unofficial project, not affiliated with or endorsed by Herdr, Anthropic or OpenAI. Claude, Claude Code, Codex and other product names are trademarks of their respective owners.
        </p>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------- hero */
.hero { position: relative; overflow: hidden; padding: clamp(48px, 8vw, 96px) 0 48px; }
.hero-in { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: clamp(32px, 4vw, 64px); align-items: center; }
.eyebrow { display: inline-flex; align-items: center; gap: 10px; margin: 0 0 24px; padding: 6px 12px; border: 1px solid var(--line-strong); background: var(--bg-2); }
.dot { width: 7px; height: 7px; background: var(--green); box-shadow: 0 0 8px var(--green); }
.hero-title { font-size: clamp(42px, 5.4vw, 80px); margin-bottom: 28px; }
.acc { color: var(--accent); }
.hero-copy .lead { margin: 0 0 32px; }
.lead a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
.hero-ctas { display: flex; flex-wrap: wrap; gap: 12px; }
.hero-ctas .btn { max-width: 100%; white-space: normal; }
.hero-ctas .btn :deep(.iconify) { flex-shrink: 0; }
.hero-note { margin: 24px 0 0; font-size: 11px; color: var(--dim); }
.hero-visual { position: relative; padding-bottom: 40px; }
.hv-desk { width: 100%; }
.hv-phone { position: absolute; right: -18px; bottom: 0; width: 34%; max-width: 230px; }
.agents-band { margin-top: 56px; }

/* --------------------------------------------------------------- why */
.why-wrap { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); gap: clamp(32px, 5vw, 72px); align-items: start; }
.why-wrap .section-head { margin-bottom: 0; position: sticky; top: 100px; }
.why { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
.why-row { display: grid; grid-template-columns: 11ch minmax(0, 1fr); gap: 4px 24px; align-items: baseline; padding: 22px 0; border-bottom: 1px solid var(--line); }
.why-k { font: 600 12px/1.6 var(--mono); letter-spacing: .1em; color: var(--accent); white-space: nowrap; }
.why-row .cell-title { margin-bottom: 6px; }

/* ----------------------------------------------------------- stories */
.story { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); gap: clamp(32px, 5vw, 72px); align-items: center; padding: clamp(40px, 6vw, 72px) 0; border-top: 1px solid var(--line); }
.story.flip .story-copy { order: 2; }
.story.phones { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.story-title { font-size: clamp(28px, 3.4vw, 42px); margin: 16px 0 18px; }
.story-text { color: var(--muted); margin: 0 0 22px; font-size: 17px; }
.ticks { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.ticks li { position: relative; padding-left: 22px; font: 13px/1.5 var(--mono); color: var(--text); }
.ticks li::before { content: ''; position: absolute; left: 0; top: .5em; width: 8px; height: 8px; border: 1px solid var(--accent); }
.duo { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(16px, 3vw, 32px); max-width: 560px; margin: 0 auto; }
.duo > :last-child { transform: translateY(48px); }

/* ------------------------------------------------------------- cells */
.cells { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: clamp(40px, 6vw, 72px); border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
.cell { padding: 28px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); transition: background .2s; }
.cell:hover { background: var(--surface); }
.cell-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
.cell-icon { color: var(--accent); }
.cell-title { margin: 0 0 8px; font: 700 18px/1.3 var(--display); color: #fff; letter-spacing: -0.01em; }
.cell-text { margin: 0; color: var(--muted); font-size: 15px; }
.cell-text :deep(code), code { font-size: .88em; color: var(--text); background: var(--surface); border: 1px solid var(--line); padding: 1px 5px; }

/* ------------------------------------------------------------- how */
.how-notes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; margin-top: 40px; }
.how-notes p { margin: 0; }
.how-notes p + p { margin-top: 10px; color: var(--muted); font-size: 15px; }

/* ---------------------------------------------------------- security */
.sec-grid { display: grid; grid-template-columns: repeat(4, 1fr); border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
.sec { padding: 28px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.sec-k { display: block; margin-bottom: 36px; font: 600 12px/1 var(--mono); letter-spacing: .1em; color: var(--green); }
.warn { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin: 28px 0 0; padding: 16px 20px; border: 1px solid color-mix(in srgb, var(--rose) 45%, var(--line)); background: color-mix(in srgb, var(--rose) 6%, transparent); font: 13px/1.5 var(--mono); color: var(--text); }
.warn .label { color: var(--rose); }

/* ----------------------------------------------------------- install */
.install { max-width: 920px; }
.prereq { margin: 0; color: var(--muted); font-size: 14px; }
.prereq .sep { color: var(--accent); padding: 0 4px; }
.prereq a, .steps a, .agent-note a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
.panel.one { margin-top: 28px; }
.or { display: flex; align-items: center; gap: 16px; margin: 28px 0; font: 600 12px/1 var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--dim); }
.other-note { margin: -12px 0 16px; font-size: 14px; }
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.panel.agent { gap: 16px; border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: color-mix(in srgb, var(--accent) 5%, var(--surface)); box-shadow: inset 0 2px 0 var(--accent); }
.agent-label { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: var(--accent); }
.agent-text { margin: 0; font: 700 clamp(18px, 2.2vw, 22px)/1.35 var(--display); color: #fff; letter-spacing: -0.01em; max-width: 52ch; }
.agent-note { margin: 0; color: var(--muted); font-size: 14px; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { padding: 8px 12px; border: 1px solid var(--line); background: var(--bg-2); color: var(--muted); cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: .06em; }
.pill:hover { color: var(--text); }
.pill[aria-checked="true"] { border-color: var(--accent); color: #fff; background: color-mix(in srgb, var(--accent) 12%, var(--bg-2)); }
.tab-short { display: none; }
.as-app-title { font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #fff; }
.tabs { display: flex; border: 1px solid var(--line); border-bottom: 0; }
.tab { flex: 1 1 0; min-width: 0; padding: 14px 18px; border: 0; border-right: 1px solid var(--line); background: var(--bg-2); color: var(--muted); cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; text-align: left; white-space: nowrap; }
.tab:last-child { border-right: 0; }
.tab[aria-selected="true"] { background: var(--surface); color: #fff; box-shadow: inset 0 2px 0 var(--accent); }
.panel { padding: 28px; border: 1px solid var(--line); background: var(--surface); display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: s; display: grid; gap: 16px; }
.steps li { counter-increment: s; position: relative; padding-left: 44px; color: var(--muted); }
.steps li::before { content: counter(s, decimal-leading-zero); position: absolute; left: 0; top: 1px; font: 600 12px/1.9 var(--mono); color: var(--accent); }
.steps b { color: var(--text); }
.install-foot { margin: 20px 0 0; color: var(--muted); font-size: 15px; }
.install-foot a, .section-head a, .panel .cell-text a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
.as-app { margin-top: 28px; padding: 20px; border: 1px solid var(--line); background: var(--bg-2); display: grid; gap: 14px; }
.as-app .as-app-title { margin: 0; }
.as-app-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; color: var(--muted); font-size: 15px; }
.as-app-list li { display: grid; grid-template-columns: 24ch minmax(0, 1fr); gap: 2px 12px; align-items: baseline; }
.as-app-list b { font: 600 12px/1.6 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--text); }
@media (max-width: 640px) { .as-app-list li { grid-template-columns: minmax(0, 1fr); } }
.as-app-note { color: var(--dim); }

/* --------------------------------------------------------------- faq */
.faq-wrap { display: grid; grid-template-columns: minmax(0, .7fr) minmax(0, 1.3fr); gap: 48px; align-items: start; }
.faq { border-top: 1px solid var(--line); }
.faq :deep(.faq-item) { border-bottom: 1px solid var(--line); }
.faq :deep(.faq-trigger) { padding: 22px 0; font: 600 17px/1.4 var(--display); color: #fff; }
.faq :deep(.faq-body) { padding: 0 0 22px; color: var(--muted); font-size: 16px; max-width: 64ch; }

/* --------------------------------------------------------------- cta */
.cta { overflow: hidden; text-align: center; }
.cta-in { position: relative; z-index: 1; display: grid; justify-items: center; gap: 20px; }
.cta-in .lead { margin: 0 0 12px; }
.cta-logo { width: 120px; height: auto; color: var(--text); margin-bottom: 12px; }

/* ------------------------------------------------------------ footer */
.foot { border-top: 1px solid var(--line); padding: 40px 0 56px; }
.foot-in { display: grid; grid-template-columns: auto 1fr; gap: 20px 40px; align-items: center; }
.foot-brand { display: flex; align-items: center; gap: 10px; font: 800 18px/1 var(--display); color: #fff; }
.foot-logo { width: 28px; height: auto; color: var(--text); }
.foot-links { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 12px 28px; }
.foot-links a { font: 500 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); text-decoration: none; }
.foot-links a:hover { color: var(--text); }
.foot-note { grid-column: 1 / -1; margin: 0; font-size: 13px; color: var(--dim); max-width: 90ch; }

/* -------------------------------------------------------- responsive */
@media (max-width: 1080px) {
  .hero-in { grid-template-columns: minmax(0, 1fr); }
  .hero-visual { max-width: 760px; }
  .hv-phone { right: 0; }
  .sec-grid { grid-template-columns: repeat(2, 1fr); }
  .cells { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 400px) {
  .demo-install-note { display: none; }
}
@media (max-width: 760px) {
  .story, .story.phones { grid-template-columns: minmax(0, 1fr); }
  .story.flip .story-copy { order: 0; }
  .cells, .sec-grid, .how-notes { grid-template-columns: minmax(0, 1fr); }
  .faq-wrap { grid-template-columns: 1fr; gap: 0; }
  .why-wrap { grid-template-columns: minmax(0, 1fr); }
  .why-wrap .section-head { position: static; }
  .why-row { grid-template-columns: minmax(0, 1fr); padding: 20px 0; }
  .foot-in { grid-template-columns: minmax(0, 1fr); }
  .foot-links { justify-content: flex-start; }
  .hv-phone { width: 38%; right: 2px; }
  .tab { padding: 14px 10px; text-align: center; letter-spacing: .06em; }
  .tab-long { display: none; }
  .tab-short { display: inline; }
  .panel { padding: 20px; }
}
</style>
