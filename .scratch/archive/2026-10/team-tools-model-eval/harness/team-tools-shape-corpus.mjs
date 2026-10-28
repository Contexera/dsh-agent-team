// Tier 1 seed: extract every real Team tool call shape from all session logs.
// Schema facts verified against live logs (2026-10-28):
//   tool/call   -> data.name, data.arguments (JSON string), data.callId
//   tool/result -> data.message.toolCallId, data.message.isError, data.message.content[].text
// Pitfalls honored: multi-frame zstd (use zstd -dc CLI), enumerate whole tree
// (rollover leaves records in prior generations), result text may quote rejections
// so classification only trusts tool/result events of team_* calls.
// Model attribution is PER TURN, not per file: recycled/rollover session files
// carry several members' turns under different models (one file held
// codex/gpt-6.1-sol, zcode/GLM-5.3-Flash and auto/deepseek-v4.1-flash turns at
// once), so the first model event in a file mislabels every call after it.
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = `${process.env.HOME}/.dsh/sessions`;
// Transient artifacts live in .scratch/local (gitignored), never inside the work item.
const OUT = new URL('../../../../local/team-tools-model-eval/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl.zstd')) yield p;
  }
}

const valueClass = (v) =>
  v === undefined ? 'absent' : v === '' ? 'empty' : v === 0 || v === false ? 'falsy' : 'set';

const files = [...walk(ROOT)];
console.error(`files: ${files.length}`);

const calls = [];
let lines = 0;
for (const f of files) {
  const r = spawnSync('zstd', ['-dc', f], { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) { console.error(`zstd failed: ${f}`); continue; }
  let currentModel = 'unknown';
  const pending = new Map();
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (!line) continue;
    lines++;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const d = ev.data;
    if (!d) continue;
    if (typeof d.model === 'string') currentModel = d.model;
    if (ev.type === 'tool/call' && typeof d.name === 'string' && d.name.startsWith('team_')) {
      let args = null;
      try { args = JSON.parse(d.arguments); } catch { /* keep null */ }
      pending.set(d.callId, { file: f, time: ev.time, model: currentModel, tool: d.name, args });
    } else if (ev.type === 'tool/result' && d.message && typeof d.message.toolCallId === 'string') {
      const c = pending.get(d.message.toolCallId);
      if (!c) continue;
      const text = (d.message.content || [])
        .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text).join('\n');
      const isError = d.message.isError === true;
      let cls;
      if (isError) {
        const m = /^Error:\s*([a-z ]+)/.exec(text);
        cls = m ? `thrown:${m[1].trim().replace(/\s+/g, '_')}` : 'thrown:other';
      } else if (/^Not committed/.test(text)) {
        const m = /^Not committed — (.+?)\./.exec(text);
        cls = 'reject:' + (m ? m[1].trim().slice(0, 80) : 'unparsed');
      } else cls = 'success';
      calls.push({ ...c, cls, isError, text: text.slice(0, 300) });
      pending.delete(d.message.toolCallId);
    }
  }
}
console.error(`lines: ${lines}, team calls matched with results: ${calls.length}`);

const shapeOf = (c) => {
  const a = c.args || {};
  const action = typeof a.action === 'string' ? a.action : '(none)';
  const keys = Object.keys(a).filter((k) => k !== 'action').sort()
    .map((k) => `${k}=${valueClass(a[k])}`).join(',');
  return `${c.tool} ${action} [${keys}]`;
};

const byShape = new Map();
for (const c of calls) {
  const s = shapeOf(c);
  if (!byShape.has(s)) byShape.set(s, { shape: s, tool: c.tool, action: (c.args || {}).action ?? null, total: 0, rejected: 0, thrown: 0, models: {}, exampleArgs: c.args, exampleResult: c.text });
  const e = byShape.get(s);
  e.total++;
  if (c.cls !== 'success') e.rejected++;
  if (c.cls.startsWith('thrown')) e.thrown++;
  e.models[c.model] = (e.models[c.model] || 0) + 1;
}

const summary = {
  scannedAt: new Date().toISOString(),
  files: files.length,
  teamCalls: calls.length,
  success: calls.filter((c) => c.cls === 'success').length,
  businessRejects: calls.filter((c) => c.cls.startsWith('reject:')).length,
  thrown: calls.filter((c) => c.cls.startsWith('thrown')).length,
  byModel: {}, byTool: {}, distinctShapes: byShape.size,
};
for (const c of calls) {
  summary.byModel[c.model] = (summary.byModel[c.model] || 0) + 1;
  summary.byTool[c.tool] = (summary.byTool[c.tool] || 0) + 1;
}
const perModel = {};
for (const c of calls) {
  const m = perModel[c.model] || (perModel[c.model] = { total: 0, rejected: 0, thrown: 0 });
  m.total++; if (c.cls !== 'success') m.rejected++; if (c.cls.startsWith('thrown')) m.thrown++;
}
summary.perModelFriction = perModel;

writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, 'shapes.json'), JSON.stringify([...byShape.values()].sort((a, b) => b.rejected - a.rejected || b.total - a.total), null, 2));
writeFileSync(join(OUT, 'calls.jsonl'), calls.map((c) => JSON.stringify({ file: c.file.replace(ROOT + '/', ''), time: c.time, model: c.model, tool: c.tool, args: c.args, cls: c.cls, text: c.text })).join('\n') + '\n');
console.error(JSON.stringify(summary, null, 2));
