// Types of tailnet.mjs, for the server (server/utils/phone.ts).
// funnel: also published on the Internet by `tailscale funnel` (never adopted).
export interface PhoneAddress { url: string, served: boolean, httpsPort: string, funnel?: boolean }
export interface Tailnet {
  installed: boolean
  bin?: string | null
  socket?: string | null
  name?: string | null
  connected?: boolean
  https?: boolean
  phone?: PhoneAddress | null
  taken?: boolean
  // Addresses published for wherdr's port; null when they could not be read.
  served?: string[] | null
}
export type Reach = 'ok' | 'host' | 'other' | 'unreachable'
export type ReachCause = 'dns' | 'refused' | 'timeout' | 'cert' | 'tls' | 'network'
export interface Probe { reach: Reach, cause?: ReachCause, status?: number }
export type ServeErrorCode = 'operator' | 'https' | 'offline'

export const LINKS: { download: string, https: string, operator: string }
export const TAILSCALED_SOCKET: string
export function tailscaledSocket(env?: Record<string, string | undefined>, exists?: (p: string) => boolean): string | null
export function tailscaleBins(env?: Record<string, string | undefined>, exists?: (p: string) => boolean, platform?: string): string[]
export function tailscaleBin(env?: Record<string, string | undefined>, exists?: (p: string) => boolean, platform?: string): string | null
export type TailscaleExec = (bin: string, args: string[], opts: { encoding: 'utf8', timeout: number }) => Promise<{ stdout: string, stderr: string }>
export function readTailscale(candidates: string | string[] | null, args: string[], run?: TailscaleExec, timeout?: number, now?: () => number): Promise<{ bin: string | null, out: string }>
export function tailnetStatus(statusJson: string): { name: string | null, connected: boolean, https: boolean }
export function phoneAddress(name: string | null, port: string | number, serveJson: string): PhoneAddress | null
export function servedAddresses(name: string | null, port: string | number, serveJson: string): string[] | null
export function servedPorts(serveJson: string): string[]
export function publishCommand(port: string | number, httpsPort?: string | number): string
export function publishArgs(port: string | number): string[]
export function unpublishArgs(httpsPort: string): string[]
export function serveError(output: string): { code: ServeErrorCode, link: string } | null
export function inspect(port: string | number, bin?: string | string[] | null, socket?: string | null, run?: TailscaleExec): Promise<Tailnet>
export function reachable(url: string, timeoutMs?: number): Promise<Reach>
export function healthReach(status: number, text: string): 'ok' | 'host' | null
export function probe(url: string, timeoutMs?: number): Promise<Probe>
export function failureCause(err: unknown): ReachCause
export function runTailscale(bin: string, args: string[], timeoutMs?: number): Promise<{ code: number, output: string }>
export interface TailnetPeers { readable: boolean, state: string | null, running: boolean, selfIps: string[], peerIps: string[], otherIps: string[] }
export interface TailnetFacts extends Omit<TailnetPeers, 'state'> { installed: boolean, funnel: boolean | null }
export function tailnetPeers(statusJson: string): TailnetPeers
export function targetPort(target: unknown): number | null
export function funnelExposes(port: string | number, serveJson: string): boolean | null
export function tailnetFacts(port: string | number, bin?: string | string[] | null, socket?: string | null, run?: TailscaleExec): Promise<TailnetFacts>
