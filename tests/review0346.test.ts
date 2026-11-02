import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import * as choices from '../server/utils/choices'
import * as wait from '../server/utils/waitScreen'
import * as menu from '../shared/menuScreen'
import * as settings from '../shared/settingsScreen'
import { classifyScreen } from '../shared/interactiveScreen'
import { parseUsageLimit } from '../shared/usageLimit'
import { keepReading, ScreenCache } from '../server/utils/screenCache'
import { isPermissionQuestion, mergeDetail } from '../server/utils/promptDetail'
import { HerdrError } from '../server/utils/herdr'
import { mapScreenPanes, ScreenGate, SCREEN_MACHINE_MAX, SCREEN_TOTAL_MAX } from '../server/utils/screenGate'
import { bindChoices, bindFunction } from './stateFunction'
import { createInteractionWindow } from '../app/utils/interactionWindow'
const fx=(n:string)=>readFileSync(`tests/fixtures/${n}.txt`,'utf8')
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
async function route(name:string,call:any) {
 vi.useFakeTimers()
 for(const [key,value] of Object.entries({defineApi:(h:any)=>h,PANE_RE:/^w1:p1$/,HerdrError,
  findPane:()=>({id:'w1:p1',agent:'codex',status:'blocked'}),herdr:call,...choices,...wait,
  transcripts:{pendingClaudeQuestions:async()=>[]},choicesCache:new ScreenCache(),poll:()=>{},watchScreen:()=>{}}))vi.stubGlobal(key,value)
 return (await import(`../server/api/${name}.post.ts`)).default
}
it('R1: Enter refuses the new question while the old card is displayed',async()=>{
 const old=choices.screenChoices(fx('codex-request-increase'),'codex')!
 const next=choices.screenChoices(fx('codex-approaching-limits'),'codex')!
 expect(next.identity).not.toBe(old.identity)
 const call=vi.fn(async()=>({read:{text:fx('codex-approaching-limits')}}))
 const handler=await route('nav',call)
 await expect(handler({}, {pane_id:'w1:p1',key:'enter',identity:old.identity})).rejects.toMatchObject({code:'stale'})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 await expect(handler({}, {pane_id:'w1:p1',key:'down'})).resolves.toEqual({ok:true})
 await expect(handler({}, {pane_id:'w1:p1',key:'enter',identity:next.identity})).resolves.toEqual({ok:true})
})
it('R2 residual risk: Herdr has no conditional send between capture and input',async()=>{
 const first=fx('codex-request-increase'), second=fx('codex-approaching-limits')
 const old=choices.screenChoices(first,'codex')!
 let terminal=first; const writes:any[]=[]
 const call=vi.fn(async(method:string,params:any)=>{
  if(method==='pane.read'){const captured=terminal;terminal=second;return {read:{text:captured}}}
  writes.push({terminal,keys:params.keys});return {}
 })
 const handler=await route('choose',call)
 await expect(handler({}, {pane_id:'w1:p1',index:0,label:old.options[0]!.label,identity:old.identity})).resolves.toEqual({ok:true})
 expect(writes).toEqual([{terminal:second,keys:['enter']}])
})
it('unchanged questions remain answerable while unrelated detection text changes',async()=>{
 const base=fx('codex-approve-command'); let text=base+'\nBackground elapsed: 0s'
 const call=vi.fn(async()=>({read:{text}}));const handler=await route('choose',call)
 for(let i=0;i<5;i++){
  const shown=choices.screenChoices(text,'codex')!;text=base+`\nBackground elapsed: ${i+1}s`
  expect(choices.screenChoices(text,'codex')!.question).toBe(shown.question)
  await expect(handler({}, {pane_id:'w1:p1',index:0,label:shown.options[0]!.label,identity:shown.identity})).resolves.toEqual({ok:true})
 }
 expect(call.mock.calls.filter(c=>c[0]==='pane.send_input')).toHaveLength(5)
})
it('old clients fail closed and identical labels with different question text are rejected',async()=>{
 let text=fx('codex-approve-command');const old=choices.screenChoices(text,'codex')!
 const call=vi.fn(async()=>({read:{text}}));const handler=await route('choose',call)
 await expect(handler({}, {pane_id:'w1:p1',index:0,label:old.options[0]!.label})).rejects.toMatchObject({code:'stale'})
 text=text.replace('npm test','npm run build')
 await expect(handler({}, {pane_id:'w1:p1',index:0,label:old.options[0]!.label,identity:old.identity})).rejects.toMatchObject({code:'stale'})
 expect(call).toHaveBeenCalledTimes(2)
})
it('a second identical screen occurrence is indistinguishable from the first',async()=>{
 const text=fx('codex-approve-command'),old=choices.screenChoices(text,'codex')!
 const call=vi.fn(async()=>({read:{text}}));const handler=await route('choose',call)
 await expect(handler({}, {pane_id:'w1:p1',index:0,label:old.options[0]!.label,identity:old.identity})).resolves.toEqual({ok:true})
})
export function reviewPoller(viewed = false){
 let now=0,fail=false;const cache=new ScreenCache();let reads=0
 const read=bindChoices(readFileSync('server/utils/state.ts','utf8'),{
 ...choices,...wait,...menu,...settings,classifyScreen,parseUsageLimit,keepReading,isPermissionQuestion,mergeDetail,
 choicesCache:cache,screenWatch:new Map(),askChecks:new Map(),isViewed:()=>viewed,modelControlBusy:()=>false,noteScreen:()=>{},
 Date:{now:()=>now},herdr:async()=>{reads++;if(fail)throw Error('temporary timeout');return {read:{text:fx('codex-request-increase')}}},
 readMenu:async()=>null,transcripts:{pendingClaudeQuestions:async()=>[],pendingTool:async()=>null}})
 return {tick:async(t:number,bad=false)=>{now=t;fail=bad;return read({id:'w1:p1',agent:'codex',status:'blocked'},7,false)},reads:()=>reads,invalidate:()=>cache.delete('w1:p1')}
}
it('R3: one failed read keeps the native card disabled and retries at the next poll',async()=>{
 const p=reviewPoller(true), window=createInteractionWindow()
 const original = await p.tick(0)
 const failed = await p.tick(1000,true)
 expect(failed).toMatchObject({interaction:'native',unavailable:true,choices:{...original.choices,unavailable:true}})
 expect(window.update(failed.interaction,1000)).toBe(false)
 expect(window.update(failed.interaction,1500)).toBe(false)
 const recovered = await p.tick(2000)
 expect(recovered.choices).toEqual(original.choices)
 expect(recovered.unavailable).toBeUndefined()
 expect(window.update(recovered.interaction,2000)).toBe(false)
})
it('new fixture words alone in ordinary prose do not create a native choice card',()=>{
 for(const text of ['Request increase? Yes (y), No (n).','Approaching rate limits. Switch to gpt-6-luna for lower credit usage?'])expect(choices.screenChoices(text,'codex')).toBeNull()
})

const source=readFileSync("server/utils/state.ts","utf8")
it('R5: bounds 20 pane enrichments to two at once per machine', async () => {
 vi.useFakeTimers()
 const panes = Array.from({length:20},(_,i)=>({id:`w1:p${i+1}`,agent:'codex',status:'blocked',agentSession:'neutral'}))
 const map = () => new Map()
 const choicesFor = vi.fn(async () => { await new Promise(r=>setTimeout(r,250)); return {choices:choices.screenChoices(fx('codex-approaching-limits'),'codex'),interaction:'native'} })
 const bind: Record<string,unknown> = {
  seenMachines:new Set(['']),mstates:map(),agentBorn:new Map(panes.map(p=>[p.id,{agent:p.agent,at:null}])),
  selfUpdates:{prune:()=>{},observe:async()=>false},commands:map(),READY:new Set(),
  getMachine:()=>({transcripts:{observe:()=>{}}}),joinId:(_:string,id:string)=>id,
  restarts:map(),leftForGood:()=>false,lookForLeftMenu:()=>false,findPane:()=>null,pendingPrompts:map(),queued:map(),
  screenVersions:new WeakMap(),mapScreenPanes,choicesFor,previews:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),
  models:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),isViewed:()=>false,
  activities:map(),ompStatuses:map(),codexFields:map(),codexStatus:{forget:()=>{}},chatDelta:{ids:()=>[],forget:()=>{}},choicesCache:new ScreenCache(),askChecks:map(),
  takenBack:map(),seen:map(),saveBorn:()=>{},saveSeen:()=>{},saveQueued:()=>{},machineOf:()=>'',
 }
 const enrich = bindFunction(source,'enrich',bind)
 let published = false
 const result = enrich({panes},{panes:panes.map(p=>({pane_id:p.id,revision:7}))},'').then(()=>{published=true})
 await vi.advanceTimersByTimeAsync(249)
 expect(published).toBe(false)
 expect(choicesFor).toHaveBeenCalledTimes(SCREEN_MACHINE_MAX)
 await vi.advanceTimersByTimeAsync(2251)
 await result
 expect(published).toBe(true)
 expect(panes.every(p => (p as any).prompt?.options.length === 3)).toBe(true)
})
it('an invalidated in-flight screen cannot repopulate the cache or return its old card',async()=>{
 const oldText=fx('codex-request-increase');let release!:(v:any)=>void
 const cache=new ScreenCache();const pending=new Promise(r=>{release=r})
 const read=bindChoices(source,{
 ...choices,...wait,...menu,...settings,classifyScreen,parseUsageLimit,keepReading,isPermissionQuestion,mergeDetail,
 choicesCache:cache,screenWatch:new Map(),askChecks:new Map(),isViewed:()=>false,modelControlBusy:()=>false,noteScreen:()=>{},
 herdr:()=>pending,readMenu:async()=>null,transcripts:{pendingClaudeQuestions:async()=>[],pendingTool:async()=>null}})
 const oldRun=read({id:'w1:p1',agent:'codex',status:'blocked'},7,false)
 const newText=fx('codex-approaching-limits'),current=choices.screenChoices(newText,'codex')!
 const call=vi.fn(async()=>({read:{text:newText}}));const handler=await route('choose',call)
 vi.stubGlobal('choicesCache',cache)
 await handler({}, {pane_id:'w1:p1',index:2,label:current.options[2]!.label,identity:current.identity})
 expect(cache.has('w1:p1')).toBe(false)
 release({read:{text:oldText}});const result=await oldRun
 expect(cache.has('w1:p1')).toBe(false)
 expect(result.choices).toBeNull()
})
it('omp cursor movement preserves the identity of the question and options',()=>{
 const text=fx('omp-approve-bash')
 const moved=text.replace('❯ Approve','  Approve').replace('  Deny','❯ Deny')
 const a=choices.screenChoices(text,'omp')!,b=choices.screenChoices(moved,'omp')!
 expect(b.question).toEqual(a.question)
 expect(b.options).toEqual(a.options)
 expect(b.identity).toBe(a.identity)
})

it('R5: screen RPCs obey both machine and total limits and release failed slots', async () => {
 const gate = new ScreenGate()
 let active = 0, peak = 0
 const per = new Map<string, number>(), peaks = new Map<string, number>()
 const releases: (() => void)[] = []
 const jobs = ['a','a','a','b','b','b','c','c'].map((machine, i) => gate.run(machine, async () => {
  active++; peak = Math.max(peak, active)
  per.set(machine, (per.get(machine) || 0) + 1)
  peaks.set(machine, Math.max(peaks.get(machine) || 0, per.get(machine)!))
  await new Promise<void>(resolve => releases.push(resolve))
  active--; per.set(machine, per.get(machine)! - 1)
  if (i === 0) throw new Error('read failed')
 }))
 const settled = Promise.allSettled(jobs)
 await Promise.resolve()
 expect(active).toBe(SCREEN_TOTAL_MAX)
 while (releases.length) {
  releases.splice(0).forEach(release => release())
  for (let i = 0; i < 8; i++) await Promise.resolve()
 }
 const result = await settled
 expect(result.filter(r => r.status === 'rejected')).toHaveLength(1)
 expect(peak).toBe(SCREEN_TOTAL_MAX)
 expect([...peaks.values()].every(n => n <= SCREEN_MACHINE_MAX)).toBe(true)
 expect(active).toBe(0)
})

it('R5: the viewed pane starts before queued background panes', async () => {
 vi.useFakeTimers()
 const started: number[] = []
 const jobs = mapScreenPanes([0,1,2,3,4], 'priority', async pane => {
  started.push(pane)
  await new Promise(resolve => setTimeout(resolve, 250))
 }, pane => pane === 4)
 await vi.advanceTimersByTimeAsync(0)
 expect(started).toEqual([4,0])
 await vi.advanceTimersByTimeAsync(750)
 await jobs
})

it('legend confirmation refuses a changed waiting screen and accepts its fresh identity', async () => {
 const oldText = fx('codex-hooks-box')
 const newText = oldText.replace('4 hooks', '5 hooks')
 const old = wait.parseWaitScreen(oldText)!, current = wait.parseWaitScreen(newText)!
 const call = vi.fn(async () => ({read:{text:newText}}))
 const handler = await route('screen-key', call)
 await expect(handler({}, {pane_id:'w1:p1',key:'enter',label:'review',identity:choices.waitIdentity(old)})).rejects.toMatchObject({code:'stale'})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 await expect(handler({}, {pane_id:'w1:p1',key:'enter',label:'review',identity:choices.waitIdentity(current)})).resolves.toEqual({ok:true})
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['enter']})
})

it('R3: invalidation keeps a disabled display fallback until a fresh read succeeds', async () => {
 const p=reviewPoller(true)
 const original=await p.tick(0)
 p.invalidate()
 const failed=await p.tick(1000,true)
 expect(failed).toMatchObject({interaction:'native',unavailable:true,choices:{...original.choices,unavailable:true}})
 const recovered=await p.tick(2000)
 expect(recovered.choices).toEqual(original.choices)
 expect(recovered.unavailable).toBeUndefined()
})

it('omp Continue refuses a different question without sending Enter', async () => {
 const old = choices.screenChoices(fx('omp-ask-multi'), 'omp')!
 const call = vi.fn(async () => ({ read: { text: fx('omp-approve-bash') } }))
 const handler = await route('nav', call)
 vi.stubGlobal('findPane', () => ({ id: 'w1:p1', agent: 'omp', status: 'blocked' }))
 await expect(handler({}, { pane_id: 'w1:p1', key: 'enter', identity: old.identity })).rejects.toMatchObject({ code: 'stale' })
 expect(call).not.toHaveBeenCalledWith('pane.send_input', expect.anything())
})

it('an ambiguous terminal menu refuses a stale native choice', async () => {
 const text = fx('codex-usage-menu'), old = choices.screenChoices(text, 'codex')!
 const call = vi.fn(async () => ({ read: { text } }))
 const handler = await route('choose', call)
 await expect(handler({}, { pane_id: 'w1:p1', index: 0, label: old.options[0]!.label, identity: old.identity })).rejects.toMatchObject({ code: 'stale' })
 expect(call).not.toHaveBeenCalledWith('pane.send_input', expect.anything())
})


it.each([
 ['codex-approve-command', 'Agent Command Center'],
 ['codex-approve-edits', 'codex-command-center'],
 ['codex-approve-command', 'codex-usage-menu'],
])('answers a native approval below a quoted menu: %s / %s', async (file, quote) => {
 const text = `${quote.startsWith('codex-') ? fx(quote) : quote}\n\n${fx(file)}`, prompt = choices.screenChoices(text, 'codex')!
 const call = vi.fn(async () => ({ read: { text } }))
 const handler = await route('choose', call)
 await expect(handler({}, { pane_id: 'w1:p1', index: 0, label: prompt.options[0]!.label, identity: prompt.identity })).resolves.toEqual({ ok: true })
 expect(call).toHaveBeenCalledWith('pane.send_input', { pane_id: 'w1:p1', keys: ['enter'] })
})
