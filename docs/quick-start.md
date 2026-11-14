# First launch

[Documentation](README.md) · [Project](../README.md)

## Quick start

wherdr v3 runs from source, on the computer that runs your **hc session**, as the same user.
There is no installer, npm package, Homebrew formula or Herdr plugin for v3 (the
`curl … | sh` installer, `npm install -g wherdr` and `herdr plugin install` all install v2).

With Git and **Node.js 22** or newer, and hc running:

```sh
git clone -b v3 https://github.com/afloury/wherdr.git
cd wherdr
npm ci
npm run build
HC_SOCKET=/path/to/hc.sock npm start   # listens on 127.0.0.1:7683
```

- `HC_SOCKET` is the socket of the hc session to drive. wherdr never starts or installs hc, and
  never guesses the socket. By default it is `$XDG_RUNTIME_DIR/herdr-core/<session>.sock` on
  Linux and `~/.local/state/herdr-core/<session>/<session>.sock` on macOS; the session is named
  `default` unless you chose another ([The hc socket](installation.md#the-hc-socket)). If the
  home screen says **herdr-core is not responding**, start that session (`hc server start`).
- wherdr v2 also listens on port 7683: with v2 running on the same computer, start v3 with
  another port (`PORT=7684 npm start`) and open that one instead
  ([v2 and v3 on one computer](installation.md#v2-and-v3-on-one-computer)).
- Start hc from a plain shell, not from inside a Claude Code session: Claude Code started by
  such a core does not save its transcripts, and its agents then show only their terminal
  ([Conversations](core.md#conversations)).

Open **http://localhost:7683** on that computer. Settings › About shows the version and the
commit it was built from (`wherdr 3.0.0+1a2b3c4 · herdr-core`).

**Alfred**, wherdr's assistant, is the first row of the home screen: start it and it offers to
set up your first project with you, one question at a time, or in the **setup window**
(Settings › Projects › *Set up a project*), three steps: turn projects on, pick a project and its coordinator's agent, then meet the coordinator, whose first message proposes how you work
([Alfred](home.md#alfred), [Getting started](project-management.md#getting-started)). The rest is in
Settings:

1. **Phone**: publish wherdr on your tailnet from Settings › Phone, then
   [install it as an app](phone.md#install-it-as-an-app). See
   [Phone access and private networks](networks.md).
2. **Passkey lock** (optional): Settings › Security, once wherdr is reached over HTTPS.
3. **Notifications**: Settings › Notifications on each device ([Notifications](notifications.md)).
4. **Claude quotas**: Settings › Agents › Claude quotas ([quotas](quotas.md#claude-and-codex-quotas)).
5. **Other machines**: Settings › Machines ([Machines](machines.md)).

To keep wherdr running, see [Installation and updates](installation.md).

> [!WARNING]
> **wherdr is a remote shell on your machine.** Anyone who can reach it can start agents and
> run commands as your user. **Never expose it on the public Internet** (no port forwarding, no
> public reverse proxy, no tunnel). Use it on `localhost`, or from your other devices through a
> private network such as [Tailscale](https://tailscale.com). wherdr refuses any other network
> by itself; the passkey lock is an optional extra. See [Security](security.md#security).

**On a computer**, wherdr shows your hc spaces and tabs, live conversations and real terminals,
with keyboard shortcuts. **On a phone**, installed as a PWA, it follows your agents when you are
away: push notifications when an agent finishes or needs you, one-tap answers and quick replies.

Now open the [Board](project-management.md#board), or talk to Alfred.

*Unofficial project. Not affiliated with or endorsed by Herdr, Anthropic or OpenAI. Claude,
Claude Code, Codex and other product names are trademarks of their respective owners.*
