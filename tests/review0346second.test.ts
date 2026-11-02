import {readFileSync} from 'node:fs'
import {afterEach,it,expect,vi} from 'vitest'
import * as choices from '../server/utils/choices'
import * as wait from '../server/utils/waitScreen'
import * as menus from '../shared/menuScreen'
import {HerdrError} from '../server/utils/herdr'
import {ScreenCache,keepReading} from '../server/utils/screenCache'
import {ScreenGate,mapScreenPanes} from '../server/utils/screenGate'
import {bindFunction} from './stateFunction'
import {viaPrompt} from '../shared/sendRoute'
import {cardKey} from '../app/utils/cardKeys'
const fx=(n:string)=>readFileSync(`tests/fixtures/${n}`,'utf8')
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
async function route(name:string,call:any,extra:any={}){
 vi.useFakeTimers()
 for(const [k,v] of Object.entries({defineApi:(h:any)=>h,PANE_RE:/^w1:p1$/,HerdrError,...choices,...wait,
  findPane:()=>({id:'w1:p1',agent:'codex',status:'blocked'}),herdr:call,transcripts:{pendingClaudeQuestions:async()=>[]},
  choicesCache:new ScreenCache(),poll:()=>{},watchScreen:()=>{},...extra}))vi.stubGlobal(k,v)
 return (await import(`../server/api/${name}.post.ts`)).default
}
it('S1: different questions after the 300th character have distinct identities and reject the old answer',async()=>{
 const prefix='Please consider the current settings and deployment constraints carefully. '.repeat(5)
 const a=prefix+'Should the source database be deleted?', b=prefix+'Should the source database be preserved?'
 const suffix='\n\n› 1. Yes\n  2. No\n\nenter select · esc back'
 const old=choices.screenChoices(a+suffix,'codex')!,current=choices.screenChoices(b+suffix,'codex')!
 expect(a).not.toBe(b);expect(old).toBeTruthy();expect(current.question).toBe(old.question);expect(current.identity).not.toBe(old.identity)
 const call=vi.fn(async()=>({read:{text:b+suffix}}));const handler=await route('choose',call)
 await expect(handler({}, {pane_id:'w1:p1',index:0,label:'Yes',identity:old.identity})).rejects.toMatchObject({code:'stale'})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 await expect(handler({}, {pane_id:'w1:p1',index:0,label:'Yes',identity:current.identity})).resolves.toEqual({ok:true})
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['enter']})
})
it('S2: native menu click rejects another session with the same title',async()=>{
 const old=menus.parseMenu(fx('claude-resume.ansi'))!
 const next=menus.parseMenu(fx('claude-resume.ansi').replace('main · 244KB','feature · 512KB'))!
 expect(choices.menuIdentity(next)).not.toBe(choices.menuIdentity(old))
 const call=vi.fn(async()=>({}));const handler=await route('menu',call,{readMenu:async()=>next})
 await expect(handler({}, {pane_id:'w1:p1',op:'select',index:old.cursor,label:old.items[old.cursor!]!.label,identity:choices.menuIdentity(old)})).rejects.toMatchObject({code:'stale'})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 await expect(handler({}, {pane_id:'w1:p1',op:'select',index:next.cursor,label:next.items[next.cursor!]!.label,identity:choices.menuIdentity(next)})).resolves.toEqual({ok:true})
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['enter']})
})
it('S3: arrows do not authorize Enter on a changed question; missing identity also fails closed',async()=>{
 let text=fx('codex-request-increase.txt');const old=choices.screenChoices(text,'codex')!
 const call=vi.fn(async()=>({read:{text}}));const handler=await route('nav',call)
 await handler({}, {pane_id:'w1:p1',key:'down'})
 text=fx('codex-approaching-limits.txt');call.mockClear()
 for(const identity of [old.identity,undefined])await expect(handler({}, {pane_id:'w1:p1',key:'enter',identity})).rejects.toMatchObject({code:'stale'})
 expect(call.mock.calls.every(c=>c[0]==='pane.read')).toBe(true)
})
it('native card keyboard does not translate y/n or Tab into confirmations',()=>{
 const focus={editable:false,empty:true,control:false,overlay:false}
 for(const key of ['y','n','Tab'])expect(cardKey({key,code:key,isComposing:false} as any,focus,{digits:9,enter:true,tabs:true})).toBeNull()
})
it('S4: publishes the viewed pane at 250ms while the twenty-pane batch still takes 40s',async()=>{
 vi.useFakeTimers()
 const source=readFileSync('server/utils/state.ts','utf8')
 const panes=Array.from({length:20},(_,i)=>({id:`w1:p${i+1}`,agent:'codex',status:'blocked',agentSession:'neutral'}))
 const map=()=>new Map();const finished:string[]=[]
 const states=new Map([['',{ok:true,workspaces:[],panes:panes.map(p=>({...p,preview:'previous'}))}]])
 const choicesFor=vi.fn(async(p:any)=>{await new Promise(r=>setTimeout(r,p.id==='w1:p20'?250:4000));finished.push(p.id);return {choices:choices.screenChoices(fx('codex-request-increase.txt'),'codex'),interaction:'native'}})
 const versions=new WeakMap();const cache=new ScreenCache()
 const enrich=bindFunction(source,'enrich',{
 seenMachines:new Set(['']),mstates:states,agentBorn:new Map(panes.map(p=>[p.id,{agent:p.agent,at:null}])),
 selfUpdates:{prune:()=>{},observe:async()=>false},commands:map(),READY:new Set(),
 getMachine:()=>({transcripts:{observe:()=>{}}}),joinId:(_:string,id:string)=>id,restarts:map(),leftForGood:()=>false,lookForLeftMenu:()=>false,
 findPane:()=>null,pendingPrompts:map(),queued:map(),screenVersions:versions,mapScreenPanes,choicesFor,refreshModel:()=>{},refreshPreview:()=>{},
 previews:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),models:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),
 isViewed:(id:string)=>id==='w1:p20',activities:map(),ompStatuses:map(),ocStatuses:map(),ocInboxes:map(),refreshOcStatus:()=>{},codexFields:map(),codexStatus:{forget:()=>{},statusOf:()=>null}, choicesCache:new ScreenCache(),askChecks:map(),takenBack:map(),seen:map(),saveBorn:()=>{},saveSeen:()=>{},saveQueued:()=>{},machineOf:()=>''})
 const publish=vi.fn(()=>JSON.parse(JSON.stringify(states.get(''))))
 const pollMachine=bindFunction(source,'pollMachine',{mstates:states,screenVersions:versions,choicesCache:cache,screenFields:(p:any)=>p,herdrOn:async()=>({panes:panes.map(p=>({pane_id:p.id,revision:7}))}),
 reduceSnapshot:()=>({ok:true,workspaces:[],panes}),HERDR_SESSION:'test',enrich,RemoteMachine:class {},getMachine:()=>({}),rebuild:publish,watchTransitions:()=>{}})
 let published=false;const run=pollMachine({key:'',local:true}).then(()=>{published=true})
 await vi.advanceTimersByTimeAsync(250);expect(finished).toEqual(['w1:p20']);expect(published).toBe(false)
 expect(publish).toHaveBeenCalledTimes(1)
 const early=publish.mock.results[0]!.value
 expect(early.panes[19]).toMatchObject({id:'w1:p20',prompt:{identity:expect.any(String)}})
 expect(early.panes[0].preview).toBe('previous')
 await vi.advanceTimersByTimeAsync(35750);expect(published).toBe(false)
 await vi.advanceTimersByTimeAsync(4000);await run;expect(published).toBe(true);expect(finished).toHaveLength(20)
 expect(publish).toHaveBeenCalledTimes(2)
 expect(states.get('')!.panes.every(p=>(p as any).prompt)).toBe(true)
})
it('S5: gates drain every finite queued pane across machines despite more incoming work',async()=>{
 vi.useFakeTimers();const gate=new ScreenGate();const started:string[]=[]
 const run=(id:string,machine:string)=>gate.run(machine,async()=>{started.push(id);await new Promise(r=>setTimeout(r,250))})
 const initial=['a','b','c'].flatMap(m=>Array.from({length:20},(_,i)=>run(`${m}${i}`,m)))
 await vi.advanceTimersByTimeAsync(250)
 const incoming=Array.from({length:20},(_,i)=>run(`extra${i}`,'a'))
 await vi.runAllTimersAsync();await Promise.all([...initial,...incoming]);expect(new Set(started).size).toBe(80)
})
it('multiple visible devices or terminals independently enable the one-second cache',()=>{
 const clients=new Map([['one',{pane:'w1:p1',visible:true}],['two',{pane:'w1:p2',visible:true}],['hidden',{pane:'w1:p3',visible:false}]])
 const terminals=new Set([{pane:'w1:p4',visible:true}])
 const viewed=bindFunction(readFileSync('server/utils/state.ts','utf8').replace('export function isViewed','function isViewed'),'isViewed',{eventClients:clients,termSessions:terminals})
 for(const id of ['w1:p1','w1:p2','w1:p4'])expect(viewed(id)).toBe(true)
 expect(viewed('w1:p3')).toBe(false)
 const c={rev:1,strict:false,at:0,choices:{},screen:null,menu:null}
 expect(keepReading(c,1,false,false,1000,viewed('w1:p1'))).toBe(false)
 expect(keepReading(c,1,false,false,1000,viewed('w1:p3'))).toBe(true)
})
it('invalidation survives a cache miss and forgetting/recreating the same pane id',()=>{
 const c=new ScreenCache();const before=c.version('w1:p1');c.delete('w1:p1');expect(c.version('w1:p1')).not.toBe(before)
 const second=c.version('w1:p1');c.forget('w1:p1');expect(c.version('w1:p1')).not.toBe(second)
})

it('S6: typed native-card answers reject changed or missing identity; raw terminal input stays free',async()=>{
 const old=choices.screenChoices(fx('codex-request-increase.txt'),'codex')!
 const next=choices.screenChoices(fx('codex-approaching-limits.txt'),'codex')!
 expect(viaPrompt({agent:'codex',status:'blocked',prompt:old})).toBe(false)
 const call=vi.fn(async()=>({read:{text:fx('codex-approaching-limits.txt')}}));const queued={id:'neutral'}
 const handler=await route('input',call,{withPaneLock:async(_:string,work:any)=>work(),addQueued:()=>queued})
 for(const identity of [old.identity,undefined])await expect(handler({}, {pane_id:'w1:p1',text:'n',keys:['enter'],native:true,identity})).rejects.toMatchObject({code:'stale'})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 await expect(handler({}, {pane_id:'w1:p1',text:'n',keys:['enter'],native:true,identity:next.identity})).resolves.toEqual({ok:true,queued})
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['enter']})
 call.mockClear()
 await handler({}, {pane_id:'w1:p1',text:'raw',keys:['enter']})
 expect(call.mock.calls.some(c=>c[0]==='pane.read')).toBe(false)
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',text:'raw'})
})

it('S7: the raw input route cannot answer a blocked OpenCode dialog — old clients included',async()=>{
 // A tab opened before viaPrompt routed OpenCode still posts /api/input:
 // server-side the message holds; a bare Enter is refused outright.
 const call=vi.fn(async()=>({read:{text:''}}));const queued={id:'held-oc'}
 const handler=await route('input',call,{withPaneLock:async(_:string,work:any)=>work(),addQueued:()=>queued,
  findPane:()=>({id:'w1:p1',agent:'opencode',status:'blocked'})})
 await expect(handler({}, {pane_id:'w1:p1',text:'looks good',keys:['enter']})).resolves.toEqual({ok:true,queued})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 await expect(handler({}, {pane_id:'w1:p1',keys:['enter']})).rejects.toMatchObject({code:'stale'})
 expect(call).not.toHaveBeenCalledWith('pane.send_input',expect.anything())
 // Not blocked: the raw route types into the composer like before.
 const idle=await route('input',call,{withPaneLock:async(_:string,work:any)=>work(),addQueued:()=>queued,
  findPane:()=>({id:'w1:p1',agent:'opencode',status:'idle'})})
 await idle({}, {pane_id:'w1:p1',text:'hello',keys:['enter']})
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',text:'hello'})
})
