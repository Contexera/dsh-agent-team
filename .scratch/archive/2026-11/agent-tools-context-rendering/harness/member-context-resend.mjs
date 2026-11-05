import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const ROOT = `${process.env.HOME}/.dsh/sessions`
function* walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl.zstd')) yield p } }
const changed = [], resent = []; let sessionsWithMany = 0; const perFile = []
for (const f of walk(ROOT)) {
  const r = spawnSync('zstd', ['-dc', f], { maxBuffer: 1024 * 1024 * 1024 }); if (r.status !== 0) continue
  let prev; let n = 0
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (!line.includes('member-context')) continue; let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'user/message' || !/member-context/.test(ev.data?.source?.kind ?? '')) continue
    const text = (ev.data.content || []).map(x => x.text ?? '').join(''); n++
    if (prev !== undefined && prev !== text) {
      let i = 0; while (i < prev.length && prev[i] === text[i]) i++
      let j = 0; while (j < prev.length - i && prev[prev.length - 1 - j] === text[text.length - 1 - j]) j++
      changed.push(Math.max(text.length - i - j, prev.length - i - j)); resent.push(text.length)
    }
    prev = text
  }
  perFile.push(n)
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))] }
console.log('re-sends after a change:', changed.length)
console.log('changed span chars  p50', q(changed, .5), 'p90', q(changed, .9))
console.log('re-sent block chars p50', q(resent, .5), 'p90', q(resent, .9))
console.log('total re-sent', resent.reduce((a, b) => a + b, 0), 'vs total changed span', changed.reduce((a, b) => a + b, 0))
console.log('injections per session file p50', q(perFile.filter(x => x > 0), .5), 'p90', q(perFile.filter(x => x > 0), .9), 'max', Math.max(...perFile))
