import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as choices from '../server/utils/choices'
import * as wait from '../server/utils/waitScreen'
import * as menu from '../shared/menuScreen'
import * as settings from '../shared/settingsScreen'
import { classifyScreen } from '../shared/interactiveScreen'
import { parseUsageLimit } from '../shared/usageLimit'
import { CHOICE_MS, keepReading, ScreenCache } from '../server/utils/screenCache'
import { isPermissionQuestion, mergeDetail } from '../server/utils/promptDetail'
import { HerdrError } from '../server/utils/herdr'
import { mapScreenPanes } from '../server/utils/screenGate'
import { bindChoices, bindFunction } from './stateFunction'
const fx = (name: string) => readFileSync(`tests/fixtures/${name}.txt`, 'utf8')
const source = readFileSync('server/utils/state.ts', 'utf8')
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const pairs = [
 ['codex', 'codex-request-increase', 'codex-approaching-limits'],
 ['claude', 'claude-approve-bash', 'claude-approve-edit'],
 ['claude', 'claude-ask-long', 'claude-approve-bash'],
 ['omp', 'omp-ask-single', 'omp-approve-bash'],
 ['omp', 'omp-approve-bash', 'omp-approve-eval'],
] as const

describe('consecutive questions on one pane', () => {
 for (const [agent, first, second] of pairs) it(`${agent}: ${first} → ${second}, unchanged revision and status`, async () => {
  let now = 0, text = fx(first), failed = false
  const call = vi.fn(async () => { if (failed) throw new Error('SSH timeout'); return { read: { text } } })
  const read = bindChoices(source, {
   ...choices,...wait,...menu,...settings,classifyScreen,parseUsageLimit,keepReading,isPermissionQuestion,mergeDetail,
   choicesCache:new ScreenCache(),screenWatch:new Map(),askChecks:new Map(),isViewed:()=>true,modelControlBusy:()=>false,noteScreen:()=>{},
   Date:{now:()=>now},herdr:call,readMenu:async()=>null,withOmpTab:async (_:string,c:unknown)=>c,
   transcripts:{pendingAsk:async()=>[],pendingClaudeQuestions:async()=>[],pendingTool:async()=>null},
  })
  const pane = {id:'w1:p1',agent,status:'blocked'}
  const a = await read(pane,7,false)
  expect(a.choices).toBeTruthy()
  text = fx(second)
  now = CHOICE_MS - 1
  expect((await read(pane,7,false)).choices).toEqual(a.choices)
  now = CHOICE_MS
  const b = await read(pane,7,false)
  expect(b.choices).toBeTruthy()
  expect(b.choices.identity).not.toBe(a.choices.identity)
  expect(b.choices).toMatchObject(choices.screenChoices(text,agent)!)
  if (agent === 'codex') { expect(b.choices.cursor).toBe(2); expect(b.choices.options).toHaveLength(3) }
  text = 'Unrecognized interactive panel\n› Only one unknown entry'
  now += CHOICE_MS
  expect(await read(pane,9,false)).toMatchObject({choices:null,interaction:'terminal'})
  failed = true; now += CHOICE_MS
  expect(await read(pane,8,false)).toMatchObject({choices:null,screen:null,menu:null,interaction:'terminal'})
 })
})

// Execute the real route: labels alone are insufficient for repeated approvals.
it('cursor movement keeps the identity but a changed permission command does not', () => {
 const text=fx('codex-approaching-limits')
 expect(choices.promptIdentity(text)).toBe(choices.promptIdentity(text.replace('  2. Keep','› 2. Keep').replace('› 3. Keep','  3. Keep')))
 const permission=fx('claude-approve-bash')
 expect(choices.promptIdentity(permission)).not.toBe(choices.promptIdentity(permission.replace('npm test','npm run build')))
})

for (const agent of ['codex','claude','omp']) it(`${agent}: rejects changed question even when the button label stays the same`, async () => {
 vi.useFakeTimers()
 let text = agent === 'omp' ? fx('omp-ask-single') : fx('codex-approve-command')
 const old = choices.screenChoices(text,agent)!
 const call = vi.fn(async () => ({read:{text}}))
 const cache = new Map([['w1:p1',{}]])
 const poll = vi.fn()
 const pending = vi.fn(async () => [])
 for (const [name,value] of Object.entries({defineApi:(h:unknown)=>h,PANE_RE:/^w1:p1$/,HerdrError,
  findPane:()=>({id:'w1:p1',agent,status:'blocked'}),herdr:call,...choices,
  transcripts:{pendingClaudeQuestions:pending},choicesCache:cache,poll,
 })) vi.stubGlobal(name,value)
 const {default:handler}=await import('../server/api/choose.post')
 text = text.replaceAll(agent === 'omp' ? 'Favourite' : 'npm test', agent === 'omp' ? 'Preferred' : 'npm run build')
 expect(choices.screenChoices(text,agent)!.options[0]!.label).toBe(old.options[0]!.label)
 await expect(handler({} as never,{pane_id:'w1:p1',index:0,label:old.options[0]!.label,identity:old.identity})).rejects.toMatchObject({code:'stale'})
 expect(call).toHaveBeenCalledTimes(1)
 if (agent === 'claude') expect(pending.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!)
 expect(cache.has('w1:p1')).toBe(false)
 await vi.runAllTimersAsync()
 expect(poll).toHaveBeenCalledOnce()
 call.mockClear()
 const current=choices.screenChoices(text,agent)!
 await expect(handler({} as never,{pane_id:'w1:p1',index:0,label:current.options[0]!.label,identity:current.identity})).resolves.toEqual({ok:true})
 expect(call).toHaveBeenCalledWith('pane.send_input',expect.objectContaining({keys:choices.keysFor(current,0)}))
})

it('bounds eight slow pane readings to two at once', async () => {
 vi.useFakeTimers()
 const panes = Array.from({length:8},(_,i)=>({id:`w1:p${i+1}`,agent:'codex',status:'blocked',agentSession:'neutral'}))
 const map = () => new Map()
 const choicesFor = vi.fn(async () => { await new Promise(r=>setTimeout(r,250)); return {choices:choices.screenChoices(fx('codex-approaching-limits'),'codex'),interaction:'native'} })
 const bind: Record<string,unknown> = {
  seenMachines:new Set(['']),mstates:map(),agentBorn:new Map(panes.map(p=>[p.id,{agent:p.agent,at:null}])),
  selfUpdates:{prune:()=>{},observe:async()=>false},commands:map(),READY:new Set(),
  getMachine:()=>({transcripts:{observe:()=>{}}}),joinId:(_:string,id:string)=>id,
  restarts:map(),leftForGood:()=>false,lookForLeftMenu:()=>false,findPane:()=>null,pendingPrompts:map(),queued:map(),
  screenVersions:new WeakMap(),mapScreenPanes,choicesFor,previews:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),
  models:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),isViewed:()=>false,
activities:map(),ompStatuses:map(),ocStatuses:map(),ocInboxes:map(),refreshOcStatus:()=>{},codexFields:map(),codexStatus:{forget:()=>{}},chatDelta:{ids:()=>[],forget:()=>{}},choicesCache:new ScreenCache(),askChecks:map(),  takenBack:map(),seen:map(),saveBorn:()=>{},saveSeen:()=>{},saveQueued:()=>{},machineOf:()=>'',
 }
 const enrich = bindFunction(source,'enrich',bind)
 let published = false
 const result = enrich({panes},{panes:panes.map(p=>({pane_id:p.id,revision:7}))},'').then(()=>{published=true})
 await vi.advanceTimersByTimeAsync(249)
 expect(published).toBe(false)
 expect(choicesFor).toHaveBeenCalledTimes(2)
 await vi.advanceTimersByTimeAsync(751)
 await result
 expect(published).toBe(true)
 expect(panes.every(p => (p as any).prompt?.options.length === 3)).toBe(true)
})
