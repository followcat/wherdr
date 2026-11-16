<script setup lang="ts">
// The landing page (`/`): dotted background grid with travelling packets,
// live demos in the hero (phone + desktop on one clock) and next to the
// feature stories, and an install that types itself.
import { DISCORD, DOCS, REPO, V2_BRANCH } from '~/utils/site'
import { AGENT_PROMPTS } from '~/utils/agentPrompts'
import { INSTALL_COMMANDS, PLAN_DEMO } from '~/utils/installDemo'
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
    text: 'wherdr reads each agent\'s own transcript — Claude Code, Codex, Devin, omp — and renders it as clean Markdown with grouped tool calls, images and search. Switch to the live terminal of herdr-core to take over: every viewer gets its own size.',
    points: ['Composer with queue, attachments and on-device dictation', 'Questions as buttons, tasks as live cards', 'Copy or run the commands the agent proposes'],
  },
  {
    id: 'phone',
    label: 'Phone · notifications',
    title: 'Your turn? Answer in one tap.',
    text: 'Install wherdr on your phone as a PWA. A push tells you when an agent finishes or needs you, with its question and options. Answer right from the agent list, without opening the conversation.',
    points: ['Web Push when an agent is done or blocked', 'Do not disturb, per device or for all', 'A neural read-aloud voice that runs on the phone'],
  },
] as const

// What sets wherdr apart, in five lines. Each one is detailed further down the page.
const why = [
  { k: 'BOARD', title: 'Projects that run', text: 'Talk to a project\'s coordinator: it adds tasks, and agents carry them through your workflow on a board. Guards keep your protected branches and decide which merges wait for you.' },
  { k: 'REVIEW', title: 'Tasks to review', text: 'One card counts what waits for you. Approve, or reject with a note and the wrong screenshots marked. Accept at any time: wherdr merges in order, solving conflicts and red CI first.' },
  { k: 'ALFRED', title: 'Alfred, the wherdr assistant', text: 'It guides the first setup, brings your v2 projects over in one card, and changes a setting only after your yes.' },
  { k: 'LOCK', title: 'A passkey lock', text: 'Optional: Face ID, Touch ID, Windows Hello or Android unlock the app. Once a passkey exists, nothing about your agents is served to a locked session.' },
  { k: 'LIVE', title: 'Real time, and private', text: 'The real terminal of herdr-core, a push when an agent needs you, and your phone through Tailscale. Nothing is on the Internet.' },
]

const features = [
  { icon: 'i-lucide-kanban', title: 'Board and workflows', text: 'Each task type is a diagram of steps. A task shows a TL;DR, the time per step, review rounds and CI fixes.' },
  { icon: 'i-lucide-bot', title: 'Autopilot', text: 'A coordinator keeps the board busy within its limits and hours, with a timeline of the day.' },
  { icon: 'i-lucide-git-merge', title: 'Routine blocks handled', text: 'Merge queue, conflicts, branches behind, infrastructure CI failures and stalled agents: wherdr deals with them first.' },
  { icon: 'i-lucide-sticky-note', title: 'Notes', text: 'Alfred and the coordinators keep a short whiteboard for you: reminders, checklists, task badges and plans.' },
  { icon: 'i-lucide-server', title: 'Several machines', text: 'hc machines over SSH. Each task goes to a machine its project allows, by memory, cores and load.' },
  { icon: 'i-lucide-gauge', title: 'Claude & Codex quotas', text: 'Per account, with reset times. Pace starts automatic work within your quotas.' },
  { icon: 'i-lucide-keyboard', title: 'Keyboard first', text: 'Global search, next agent, new tab, 1–9 to answer. Everything without the mouse.' },
  { icon: 'i-lucide-fingerprint', title: 'Passkey lock', text: 'Face ID, Touch ID, Windows Hello, Android. Unlock lasts as long as you choose, devices can be locked remotely.' },
  { icon: 'i-lucide-refresh-cw', title: 'Update with Alfred', text: 'A banner shows what is new. Alfred plans, backs up, updates, checks, and rolls back on failure.' },
]

const security = [
  { k: 'NET', title: 'Private network only', text: 'wherdr listens on 127.0.0.1. Reach it from your devices through Tailscale Serve — never a public route, port forward or tunnel.' },
  { k: 'KEY', title: 'Passkey lock', text: 'Once a passkey exists, the API, images and WebSockets need an unlocked session. Lock every device in one tap.' },
  { k: 'LOCAL', title: 'Nothing in the cloud', text: 'No account, no telemetry, no hosted service. wherdr talks to herdr-core\'s socket on your server and reads transcripts read-only.' },
  { k: 'CSP', title: 'Strict by default', text: 'Host allow-list, Origin checks on every write and WebSocket, strict Content Security Policy, no framing.' },
]

// The agent prompt shown in the install card: a new install, or beside a running wherdr 2.
const prompt = ref<typeof AGENT_PROMPTS[number]['id']>('new')

const faq = [
  { label: 'Is wherdr free?', content: 'Yes. It is open source under the MIT license, with no account, no paid plan and no hosted version. You run it on your own machine.' },
  { label: 'What do I need?', content: 'herdr-core (hc), Node.js 22 and Git. The install script needs Linux with systemd --user; the build takes about 1.5 GB of memory. For your phone: a private HTTPS address, which Tailscale Serve gives you in one command.' },
  { label: 'I use wherdr 2. Do I lose it?', content: 'No. wherdr 3 installs beside it, with its own port, data folder, service and address. It imports v2\'s machines and settings, never changes v2, and Alfred offers your v2 projects. Compare both and go back at any time.' },
  { label: 'Can I put it on the Internet?', content: 'No. wherdr is a remote shell on your machine: whoever reaches it can start agents and run commands as your user. Use it on localhost or over a private network such as Tailscale, and enable the passkey lock.' },
  { label: 'Does my code or my conversations leave my machine?', content: 'No. wherdr reads the agents\' transcript files and herdr-core\'s socket locally and serves them to your own devices. Push notifications travel through your browser\'s push service, encrypted as the Web Push standard requires. The only other outgoing request is an optional daily check of the latest GitHub release (WHERDR_UPDATE_CHECK=off disables it).' },
  { label: 'Which agents are supported?', content: 'Every terminal of herdr-core appears in the list. Claude Code, Codex, Devin and omp also get the full conversation view and one-tap answers.' },
  { label: 'Does it work on macOS?', content: 'Yes, installed by hand: the install script needs systemd, so on a Mac you build it and keep it running with a LaunchAgent, as the installation guide says.' },
  { label: 'Is it an official Herdr project?', content: 'No. wherdr is an independent project built on herdr-core\'s public API. It is not affiliated with Herdr, Anthropic or OpenAI.' },
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
              wherdr is a web app and phone PWA for the agents running in <a href="https://github.com/herdrdev/herdr-core" target="_blank" rel="noopener">herdr-core</a>
              on your machines — <b>Claude Code, Codex, Devin, omp</b> and more. Talk to each project's coordinator, review its tasks,
              answer your agents, take over their terminal. From your laptop or your pocket, over your own private network.
            </p>
            <div class="hero-ctas">
              <a class="btn primary" href="#install">Install with your AI agent <UIcon name="i-lucide-arrow-right" class="size-4" /></a>
              <a class="btn" href="/demo/"><UIcon name="i-lucide-play" class="size-4" /><span>Try it in your browser<span class="demo-install-note"> — no install</span></span></a>
              <a class="btn" :href="REPO" target="_blank" rel="noopener"><GithubMark /> Star on GitHub</a>
            </div>
            <p class="hero-note label">wherdr 3 · needs herdr-core (hc) · installs beside wherdr 2 · phone through Tailscale</p>
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
            <h2 class="display h2">Your projects, run by agents.<br>Your decisions, in one tap.</h2>
            <p class="lead">A coordinator per project, a board, and the tasks that wait for you, behind your own lock.</p>
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
            <p class="lead">Same herdr-core session, same agents, nothing copied. On a computer wherdr is your workspace day to day; on a phone it follows your agents and your board while you are away.</p>
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
            <h2 class="display h2">On herdr-core. Never in between.</h2>
            <p class="lead">wherdr runs on the same machine as herdr-core (<code>hc</code>), as a user service. It uses hc's local socket, reads the agents' transcript files, and serves the app to your devices through your private network. Your other computers join as hc machines over SSH.</p>
          </div>
          <FlowDiagram v-reveal />
          <div v-reveal class="how-notes">
            <div><p class="label"><span class="k">→</span> Gateway</p><p>Nitro server: API, WebSockets, Web Push and lock, on 127.0.0.1 only.</p></div>
            <div><p class="label"><span class="k">→</span> Read-only</p><p>Transcripts of <code>~/.claude</code>, <code>~/.codex</code>, Devin and omp are read, never written.</p></div>
            <div><p class="label"><span class="k">→</span> Beside v2</p><p>Its own port, data, service and address: a wherdr 2 on the same machine keeps running.</p></div>
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
              <h3 class="label agent-label"><UIcon name="i-lucide-sparkles" class="size-3.5" /> Install with your AI agent</h3>
              <p class="agent-text">Paste this into Claude Code, Codex or any coding agent, on the machine where wherdr will run: it installs and sets up wherdr 3 for you.</p>
              <div class="tabs" role="tablist" aria-label="Your case">
                <button v-for="p in AGENT_PROMPTS" :id="`tab-${p.id}`" :key="p.id" type="button" role="tab" class="tab" :aria-selected="prompt === p.id" :aria-controls="`panel-${p.id}`" @click="prompt = p.id">{{ p.label }}</button>
              </div>
              <div v-for="p in AGENT_PROMPTS" v-show="prompt === p.id" :id="`panel-${p.id}`" :key="p.id" role="tabpanel" :aria-labelledby="`tab-${p.id}`" class="prompt">
                <InstallCommand :command="p.text" prompt="›" what="prompt" wrap big />
              </div>
              <p class="agent-note">The prompts of <a :href="`${DOCS}/install-with-an-agent.md`" target="_blank" rel="noopener">Install with an agent</a>: the agent looks at the machine first, shows you the installer's plan, asks before any sudo, and never touches wherdr 2.</p>
            </div>

            <div aria-labelledby="installer-title" class="panel one">
              <h3 id="installer-title" class="cell-title">Or run the installer yourself</h3>
              <p class="cell-text">On Linux with systemd: clone the v3 branch and run its install script. It prints its plan and changes nothing; run it again with <code>--yes</code> to apply. It builds wherdr in <code>~/wherdr-v3</code>, runs it and herdr-core as user services, publishes it with <code>tailscale serve</code> and imports a running wherdr 2's machines and settings, leaving v2 untouched. Update with <code>~/wherdr-v3/update.sh</code> or <i>Update with Alfred</i>. On macOS, <a :href="`${DOCS}/installation.md#on-macos`" target="_blank" rel="noopener">install by hand</a>.</p>
              <InstallCommand :command="INSTALL_COMMANDS.join('\n')" what="commands" wrap />
              <InstallTerminal :demo="PLAN_DEMO" />
              <p class="prereq">
                Needs <a href="https://github.com/herdrdev/herdr-core" target="_blank" rel="noopener">herdr-core</a> (<code>hc</code>) <span class="sep" aria-hidden="true">·</span> Node.js 22 <span class="sep" aria-hidden="true">·</span> Git <span class="sep" aria-hidden="true">·</span> phone through <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a>.
                <a :href="`${DOCS}/release-notes-3.0.0.md`" target="_blank" rel="noopener">Release notes</a> <span class="sep" aria-hidden="true">·</span> <a :href="`${DOCS}/migrate-from-v2.md`" target="_blank" rel="noopener">Migrate from v2</a>.
              </p>
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
              Full guide, configuration and troubleshooting in the <a :href="`${DOCS}/README.md`" target="_blank" rel="noopener">documentation</a>.
            </p>
            <p class="v2-note">Still on wherdr 2? Its docs and installer live on the <a :href="V2_BRANCH" target="_blank" rel="noopener">2.x branch</a>.</p>
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
.prereq a, .agent-note a, .v2-note a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
.panel.one { margin-top: 28px; }
.panel.agent { gap: 16px; border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: color-mix(in srgb, var(--accent) 5%, var(--surface)); box-shadow: inset 0 2px 0 var(--accent); }
.agent-label { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: var(--accent); }
.agent-text { margin: 0; font: 700 clamp(18px, 2.2vw, 22px)/1.35 var(--display); color: #fff; letter-spacing: -0.01em; max-width: 52ch; }
.agent-note { margin: 0; color: var(--muted); font-size: 14px; }
.as-app-title { font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #fff; }
.tabs { display: flex; border: 1px solid var(--line); border-bottom: 0; }
.tab { flex: 1 1 0; min-width: 0; padding: 14px 18px; border: 0; border-right: 1px solid var(--line); background: var(--bg-2); color: var(--muted); cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; text-align: left; white-space: nowrap; }
.tab:last-child { border-right: 0; }
.tab[aria-selected="true"] { background: var(--surface); color: #fff; box-shadow: inset 0 2px 0 var(--accent); }
.panel { padding: 28px; border: 1px solid var(--line); background: var(--surface); display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
.install-foot { margin: 20px 0 0; color: var(--muted); font-size: 15px; }
.install-foot a, .section-head a, .panel .cell-text a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
.as-app { margin-top: 28px; padding: 20px; border: 1px solid var(--line); background: var(--bg-2); display: grid; gap: 14px; }
.as-app .as-app-title { margin: 0; }
.v2-note { margin: 8px 0 0; color: var(--dim); font-size: 14px; }
/* The agent prompts are long: they scroll inside their block. */
.prompt :deep(.text) { max-height: 240px; overflow-y: auto; }
.prompt :deep(.copy) { align-self: flex-start; min-height: 48px; }
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
  .panel { padding: 20px; }
}
</style>
