// Evaluation scan (11-04b): TEAM TOOL RESULT OUTPUT QUALITY from real session
// logs — the dimension Human called out as my job. Judges results against the
// agent-tools-context-rendering spec promises, mechanically + sample eyeball:
//   A. rejection → recovery: after a rejected call, does the member's next
//      same-tool call (within 5) succeed? (spec §7.1 actionable recovery)
//   B. read forward progress: consecutive identical team_thread read results
//      (spec §4.1 一次调用必须前进, no repeated same opening)
//   C. long-message part chains: "Message part X–Y of Z" — zero-length parts,
//      chain completion, "body already in current context; omitted" (§4.1/§4.2)
//   D. commit result conciseness: text length per tool/action; successes must
//      not replay bodies (§7.1 成功给本次变化…不重放全部正文)
//   E. notification shape: direct-mention notices carry the body; ordinary
//      unread notices give entry+counts without copying bodies (§6)
// Era split at v0.2.6 release day 2026-10-31. Read-only, offline, private.
// Provenance: promoted 2026-11-05 from Vera's private observation scripts into this
// archived harness so the 07 acceptance material is reproducible without the
// reviewer's machine layout. Aggregates only are quoted in the material; the JSON
// output deliberately defaults OUTSIDE the repository, because it contains real
// rejection samples and result bodies (internal discussion) and this repo is public.
// Set RESULT_QUALITY_OUT to relocate it. No credentials are read or written.
import { DatabaseSync } from 'node:sqlite'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'

const zd = promisify(execFile)
const decompress = async p => (await zd('zstd', ['-dc', p], { maxBuffer: 1 << 30 })).stdout
const dshHome = `${process.env.HOME}/.dsh`
const dayOf = t => new Date(new Date(Number(t) || t).getTime() + 8 * 3600e3).toISOString().slice(0, 10)
const FROM = '2026-10-22'
const RELEASE = '2026-10-31'
const era = day => day >= RELEASE ? 'after' : 'before'

const db = new DatabaseSync(`${dshHome}/storages/agent_team.sqlite`, { readOnly: true })
const ops = db.prepare("SELECT value FROM u_agent_team_operations WHERE key LIKE 'operation:%'").all()
  .map(r => JSON.parse(r.value)).sort((a, b) => a.sequence - b.sequence)
db.close()
const s2m = new Map()
for (const o of ops) { const m = o?.data?.member; if (m?.memberId && m.sessionId) s2m.set(m.sessionId, m.handle ?? m.memberId) }

const TEAM = new Set(['team_view', 'team_inbox', 'team_thread', 'team_message', 'team_task', 'team_attention', 'team_dm', 'team_reminder', 'team_subscription'])

// accumulators
const rec = { before: { rejected: 0, followed: 0, recovered: 0, byKind: new Map() }, after: { rejected: 0, followed: 0, recovered: 0, byKind: new Map() } }
const dup = { before: { reads: 0, dupRuns: 0, dupCalls: 0 }, after: { reads: 0, dupRuns: 0, dupCalls: 0 } }
const parts = { before: { partResults: 0, zeroLen: 0, chains: new Map(), omittedHits: 0 }, after: { partResults: 0, zeroLen: 0, chains: new Map(), omittedHits: 0 } }
const sizes = new Map()   // `${era}|${tool}|${action}` -> [lengths]
const commitOutliers = [] // big success results to eyeball
const notices = { direct: { withBody: 0, withoutBody: 0, samples: [] }, ordinary: { withBody: 0, withoutBody: 0, samples: [] } }
const rejectSamples = []  // {who, day, tool, action, text, next: [{tool, action, ok}]}
const uncertainHits = []  // results saying cannot-determine shapes

const actionOf = raw => { try { return JSON.parse(raw ?? '{}').action ?? '-' } catch { return '-' } }
const kindOf = text => {
  const m = /Not committed — ([a-z_]+)/.exec(text)
  return m ? m[1] : 'schema/other'
}

const root = `${dshHome}/sessions/--home-yu-projects-dsh-agent-team--`
const dirs = await readdir(root, { withFileTypes: true })
let scanned = 0
for (const d of dirs) {
  if (!d.isDirectory() || !d.name.startsWith('agent-team-')) continue
  const who = s2m.get(d.name)
  if (!who) continue
  const fs = await readdir(join(root, d.name))
  const cands = fs.filter(x => x.endsWith('.jsonl.zstd'))
  if (!cands.length) continue
  const ver = f => Number(/session\.v(\d+)\.jsonl/.exec(f)?.[1] ?? 0)
  const file = join(root, d.name, cands.sort((a, b) => ver(b) - ver(a))[0])
  let text
  try { text = await decompress(file) } catch { continue }
  scanned++

  const seq = []            // ordered team calls in this session: {name, action, callId, day, time}
  const resultOf = new Map() // callId -> {ok, text, day}
  let lastReadSig = null, lastReadDay = null, dupRun = 0

  for (const l of text.split('\n')) {
    if (!l) continue
    let e
    try { e = JSON.parse(l) } catch { continue }
    const day = e.time ? dayOf(e.time) : undefined

    // E. notifications arrive spliced into the inbox: agent/inbox/spliced
    if (e.type === 'agent/inbox/spliced') {
      for (const item of e.data?.inserted ?? []) {
        const t = (item?.content ?? []).map(c => c?.text ?? '').join('\n')
        if (!t || day < FROM) continue
        if (/Direct [^\n]*mention/.test(t)) {
          const bodyLen = (/\nMessage: ([\s\S]*)/.exec(t)?.[1] ?? '').trim().length
          notices.direct.withBody += bodyLen > 10 ? 1 : 0
          notices.direct.withoutBody += bodyLen > 10 ? 0 : 1
          if (notices.direct.samples.length < 4) notices.direct.samples.push({ day, len: t.length, bodyLen, head: t.slice(0, 200) })
        } else if (/Team Inbox has unread work/.test(t)) {
          const copiesBody = /\nMessage: [\s\S]{80,}/.test(t)
          notices.ordinary.withBody += copiesBody ? 1 : 0
          notices.ordinary.withoutBody += copiesBody ? 0 : 1
          if (notices.ordinary.samples.length < 4) notices.ordinary.samples.push({ day, len: t.length, head: t.slice(0, 200) })
        }
      }
      continue
    }

    if (e.type === 'tool/call' && e.data?.name && e.data?.callId && TEAM.has(e.data.name)) {
      seq.push({ name: e.data.name, action: actionOf(e.data.arguments), callId: e.data.callId, day, time: Number(e.time) || 0 })
      continue
    }
    if (e.type === 'tool/result') {
      const msg = e.data?.message
      if (!msg || typeof msg.toolCallId !== 'string') continue
      const call = seq.find(c => c.callId === msg.toolCallId)
      if (!call || call.day < FROM) continue
      const t = (msg.content ?? []).map(c => c?.text ?? '').join('\n')
      const ok = msg.isError !== true && !t.includes('Not committed')
      resultOf.set(call.callId, { ok, text: t, day: call.day })
      const er = era(call.day)

      // D. sizes per tool/action (successes and rejections separately)
      const key = `${er}|${call.name}|${call.action}|${ok ? 'ok' : 'rej'}`
      if (!sizes.has(key)) sizes.set(key, [])
      sizes.get(key).push(t.length)
      if (ok && t.length > 600 && ['post', 'reply', 'start', 'claim', 'done', 'release', 'accept', 'close', 'follow', 'unfollow', 'create', 'send'].includes(call.action) && commitOutliers.length < 12)
        commitOutliers.push({ who, day: call.day, tool: call.name, action: call.action, len: t.length, head: t.slice(0, 220) })
      if (/\buncertain\b|cannot determine|无法判定/i.test(t) && uncertainHits.length < 8)
        uncertainHits.push({ who, day: call.day, tool: call.name, head: t.slice(0, 180) })

      // B. duplicate consecutive read results
      if (call.name === 'team_thread' && call.action === 'read') {
        dup[er].reads++
        const sig = t.length + ':' + (t.slice(0, 120) + t.slice(-120)).replace(/\d/g, '#')
        if (sig === lastReadSig) { dup[er].dupCalls++; dupRun++ }
        else { if (dupRun > 0) dup[er].dupRuns++; dupRun = 0 }
        lastReadSig = sig
      }

      // C. part chains
      const pm = /Message part (\d+)[–-](\d+) of (\d+)/.exec(t)
      if (pm) {
        const [, a, b, total] = pm.map(Number)
        parts[er].partResults++
        if (b <= a) parts[er].zeroLen++
        const ch = parts[er].chains
        const ck = `${who}|${total}`
        ch.set(ck, Math.max(ch.get(ck) ?? 0, b))
      }
      if (t.includes('body already in current context; omitted') || t.includes('complete in current context')) parts[er].omittedHits++
    }
  }

  // A. rejection → recovery within next 5 same-member team calls
  for (let i = 0; i < seq.length; i++) {
    const r = resultOf.get(seq[i].callId)
    if (!r || r.ok) continue
    const er = era(seq[i].day)
    rec[er].rejected++
    const kind = kindOf(r.text)
    const bk = rec[er].byKind.get(kind) ?? { rejected: 0, followed: 0, recovered: 0 }
    bk.rejected++
    let followed = false, recovered = false
    const nexts = []
    for (let j = i + 1; j < Math.min(i + 6, seq.length); j++) {
      const nr = resultOf.get(seq[j].callId)
      nexts.push({ tool: seq[j].name, action: seq[j].action, ok: nr?.ok ?? null })
      if (!followed && seq[j].name === seq[i].name) {
        followed = true
        if (nr?.ok) recovered = true
      }
    }
    if (followed) { rec[er].followed++; bk.followed++; if (recovered) { rec[er].recovered++; bk.recovered++ } }
    if (rejectSamples.length < 14 && followed) rejectSamples.push({ who, day: seq[i].day, tool: seq[i].name, action: seq[i].action, kind, text: r.text.slice(0, 240), nexts })
    rec[er].byKind.set(kind, bk)
  }
}

console.log(`scanned ${scanned} member-attributed session files, window ${FROM}.., era split ${RELEASE}`)

console.log('\n=== A. rejection → recovery (next same-tool call within 5 succeeds) ===')
for (const er of ['before', 'after']) {
  const r = rec[er]
  console.log(`${er}: rejected=${r.rejected} had-next-same-tool=${r.followed} recovered=${r.recovered} rate=${r.followed ? (100 * r.recovered / r.followed).toFixed(0) : '—'}%`)
  for (const [k, v] of [...r.byKind.entries()].sort((a, b) => b[1].rejected - a[1].rejected).slice(0, 6))
    console.log(`   ${k.padEnd(16)} rej=${String(v.rejected).padStart(3)} followed=${String(v.followed).padStart(3)} recovered=${String(v.recovered).padStart(3)}`)
}

console.log('\n=== B. read forward progress (consecutive identical read results) ===')
for (const er of ['before', 'after']) {
  const d = dup[er]
  console.log(`${er}: reads=${d.reads} dup-calls=${d.dupCalls} (${d.reads ? (100 * d.dupCalls / d.reads).toFixed(1) : '—'}%) dup-runs=${d.dupRuns}`)
}

console.log('\n=== C. long-message parts ===')
for (const er of ['before', 'after']) {
  const p = parts[er]
  const done = [...p.chains.values()]
  console.log(`${er}: part-results=${p.partResults} zero-length=${p.zeroLen} omitted/complete-hits=${p.omittedHits} chains=${p.chains.size}`)
}

console.log('\n=== D. result sizes (ok results, per tool|action: n / p50 / p95 / max) ===')
for (const [key, arr] of [...sizes.entries()].sort()) {
  if (!key.endsWith('|ok')) continue
  const s = arr.slice().sort((a, b) => a - b)
  const p = q => s[Math.min(s.length - 1, Math.floor(s.length * q))]
  if (s.length >= 5) console.log(`${key.padEnd(52)} n=${String(s.length).padStart(4)} p50=${String(p(0.5)).padStart(5)} p95=${String(p(0.95)).padStart(6)} max=${String(s[s.length - 1]).padStart(6)}`)
}

console.log('\n=== E. notification shapes (window) ===')
console.log(`direct-mention notices: with body=${notices.direct.withBody} without=${notices.direct.withoutBody}`)
console.log(`ordinary unread notices: body-copied(>=80ch)=${notices.ordinary.withBody} entry-only=${notices.ordinary.withoutBody}`)
for (const s of notices.direct.samples.slice(0, 2)) console.log(`  [direct ${s.day} len=${s.len} bodyLen=${s.bodyLen}] ${s.head.replace(/\n/g, '⏎')}`)
for (const s of notices.ordinary.samples.slice(0, 2)) console.log(`  [ordinary ${s.day} len=${s.len}] ${s.head.replace(/\n/g, '⏎')}`)

console.log('\n=== commit-result outliers (>600ch successes, eyeball) ===')
for (const o of commitOutliers.slice(0, 8)) console.log(`[${o.who} ${o.day}] ${o.tool}/${o.action} len=${o.len}\n   ${o.head.replace(/\n/g, '⏎').slice(0, 200)}`)

console.log('\n=== uncertain-phrasing hits ===')
for (const u of uncertainHits) console.log(`[${u.who} ${u.day}] ${u.tool}: ${u.head.replace(/\n/g, '⏎')}`)

console.log('\n=== rejection→next samples (eyeball recovery guidance) ===')
for (const s of rejectSamples.slice(0, 8)) {
  console.log(`[${s.who} ${s.day}] ${s.tool}/${s.action} kind=${s.kind}\n   rej: ${s.text.replace(/\n/g, '⏎').slice(0, 200)}\n   next: ${JSON.stringify(s.nexts)}`)
}

writeFileSync(process.env.RESULT_QUALITY_OUT ?? `${process.env.HOME}/.dsh/result-quality-${Date.now()}.json`, JSON.stringify({
  scannedAt: new Date().toISOString(), window: FROM, release: RELEASE, scanned,
  recovery: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, { ...v, byKind: [...v.byKind.entries()] }])),
  dup, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { ...v, chains: [...v.chains.entries()] }])),
  sizes: [...sizes.entries()], notices: { direct: { ...notices.direct }, ordinary: { ...notices.ordinary } },
  commitOutliers, uncertainHits, rejectSamples,
}, null, 1))
console.log('\njson written')
