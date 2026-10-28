// Headless full-page screenshots for prototype-v2.html via CDP (no deps; Node 24 global WebSocket).
// Usage: node shot-v2.mjs [outDir]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [, , outDirArg] = process.argv
const HERE = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const OUT = resolve(outDirArg ?? HERE)
const TARGET = resolve(HERE, 'prototype-v2.html')
const PORT = 9222

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=/tmp/dsh-shot-v2-${process.pid}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1500,900', 'about:blank',
], { stdio: 'ignore' })

let ws, nextId = 1
const pending = new Map()

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = nextId++
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const page = list.find(t => t.type === 'page')
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        ws.onmessage = ev => {
          const msg = JSON.parse(ev.data)
          if (msg.id !== undefined && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
          }
        }
        return
      }
    } catch {}
    await delay(200)
  }
  throw new Error('chrome page never appeared')
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description}`)
  return r.result.value
}

async function shot(name, setup, width, height) {
  await send('Page.enable')
  if (width !== undefined) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width === 390 })
  }
  await send('Page.navigate', { url: 'file://' + TARGET })
  await delay(900)
  // sanity: the page really loaded (file:// + relative path silently fails)
  const title = await evaluate('document.title')
  const scrollH = await evaluate('document.body.scrollHeight')
  if (!title.includes('PROTOTYPE') || scrollH < 100) throw new Error(`navigation looks broken: title=${title} scrollHeight=${scrollH}`)
  if (setup) { await evaluate(setup); await delay(250) }
  const rect = await evaluate(`(() => { const s = document.querySelector('.stage'); const r = s.getBoundingClientRect(); const a = document.querySelector('.app').getBoundingClientRect(); return {x: a.x - r.x + r.x, y: r.y, w: a.width, h: a.height} })()`)
  const clip = { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 }
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
  const file = `${OUT}/${name}.png`
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`${name}.png  ${clip.width}x${clip.height}`)
}

try {
  await connect()
  await shot('shot-v2-channel', `app.dataset.col='reserve'; app.dataset.panel='open'; app.dataset.doneDensity='slim'; app.dataset.view='channel'`, 1500, 900)
  await shot('shot-v2-thread', `app.dataset.col='reserve'; app.dataset.panel='open'; document.querySelector('.anchor[data-open="thread"][data-task="117"]').click()`, 1500, 900)
  await shot('shot-v2-board', `app.dataset.col='reserve'; app.dataset.view='channel'; document.querySelector('[data-tab="board"]').click()`, 1500, 900)
  await shot('shot-v2-today-centered', `app.dataset.col='center'; app.dataset.panel='closed'; app.dataset.view='channel'; document.querySelector('[data-tab="chat"]').click()`, 1500, 900)
  await shot('shot-v2-mobile', `app.dataset.mobile='1'; app.dataset.mobilePanel='drawer'; app.dataset.panel='open'; app.dataset.view='channel'`, 450, 900)
  await shot('shot-v2-mention', `app.dataset.col='reserve'; app.dataset.panel='open'; app.dataset.view='channel'; document.querySelector('[data-tab="chat"]').click(); document.getElementById('tMention').click()`, 1500, 900)
} finally {
  ws?.close()
  chrome.kill()
}
