#!/usr/bin/env node
/* ESM test runner: generates scope‑specific questions from a bank, runs chat, saves answers + charts, writes LaTeX report */
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

async function jget(url){ const r = await fetch(BASE+url); if(!r.ok) throw new Error(url+': '+r.status); return r.json(); }
async function jpost(url, body){ const r = await fetch(BASE+url,{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})}); if(!r.ok) throw new Error(url+': '+r.status); return r.json(); }

function loadQuestionBank(){
  const p = path.join(process.cwd(), 'scripts', 'questions.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { building:[], floor:[], zone:[], device:[] }; }
}

function metricHas(metrics, key){
  const low = metrics.map(m=>String(m).toLowerCase());
  const k = String(key).toLowerCase();
  return low.some(m => m.includes(k));
}

function selectQuestions(scope, metrics, n=5) {
  const bank = loadQuestionBank();
  const entries = Array.isArray(bank[scope]) ? bank[scope] : [];
  const ok = [];
  for (const e of entries) {
    const reqAll = (e.requiresAll || []).every(k => metricHas(metrics, k));
    const reqAny = (e.requiresAny || []).length ? (e.requiresAny.some(k => metricHas(metrics, k))) : true;
    if (!reqAll || !reqAny) continue;
    const texts = Array.isArray(e.texts) ? e.texts : (e.text ? [e.text] : []);
    for (const t of texts) ok.push(t);
  }
  // Add per-metric explain questions (up to 2)
  const expl = [];
  for (const m of metrics.slice(0, 2)) expl.push(`What does ${m} measure here and how should we interpret it?`);
  const pool = [...new Set([...ok, ...expl])];
  return pool.slice(0, n);
}

function escLatex(s){
  return String(s||'').replace(/[\\{}$&#_^%]/g, m=>({
    '\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','_':'\\_','%':'\\%','^':'\\^{}'
  })[m]||m);
}

async function run(){
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const outDir = path.join('data','tests',ts);
  ensureDir(outDir);

  // Last 7 days window
  const end = Date.now();
  const start = end - 7 * 24 * 60 * 60 * 1000;

  const graph = await jget('/api/graph/full');
  const buildings = (graph.nodes||[]).filter(n=> (n.nodeType||n.label)==='Building');
  const bAvail = buildings.filter(b => b.hasData);
  const pickBuildings = bAvail.length ? bAvail : buildings;

  const report = [];
  const summary = [];

  for (const b of pickBuildings.slice(0,3)) {
    const building = b.name;
    const scopeLabel = `Building: ${building}`;
    const sm = await jget(`/api/scope/metrics?building=${encodeURIComponent(building)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const metrics = sm.metrics || [];
    const bDir = path.join(outDir, `building-${building.replace(/[^a-z0-9]+/gi,'_')}`);
    ensureDir(bDir);
    const bQs = selectQuestions('building', metrics);
    for (let i=0;i<bQs.length;i++){
      const q = bQs[i];
      const payload = { messages:[{role:'user', content:q}], room:'ALL', range:{ start, end }, selection:{ building } };
      const res = await jpost('/api/chat', payload);
      const ans = res.message?.content || '';
      const chart = res.chart || null;
      fs.writeFileSync(path.join(bDir, `q${i+1}.txt`), ans, 'utf8');
      if (chart) fs.writeFileSync(path.join(bDir, `q${i+1}.chart.json`), JSON.stringify(chart, null, 2));
      report.push({ scope: scopeLabel, kind:'building', question:q, answer:ans, chart: !!chart, dir:bDir, file:`q${i+1}` });
      summary.push({ scope:{building}, kind:'building', question:q, answer:ans, chart: !!chart, answerFile:`${path.join(bDir, `q${i+1}.txt`)}`, chartFile: chart ? `${path.join(bDir, `q${i+1}.chart.json`)}` : null });
      await sleep(200);
    }

    // Floors
    const topo = await jget(`/api/topology?building=${encodeURIComponent(building)}`);
    const floors = Array.from(new Set((topo?.buildings||[]).flatMap(B=> (B.name===building? B.floors:[])).map(f=>f.name).filter(Boolean)));
    for (const floor of floors.slice(0,2)){
      const scopeLabelF = `Building: ${building}, Floor: ${floor}`;
      const smF = await jget(`/api/scope/metrics?building=${encodeURIComponent(building)}&floor=${encodeURIComponent(floor)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      const metricsF = smF.metrics || [];
      const fDir = path.join(bDir, `floor-${floor.replace(/[^a-z0-9]+/gi,'_')}`);
      ensureDir(fDir);
      const fQs = selectQuestions('floor', metricsF);
      for (let i=0;i<fQs.length;i++){
        const q = fQs[i];
        const payload = { messages:[{role:'user', content:q}], room:'ALL', range:{ start, end }, selection:{ building, floor } };
        const res = await jpost('/api/chat', payload);
        const ans = res.message?.content || '';
        const chart = res.chart || null;
        fs.writeFileSync(path.join(fDir, `q${i+1}.txt`), ans, 'utf8');
        if (chart) fs.writeFileSync(path.join(fDir, `q${i+1}.chart.json`), JSON.stringify(chart, null, 2));
        report.push({ scope: scopeLabelF, kind:'floor', question:q, answer:ans, chart: !!chart, dir:fDir, file:`q${i+1}` });
        summary.push({ scope:{building, floor}, kind:'floor', question:q, answer:ans, chart: !!chart, answerFile:`${path.join(fDir, `q${i+1}.txt`)}`, chartFile: chart ? `${path.join(fDir, `q${i+1}.chart.json`)}` : null });
        await sleep(200);
      }

      // Zones for this floor
      const zones = (smF.rooms || smF.zones || smF.roomsList || []); // if present
      // If not present, we can try topology again for zones under floors
      const smZones = await jget(`/api/topology?building=${encodeURIComponent(building)}`);
      const zonesList = [];
      for (const B of (smZones?.buildings||[])){
        if (B.name!==building) continue;
        const F = (B.floors||[]).find(ff=>ff.name===floor);
        if (F) zonesList.push(...(F.zones||[]).map(z=>z.name||z.roomId).filter(Boolean));
      }
      for (const zone of zonesList.slice(0,2)){
        const scopeLabelZ = `Building: ${building}, Floor: ${floor}, Zone: ${zone}`;
        const zDir = path.join(fDir, `zone-${String(zone).toString().replace(/[^a-z0-9]+/gi,'_')}`);
        ensureDir(zDir);
        const smZ = await jget(`/api/scope/metrics?building=${encodeURIComponent(building)}&floor=${encodeURIComponent(floor)}&zone=${encodeURIComponent(zone)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
        const metricsZ = smZ.metrics || [];
        const zQs = selectQuestions('zone', metricsZ);
        for (let i=0;i<zQs.length;i++){
          const q = zQs[i];
          const payload = { messages:[{role:'user', content:q}], room:'ALL', range:{ start, end }, selection:{ building, floor, room: String(zone) } };
          const res = await jpost('/api/chat', payload);
          const ans = res.message?.content || '';
          const chart = res.chart || null;
          fs.writeFileSync(path.join(zDir, `q${i+1}.txt`), ans, 'utf8');
          if (chart) fs.writeFileSync(path.join(zDir, `q${i+1}.chart.json`), JSON.stringify(chart, null, 2));
          report.push({ scope: scopeLabelZ, kind:'zone', question:q, answer:ans, chart: !!chart, dir:zDir, file:`q${i+1}` });
          summary.push({ scope:{building, floor, zone: String(zone)}, kind:'zone', question:q, answer:ans, chart: !!chart, answerFile:`${path.join(zDir, `q${i+1}.txt`)}`, chartFile: chart ? `${path.join(zDir, `q${i+1}.chart.json`)}` : null });
          await sleep(200);
        }

        // Device scope: pick a device with metrics
        const byDevice = smZ.byDevice || {};
        const devId = Object.keys(byDevice)[0];
        if (devId) {
          const dDir = path.join(zDir, `device-${devId}`);
          ensureDir(dDir);
          // Build device-relevant questions
          const devMetrics = byDevice[devId] || [];
          const dQs = selectQuestions('device', devMetrics);
          for (let i=0;i<dQs.length;i++){
            const q = dQs[i];
            const payload = { messages:[{role:'user', content:q}], room: devId, range: { start, end } };
            const res = await jpost('/api/chat', payload);
            const ans = res.message?.content || '';
            const chart = res.chart || null;
            fs.writeFileSync(path.join(dDir, `q${i+1}.txt`), ans, 'utf8');
            if (chart) fs.writeFileSync(path.join(dDir, `q${i+1}.chart.json`), JSON.stringify(chart, null, 2));
            report.push({ scope: `${scopeLabelZ}, Device: ${devId}`, kind:'device', question:q, answer:ans, chart: !!chart, dir:dDir, file:`q${i+1}` });
            summary.push({ scope:{building, floor, zone: String(zone), device: devId}, kind:'device', question:q, answer:ans, chart: !!chart, answerFile:`${path.join(dDir, `q${i+1}.txt`)}`, chartFile: chart ? `${path.join(dDir, `q${i+1}.chart.json`)}` : null });
            await sleep(200);
          }
        }
      }
    }
  }

  // Build LaTeX
  const tex = [];
  tex.push('\\documentclass{article}');
  tex.push('\\usepackage[margin=1in]{geometry}');
  tex.push('\\usepackage{hyperref}');
  tex.push('\\usepackage{upquote}');
  tex.push('\\usepackage{listings}');
  tex.push('\\begin{document}');
  tex.push('\\section*{Scope QA Report}');
  for (const it of report){
    tex.push(`\\subsection*{${escLatex(it.scope)}}`);
    tex.push(`\\textbf{Question:} ${escLatex(it.question)}\\\\`);
    tex.push(`\\textbf{Answer:} ${escLatex(it.answer)}`);
    if (it.chart) {
      const rel = path.relative(outDir, path.join(it.dir, it.file+'.chart.json')).split(path.sep).join('/');
      tex.push('\\paragraph{Chart JSON}');
      tex.push('\\begin{lstlisting}[basicstyle=\\ttfamily\\small]');
      try { const j = JSON.parse(fs.readFileSync(path.join(it.dir, it.file+'.chart.json'),'utf8')); tex.push(JSON.stringify(j)); } catch { tex.push('% chart json unavailable'); }
      tex.push('\\end{lstlisting}');
      tex.push(`\\noindent (Saved: ${escLatex(rel)})`);
    }
    tex.push('\\bigskip');
  }
  tex.push('\\end{document}');
  const texPath = path.join(outDir, `report-${ts}.tex`);
  fs.writeFileSync(texPath, tex.join('\n'), 'utf8');
  console.log('Wrote report:', texPath);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('Wrote summary:', path.join(outDir, 'summary.json'));
}

run().catch(e=>{ console.error(e); process.exit(1); });
