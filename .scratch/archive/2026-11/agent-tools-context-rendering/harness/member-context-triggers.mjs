import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const ROOT = `${process.env.HOME}/.dsh/sessions`
function* walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl.zstd')) yield p } }
const files = [...walk(ROOT)].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
const reasons = {}; let samples = 0
for (const f of files) {
  const r = spawnSync('zstd', ['-dc', f], { maxBuffer: 1024 * 1024 * 1024 }); if (r.status !== 0) continue
  let prev, eventsSince = 0, compactSince = false, turnsSince = 0
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (!line) continue; let ev; try { ev = JSON.parse(line) } catch { continue }
    eventsSince++
    if (/compact|rollover|surface/i.test(ev.type)) compactSince = true
    if (ev.type === 'turn/start' || ev.type === 'agent/turn-start') turnsSince++
    const d = ev.data
    if (ev.type === 'user/message' && /member-context/.test(d?.source?.kind ?? '')) {
      const text = (d.content || []).map(x => x.text ?? '').join('')
      let why
      if (prev === undefined) why = 'first in file'
      else if (prev === text) why = compactSince ? 'identical, after compaction/surface event' : 'IDENTICAL, no compaction between'
      else {
        // which part changed
        const parts = t => ({ id: t.split('\n\n')[0], own: /Team Project ownership[\s\S]*?(?=\n\n<team)/.exec(t)?.[0], mem: /<team-member-private-memory>[\s\S]*<\/team-member-private-memory>/.exec(t)?.[0], ws: /Team Workspace participation[\s\S]*$/.exec(t)?.[0] })
        const a = parts(prev), b = parts(text)
        why = 'changed: ' + ['id', 'own', 'mem', 'ws'].filter(k => a[k] !== b[k]).join('+')
      }
      reasons[why] = (reasons[why] ?? 0) + 1
      prev = text; eventsSince = 0; compactSince = false; turnsSince = 0
    }
  }
}
console.log(reasons)
