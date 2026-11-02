import {readFileSync} from 'node:fs'
import {afterEach,it,expect,vi} from 'vitest'
import * as choices from '../server/utils/choices'
import * as wait from '../server/utils/waitScreen'
import * as menus from '../shared/menuScreen'
import {HerdrError} from '../server/utils/herdr'
import {ScreenCache,keepReading} from '../server/utils/screenCache'
import {ScreenGate,mapScreenPanes} from '../server/utils/screenGate'
import {bindChoices,bindFunction} from './stateFunction'
const fx=(n:string)=>readFileSync(`tests/fixtures/${n}`,'utf8')
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
async function route(name:string,call:any,extra:any={}){
 vi.useFakeTimers()
 for(const [k,v] of Object.entries({defineApi:(h:any)=>h,PANE_RE:/^w1:p1$/,HerdrError,...choices,...wait,
  findPane:()=>({id:'w1:p1',agent:'codex',status:'blocked'}),herdr:call,transcripts:{pendingClaudeQuestions:async()=>[],forget:()=>{}},
  choicesCache:new ScreenCache(),poll:()=>{},watchScreen:()=>{},...extra}))vi.stubGlobal(k,v)
 return (await import(`../server/api/${name}.post.ts`)).default
}
import * as settings from '../shared/settingsScreen'
import {classifyScreen} from '../shared/interactiveScreen'
import {parseUsageLimit} from '../shared/usageLimit'
import {isPermissionQuestion,mergeDetail} from '../server/utils/promptDetail'
it('S7: independent viewed reads publish within two seconds and survive the old batch',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0)
 const source=readFileSync('server/utils/state.ts','utf8')
 const panes=Array.from({length:20},(_,i)=>({id:`w1:p${i+1}`,agent:'codex',status:'blocked',agentSession:'neutral'}))
 const map=()=>new Map();const finished:string[]=[]
 let viewing=true;const isViewed=(id:string)=>viewing&&id==='w1:p20'
 const gate=new ScreenGate();const versions=new WeakMap();const busy=new Set<string>()
 let active=0,peak=0
 const states=new Map([['',{ok:true,workspaces:[],panes:panes.map(p=>({...p,preview:'previous'}))}]])
 let text=fx('codex-request-increase.txt');const viewedReads:number[]=[];const cache=new ScreenCache()
 const nativeViewed=bindFunction(source,'nativeViewed',{isViewed})
 const screenMachine=bindFunction(source,'screenMachine',{getMachine:()=>({local:true})})
 const screenFields=bindFunction(source,'screenFields',{})
 bindFunction(source,'focusScreenGate',{screenMachine,screenRpcGate:gate,mstates:states,nativeViewed,isViewed,joinId:(_:string,id:string)=>id})()
 const choicesFor=bindChoices(source,{
 ...choices,...wait,...menus,...settings,classifyScreen,parseUsageLimit,keepReading,isPermissionQuestion,mergeDetail,
 choicesCache:cache,screenWatch:new Map(),askChecks:new Map(),isViewed,
 modelControlBusy:()=>false,noteScreen:()=>{},readMenu:async()=>null,
 transcripts:{pendingClaudeQuestions:async()=>[],pendingTool:async()=>null},
 herdr:async(_:string,params:any)=>gate.run('',async()=>{
  active++;peak=Math.max(peak,active)
  const viewed=params.pane_id==='w1:p20';if(viewed)viewedReads.push(Date.now())
  const captured=viewed?text:fx('codex-request-increase.txt')
  await new Promise(r=>setTimeout(r,viewed?250:4000));finished.push(params.pane_id)
  active--;return {read:{text:captured}}
 },params.pane_id)})

 const enrich=bindFunction(source,'enrich',{
 seenMachines:new Set(['']),mstates:states,agentBorn:new Map(panes.map(p=>[p.id,{agent:p.agent,at:null}])),
 selfUpdates:{prune:()=>{},observe:async()=>false},commands:map(),READY:new Set(),
 getMachine:()=>({transcripts:{observe:()=>{}}}),joinId:(_:string,id:string)=>id,restarts:map(),leftForGood:()=>false,lookForLeftMenu:()=>false,
 findPane:()=>null,pendingPrompts:map(),queued:map(),screenVersions:versions,mapScreenPanes,choicesFor,refreshModel:()=>{},refreshPreview:()=>{},
 previews:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),models:new Map(panes.map(p=>[p.id,{status:'blocked',at:Date.now()}])),
 isViewed,activities:map(),ompStatuses:map(),ocStatuses:map(),ocInboxes:map(),refreshOcStatus:()=>{},codexFields:map(),codexStatus:{forget:()=>{},statusOf:()=>null},chatDelta:{ids:()=>[],forget:()=>{}}, choicesCache:cache,askChecks:map(),takenBack:map(),seen:map(),saveBorn:()=>{},saveSeen:()=>{},saveQueued:()=>{},machineOf:()=>''})
 const publish=vi.fn(()=>({at:Date.now(),state:JSON.parse(JSON.stringify(states.get('')))}))
 const pollMachine=bindFunction(source,'pollMachine',{mstates:states,screenVersions:versions,choicesCache:cache,screenFields,herdrOn:async()=>({panes:panes.map(p=>({pane_id:p.id,revision:7}))}),
 reduceSnapshot:()=>({ok:true,workspaces:[],panes:panes.map(p=>({...p}))}),HERDR_SESSION:'test',enrich,RemoteMachine:class {},getMachine:()=>({}),rebuild:publish,watchTransitions:()=>{}})
 const m={key:'',local:true};const first=pollMachine(m)
 const pollViewed=bindFunction(source,'pollViewed',{screenMachine,keepReading,mstates:states,choicesCache:cache,nativeViewed,viewedBusy:busy,choicesFor,stopped:false,rebuild:publish,CHOICE_MS:1000})
 // Use the production completion-driven scheduler, while the machine poll is pending.
 bindFunction(source.replace('export function startPolling','function startPolling'),'startPolling',{stopped:false,focusScreenGate:()=>{},viewedTimer:null,pollViewed,allMachines:()=>[m],LOCAL:'',inflight:new Map(),pollOne:()=>first,localMachineOf:()=>m,pollTimer:null,POLL_MS:1000})()
 await vi.advanceTimersByTimeAsync(250)
 expect(publish.mock.results[0]!.value.state.panes[19].prompt.question).toBe('Request increase?')
 await vi.advanceTimersByTimeAsync(1);text=fx('codex-approaching-limits.txt');const changedAt=Date.now()
 await vi.advanceTimersByTimeAsync(1249)
 const latest=publish.mock.results.at(-1)!.value
 expect(latest.state.panes[19].prompt.question).toContain('Approaching rate limits')
 expect(latest.at-changedAt).toBeLessThan(2000);expect(latest.at-changedAt).toBe(1249)
 expect(viewedReads).toEqual([0,1250]);expect(peak).toBeLessThanOrEqual(2)
 console.log(JSON.stringify({changedAt,publishedAt:latest.at,staleMs:latest.at-changedAt,viewedReads}))
 // The slower batch must never republish question 1 after the independent read.
 await vi.advanceTimersByTimeAsync(78500);await first
 const updates=publish.mock.results.map(r=>r.value).filter(r=>r.at>=latest.at)
 expect(updates.every(r=>r.state.panes[19].prompt.question.includes('Approaching rate limits'))).toBe(true)
 expect(finished.filter(id=>id!=='w1:p20')).toHaveLength(19)
 viewing=false;await vi.advanceTimersByTimeAsync(1000);vi.clearAllTimers()
 expect(active).toBe(0)

})

it.each([false,true])('S8: scrolling confirms only while the target details stay unchanged (%s)',async(changed)=>{
 const raw=fx('claude-resume.ansi')
 const old=menus.parseMenu(raw)!
 // The viewport scrolls: the first session leaves, the target stays and gains the cursor.
 const shifted=raw.split('\n').filter(l=>!l.includes('Review the module')&&!l.includes('3 seconds ago')).join('\n').replace('     Fix the tests','   ❯ Fix the tests')
 const next=menus.parseMenu(shifted)!
 if(changed)next.items[next.cursor!]!.hint += ' changed'
 const target=old.items.findIndex(i=>i.label==='Fix the tests')
 expect(target).toBeGreaterThan(old.cursor!)
 expect(next.items[next.cursor!]!.label).toBe('Fix the tests')
 const read=vi.fn().mockResolvedValueOnce(old).mockResolvedValue(next)
 const call=vi.fn(async()=>({}));const handler=await route('menu',call,{readMenu:read,sleep:(ms:number)=>new Promise(r=>setTimeout(r,ms))})
 const run=handler({}, {pane_id:'w1:p1',op:'select',index:target,label:old.items[target]!.label,identity:choices.menuIdentity(old,old.items[target])})
 const check=changed?expect(run).rejects.toMatchObject({code:'stale'}):expect(run).resolves.toEqual({ok:true})
 await vi.runAllTimersAsync();await check
 expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['down']})
 if(changed)expect(call).not.toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['enter']})
 else expect(call).toHaveBeenCalledWith('pane.send_input',{pane_id:'w1:p1',keys:['enter']})
})

it.each(['invalidate','hidden','stop','agent','working','machine'])('independent publication refuses a stale owner after %s',async(change)=>{
 vi.useFakeTimers();vi.stubGlobal('stopped',false)
 const p={id:'w1:p1',agent:'codex',status:'blocked',agentSession:'neutral',prompt:choices.screenChoices(fx('codex-request-increase.txt'),'codex')!}
 const states=new Map([['',{ok:true,panes:[p]}]]),cache=new ScreenCache<any>(),busy=new Set<string>()
 cache.set(p.id,{rev:7,strict:false,at:Date.now()-2000,choices:p.prompt})
 let connected=true;const screenMachine=bindFunction(readFileSync('server/utils/state.ts','utf8'),'screenMachine',{getMachine:()=>connected?{local:true}:undefined})
 let visible=true;const nativeViewed=bindFunction(readFileSync('server/utils/state.ts','utf8'),'nativeViewed',{isViewed:()=>visible})
 let release!:(v:any)=>void;const waiting=new Promise(r=>{release=r}),publish=vi.fn()
 const tick=bindFunction(readFileSync('server/utils/state.ts','utf8'),'pollViewed',{screenMachine,mstates:states,choicesCache:cache,nativeViewed,viewedBusy:busy,
 keepReading,choicesFor:()=>{cache.invalidate(p.id);return waiting},rebuild:publish,CHOICE_MS:1000})
 tick();tick();expect(busy.size).toBe(1)
 if(change==='invalidate')cache.delete(p.id)
 if(change==='hidden')visible=false
 if(change==='machine')connected=false
 if(change==='stop')vi.stubGlobal('stopped',true)
 if(change==='agent')p.agentSession='replacement'
 if(change==='working')p.status='working'
 // The captured pane and latest pane must be distinct, as in production snapshots.
 if(change==='agent'){states.set('',{ok:true,panes:[{...p}]});p.agentSession='neutral'}
 release({choices:choices.screenChoices(fx('codex-approaching-limits.txt'),'codex'),screen:null,menu:null,interaction:'native'})
 await vi.advanceTimersByTimeAsync(1000)
 expect(publish).not.toHaveBeenCalled();expect(states.get('')!.panes[0]!.prompt.question).toBe('Request increase?')
 expect(busy.size).toBe(0)
})
it('RPC priority reserves capacity without exceeding either limit and releases it for background work',async()=>{
 const gate=new ScreenGate();gate.priority=(_,pane)=>pane==='view';gate.reserved=machine=>machine===undefined||machine==='a'
 let active=0,peak=0;const per=new Map<string,number>(),peaks=new Map<string,number>(),started:string[]=[],releases:(()=>void)[]=[]
 const run=(machine:string,id:string)=>gate.run(machine,async()=>{
  active++;peak=Math.max(peak,active);per.set(machine,(per.get(machine)||0)+1);peaks.set(machine,Math.max(peaks.get(machine)||0,per.get(machine)!));started.push(id)
  await new Promise<void>(r=>releases.push(r));active--;per.set(machine,per.get(machine)!-1)
 },id)
 const jobs=['a','a','a','b','b','c','c'].map((m,i)=>run(m,String(i)))
 await Promise.resolve();expect(active).toBe(3);expect(started).not.toContain('1')
 jobs.push(run('a','view'));await Promise.resolve();expect(active).toBe(4);expect(started).toContain('view')
 gate.reserved=()=>false
 while(releases.length){releases.splice(0).forEach(r=>r());for(let i=0;i<8;i++)await Promise.resolve()}
 await Promise.all(jobs);expect(started).toHaveLength(8);expect(peak).toBe(4);expect([...peaks.values()].every(n=>n<=2)).toBe(true)
})

it('display loops share a pending capture but invalidation starts a fresh owner',async()=>{
 const cache=new ScreenCache(),releases:((v:any)=>void)[]=[]
 const call=vi.fn(()=>new Promise(r=>releases.push(r)))
 const read=bindChoices(readFileSync('server/utils/state.ts','utf8'),{
  ...choices,...wait,...menus,...settings,classifyScreen,parseUsageLimit,keepReading,isPermissionQuestion,mergeDetail,
  choicesCache:cache,screenWatch:new Map(),askChecks:new Map(),isViewed:()=>true,modelControlBusy:()=>false,noteScreen:()=>{},
  herdr:call,readMenu:async()=>null,transcripts:{pendingClaudeQuestions:async()=>[],pendingTool:async()=>null}})
 const p={id:'w1:p1',agent:'codex',status:'blocked',agentSession:'neutral'}
 const first=read(p,7,false),shared=read(p,7,false)
 expect(call).toHaveBeenCalledTimes(1)
 cache.delete(p.id)
 const fresh=read(p,7,false)
 expect(call).toHaveBeenCalledTimes(2)
 releases[1]!({read:{text:fx('codex-approaching-limits.txt')}})
 const current=await fresh
 releases[0]!({read:{text:fx('codex-request-increase.txt')}})
 expect((await first).choices.identity).toBe(current.choices.identity)
 expect((await shared).choices.identity).toBe(current.choices.identity)
 expect((cache.get(p.id) as any).choices.identity).toBe(current.choices.identity)
})

it('an older batch retains a newer quota reading and its idle status',async()=>{
 const source=readFileSync('server/utils/state.ts','utf8'),cache=new ScreenCache(),versions=new WeakMap()
 const pane={id:'w1:p1',agent:'claude',agentSession:'neutral',status:'blocked',prompt:{question:'Old question'}}
 const states=new Map([['',{ok:true,panes:[pane]}]]);let finish!:()=>void
 const handler=bindFunction(source,'pollMachine',{mstates:states,choicesCache:cache,screenVersions:versions,screenFields:bindFunction(source,'screenFields',{}),
 herdrOn:async()=>({}),reduceSnapshot:()=>({ok:true,panes:[pane]}),HERDR_SESSION:'test',RemoteMachine:class {},getMachine:()=>({}),rebuild:()=>{},watchTransitions:()=>{},
 enrich:async()=>{versions.set(pane,cache.version(pane.id));await new Promise<void>(r=>{finish=r})}})
 const run=handler({key:'',local:true});await Promise.resolve()
 cache.invalidate(pane.id)
 states.set('',{ok:true,panes:[{...pane,status:'idle',prompt:undefined,usageLimit:{resets:null}} as any]})
 finish();await run
 expect(states.get('')!.panes[0]).toMatchObject({status:'idle',usageLimit:{resets:null},prompt:undefined})
})
