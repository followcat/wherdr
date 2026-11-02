import {readFileSync} from 'node:fs'
import {expect,test} from './test'
import {OMP_CHAT_PANE as pane,fakeHerdr} from './scenario.mjs'
const fx=(name:string)=>readFileSync(new URL(`../fixtures/${name}.txt`,import.meta.url),'utf8')
const show=(text:string|null,agent='codex')=>fakeHerdr('e2e.interaction_screen',{pane_id:pane,text,agent,status:'blocked'})
test.afterEach(async({request})=>{
 await fakeHerdr('e2e.read_failure',{pane_id:pane,fail:false})
 await fakeHerdr('e2e.interaction_screen',{pane_id:pane,text:null,agent:'omp',status:'idle'})
 // The fake mutation precedes wherdr's next poll. Do not let the next spec
 // cache commands for the previous agent while its state is still published.
 await expect.poll(async()=>{
  const state=await (await request.get('/api/state')).json()
  const p=state.panes.find((p:{id:string})=>p.id===pane)
  return {agent:p?.agent,status:p?.status,prompt:p?.prompt??null}
 }).toEqual({agent:'omp',status:'idle',prompt:null})
})
test('Typed input: typed n on the old Codex card is refused before reaching the next question',async({page})=>{
 await show(fx('codex-request-increase'));await page.goto(`/#/a/${pane}`)
 await expect(page.locator('.choices-q')).toContainText('Request increase?')
 await page.locator('.composer textarea').fill('n')
 let release!:()=>void,arrive!:()=>void
 const held=new Promise<void>(r=>{release=r}),arrived=new Promise<void>(r=>{arrive=r})
 await page.route('**/api/input',async route=>{arrive();await held;await route.continue()})
 const response=page.waitForResponse('**/api/input')
 await page.getByRole('button',{name:'Send',exact:true}).click();await arrived
 await show(fx('codex-approaching-limits'));release()
 const sent=await response;expect(sent.ok()).toBe(false)
 expect(sent.request().postDataJSON()).toMatchObject({text:'n',keys:['enter'],native:true,identity:expect.any(String)})
 expect((await fakeHerdr('e2e.terminal_screen',{pane_id:pane})).keys).toEqual([])
 await expect(page.locator('.composer textarea')).toHaveValue('n')
})
test('Read recovery: repeated failed reads keep the draft disabled and Terminal stays accessible',async({page})=>{
 await page.clock.install()
 await show(fx('claude-ask-long'),'claude');await page.goto(`/#/a/${pane}`)
 await page.locator('.choices-list button[aria-expanded]').click()
 const draft=page.locator('.choices-free textarea');await draft.fill('Keep my answer')
 await fakeHerdr('e2e.read_failure',{pane_id:pane,fail:true})
 await expect(draft).toBeDisabled();await expect(page.getByRole('status').filter({hasText:'Screen read failed'})).toBeVisible();await page.clock.fastForward(3500)
 await expect(draft).toBeDisabled();await expect(draft).toHaveValue('Keep my answer')
 await expect(page.locator('.interactive-terminal')).toHaveCount(0)
 await fakeHerdr('e2e.read_failure',{pane_id:pane,fail:false})
 await expect(draft).toBeEnabled();await expect(draft).toHaveValue('Keep my answer')
 await fakeHerdr('e2e.read_failure',{pane_id:pane,fail:true})
 await expect(draft).toBeDisabled()
 const terminal=page.getByRole('button',{name:test.info().project.name.includes('phone')?'Terminal':'Show terminal',exact:true})
 await expect(terminal).toBeEnabled();await terminal.click()
 await expect(page.locator('.xterm')).toBeVisible()
})

test('Menu selection: a native menu click carries its identity and refuses a changed session',async({page})=>{
 const text=readFileSync(new URL('../fixtures/claude-resume.ansi',import.meta.url),'utf8')
 await show(text,'claude');await page.goto(`/#/a/${pane}`)
 const selected=page.locator('.menu-list button.cur')
 await expect(selected).toBeVisible()
 let release!:()=>void,arrive!:()=>void
 const held=new Promise<void>(r=>{release=r}),arrived=new Promise<void>(r=>{arrive=r})
 await page.route('**/api/menu',async route=>{arrive();await held;await route.continue()})
 const response=page.waitForResponse('**/api/menu')
 await selected.click();await arrived
 await show(text.replace('main · 244KB','feature · 512KB'),'claude');release()
 const sent=await response;expect(sent.ok()).toBe(false)
 expect(sent.request().postDataJSON()).toMatchObject({op:'select',identity:expect.any(String)})
 expect((await fakeHerdr('e2e.terminal_screen',{pane_id:pane})).keys).toEqual([])
})

test('Keyboard: a rapid arrow then Enter uses the displayed target identity',{ tag: '@chromium-desktop' },async({page})=>{
 test.skip(!test.info().project.name.includes('desktop'),'Keyboard navigation is a desktop control')
 const text=readFileSync(new URL('../fixtures/claude-resume.ansi',import.meta.url),'utf8')
 await show(text,'claude');await page.goto(`/#/a/${pane}`)
 await expect(page.locator('.choices-menu')).toBeVisible()
 let release!:()=>void,arrive!:()=>void
 const held=new Promise<void>(r=>{release=r}),arrived=new Promise<void>(r=>{arrive=r})
 await page.route('**/api/nav',async route=>{if(route.request().postDataJSON().key==='down'){arrive();await held}await route.continue()})
 const response=page.waitForResponse(r=>r.url().endsWith('/api/nav')&&r.request().postDataJSON().key==='enter')
 await page.locator('.choices-q').click();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await arrived
 await show(text.replace('   ❯ Review the module','     Review the module').replace('     Fix the tests','   ❯ Fix the tests'),'claude');release()
 expect((await response).ok()).toBe(true)
 expect((await fakeHerdr('e2e.terminal_screen',{pane_id:pane})).keys).toEqual(['down','enter'])
})

// Omp Continue stale-screen rejection moved to tests/review0346.test.ts
// "omp Continue refuses a different question without sending Enter".
// Transient draft recovery is covered by Read recovery above and
// tests/review0346.test.ts "R3: one failed read keeps the native card disabled and retries at the next poll".
test('Card keyboard: Enter on an old card refuses the new question without sending a key',{ tag: '@chromium-desktop' },async({page})=>{
 test.skip(!test.info().project.name.includes('desktop'), 'Card keyboard is a desktop control')
 await show(fx('codex-request-increase'));await page.goto(`/#/a/${pane}`)
 await expect(page.locator('.choices-list')).toContainText('Yes (y)')
 let release!:()=>void,arrive!:()=>void
 const held=new Promise<void>(r=>{release=r}),arrived=new Promise<void>(r=>{arrive=r})
 await page.route('**/api/nav',async route=>{arrive();await held;await route.continue()})
 const response=page.waitForResponse('**/api/nav')
 await page.locator('.choices-q').click();await page.keyboard.press('Enter');await arrived
 await show(fx('codex-approaching-limits'));release()
 expect((await response).ok()).toBe(false)
 expect((await fakeHerdr('e2e.terminal_screen',{pane_id:pane})).keys).toEqual([])
 await page.unroute('**/api/nav')
 await expect(page.locator('.choices-q')).toContainText('lower credit usage')
 await page.locator('.choices-q').click()
 await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter')
 await expect.poll(async()=> (await fakeHerdr('e2e.terminal_screen',{pane_id:pane})).keys).toEqual(['up','enter'])
})


test('Answer validation: a failed answer validation keeps its card and unsent draft',async({page})=>{
 await show(fx('claude-ask-long'),'claude');await page.goto(`/#/a/${pane}`)
 await page.locator('.choices-list button[aria-expanded]').click()
 const draft=page.locator('.choices-free textarea')
 await draft.fill('Preserve this failed answer')
 let release!:()=>void,arrive!:()=>void
 const held=new Promise<void>(r=>{release=r}),arrived=new Promise<void>(r=>{arrive=r})
 await page.route('**/api/choose',async route=>{arrive();await held;await route.continue()})
 const response=page.waitForResponse('**/api/choose')
 await page.locator('.choices-free button[type=submit]').click();await arrived
 await fakeHerdr('e2e.read_failure',{pane_id:pane,fail:true});release()
 expect((await response).ok()).toBe(false)
 await expect(draft).toBeDisabled()
 await expect(draft).toHaveValue('Preserve this failed answer')
 await expect(page.locator('.interactive-terminal')).toHaveCount(0)
 await fakeHerdr('e2e.read_failure',{pane_id:pane,fail:false})
 await expect(draft).toBeEnabled()
 await expect(draft).toHaveValue('Preserve this failed answer')
 expect((await fakeHerdr('e2e.terminal_screen',{pane_id:pane})).keys).toEqual([])
})
