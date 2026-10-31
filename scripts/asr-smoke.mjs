// Standalone ASR smoke test: builds must already be running on ASR_URL.
// Loads /speech-test, loads the model, feeds a WAV, prints transcript + timings.
//   ASR_URL=http://127.0.0.1:7799 node scripts/asr-smoke.mjs /tmp/0.wav
import { chromium } from 'playwright'

const url = process.env.ASR_URL || 'http://127.0.0.1:7799'
const wav = process.argv[2] || '/tmp/0.wav'

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error' || m.text().includes('wasm') || m.text().includes('sherpa')) console.log('[pg]', m.text().slice(0, 200)) })
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)))

console.log('open', url + '/#/speech-test')
await page.goto(url + '/#/speech-test', { waitUntil: 'domcontentloaded' })
await page.click('button:has-text("Load model")')
await page.waitForSelector('.chip >> text=ready', { timeout: 120_000 })
const loadMs = await page.locator('.stats dd').first().textContent()
console.log('model load:', loadMs)

await page.setInputFiles('input[type=file]', wav)
await page.waitForSelector('.final', { timeout: 120_000 })
const final = await page.locator('.final').textContent()
const out = await page.locator('.out').innerText().catch(() => '')
const decode = await page.locator('.stats div:has-text("final decode") dd').textContent({ timeout: 3000 }).catch(() => 'n/a')
const chip = await page.locator('.chip').textContent().catch(() => '?')
console.log('status:', chip)
console.log('out:', JSON.stringify(out))
console.log('transcript:', final)
console.log('final decode:', decode)
await browser.close()
process.exit(final && final.trim().length ? 0 : 1)
