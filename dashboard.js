/* ============================================================
   SAGE Analytics Dashboard — dashboard.js  v1.0
   Sentiment Alignment with Grounded Evidence (SentiCap)
   Author: Dr. Himanshu Sharma
   https://www.linkedin.com/in/dr-himanshusharma/
   Theme and layout shared with the DHARA dashboard.
   ============================================================ */
'use strict';

/* ── Configuration ─────────────────────────────────────────── */
const GH = {
  owner  : 'himanshusharma-csit',
  repo   : 'sage',            // ← change if the repository has another name
  branch : 'main',
  data   : 'data'             // folder written by export_results.py
};
/* Batch sizes the study plans to report. Any that are not exported yet
   appear in the selector as "pending" until export_results.py has run. */
const EXPECTED_BATCHES = ['Batch-32','Batch-64','Batch-128','Batch-256'];

/* Display names for ablation variants (paper Table II wording; edit freely). */
const VARIANT_LABELS = {
  full               : 'SAGE (full)',
  full_unconstrained : 'w/o constrained decoding',
  no_grounding       : 'w/o region-wise alignment',
  v2_no_presence_sep : 'w/o separate presence head',
  no_mil             : 'w/o MIL losses',
  no_prior           : 'w/o CLIP prior',
  no_null_slot       : 'w/o NULL slot',
  no_factual_mix     : 'w/o factual mixing',
  /* extra variants that were run but are not in the paper */
  all_fixes_off      : 'All four refinements off',
  full_v1            : 'SAGE v1',
  no_repeat_off      : 'w/o no-repeat bigram block',
  slot_word_identity : 'Slot word identity',
  v2_no_mask_train   : 'w/o training mask',
  v2_no_swap         : 'w/o style swap'
};
/* Variants reported in the paper's Table II, in its order. */
const PAPER_VARIANTS = ['full_unconstrained','no_grounding','v2_no_presence_sep','no_mil','no_prior','no_null_slot','no_factual_mix'];
const vlabel = v => VARIANT_LABELS[v] || v.replace(/_/g,' ');
let ABL_SCOPE = 'paper';   /* 'paper' = Table II variants only, 'all' = every variant that was run */
/* Ordered variant list (without 'full') for an ablation summary, filtered by ABL_SCOPE. */
function ablVariants(summary){
  const keys=Object.keys(summary||{}).filter(v=>v!=='full');
  const paper=PAPER_VARIANTS.filter(v=>keys.includes(v));
  const extra=keys.filter(v=>!PAPER_VARIANTS.includes(v));
  return ABL_SCOPE==='paper' ? paper : [...paper,...extra];
}
const extraTag = v => PAPER_VARIANTS.includes(v)||v==='full' ? '' : ' <span class="tag-extra">extra</span>';

/* Palette (same tokens as dashboard.css) */
const C = {blue:'#2563eb',purple:'#7c3aed',green:'#059669',orange:'#d97706',red:'#dc2626',cyan:'#0891b2',pink:'#db2777',slate:'#4b5580'};
const NEG = C.red, POS = C.green, MEAN = C.blue;
const SERIES = [C.blue,C.purple,C.green,C.orange,C.pink,C.cyan,C.red,'#ea580c','#16a34a','#4f46e5'];

/* Nouns treated as animate for the "dead" failure analysis (mirrors export_results.py) */
const ANIMATE = new Set(('man men woman women person people boy boys girl girls child children kid kids baby babies guy guys lady ladies '+
  'player players skier skiers surfer surfers skateboarder skateboarders snowboarder rider riders family couple crowd team toddler teenager '+
  'dog dogs puppy cat cats kitten horse horses bird birds cow cows elephant elephants giraffe giraffes zebra zebras sheep bear bears '+
  'animal animals pigeon pigeons duck ducks goat goats lamb calf seagull').split(' '));

/* ── Global state ──────────────────────────────────────────── */
let D   = null;   // active batch (raw export + derived fields)
let CHS = {};     // chart instances
let SEL = null;   // selected batch name
let INDEX = [];   // batches.json
const CACHE = {}; // loaded batch files
let CAP_SHOWN = 12;

/* ══════════════════════════════════════════════════════════════
   1.  DATA ACCESS
   ══════════════════════════════════════════════════════════════ */
function rawUrl(path){ return `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/${path}`; }

/* Same-origin first (GitHub Pages, local server), raw GitHub as a fallback (file://). */
async function fetchJSON(path){
  const tries = [path + '?v=' + Date.now(), rawUrl(path) + '?v=' + Date.now()];
  let lastErr = null;
  for (const u of tries){
    try { const r = await fetch(u, {cache:'no-store'}); if (r.ok) return await r.json(); lastErr = new Error(`HTTP ${r.status} for ${path}`); }
    catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('Cannot fetch ' + path);
}
async function getBatch(name){
  if (!CACHE[name]) CACHE[name] = prepare(await fetchJSON(`${GH.data}/${name}.json`));
  return CACHE[name];
}

/* ── stats helpers ─────────────────────────────────────────── */
const isNum = v => typeof v === 'number' && isFinite(v);
const mean  = a => { a=a.filter(isNum); return a.length ? a.reduce((s,v)=>s+v,0)/a.length : null; };
const sd    = a => { a=a.filter(isNum); if (a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1)); };
const fx    = (v,d=1) => isNum(v) ? v.toFixed(d) : '–';
const pm    = (m,s,d=1) => isNum(m) ? (isNum(s) && s>0 ? `${m.toFixed(d)} ± ${s.toFixed(d)}` : m.toFixed(d)) : '–';
const stars = p => !isNum(p) ? '' : p<0.001 ? '***' : p<0.01 ? '**' : p<0.05 ? '*' : '';
const esc   = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cocoUrl = img => `https://images.cocodataset.org/val2014/${img}`;

/* Average a list of TestResults objects; returns same shape with {mean,std,vals} leaves. */
function aggResults(list){
  const out = {};
  const walk = (objs, dst) => {
    const keys = new Set(); objs.forEach(o => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).forEach(k=>keys.add(k)));
    keys.forEach(k => {
      const vals = objs.map(o => o ? o[k] : undefined);
      if (vals.some(isNum)) { const n=vals.filter(isNum); dst[k] = {mean:mean(n), std:sd(n), vals:n}; }
      else if (vals.some(v => v && typeof v === 'object' && !Array.isArray(v))) { dst[k] = {}; walk(vals, dst[k]); }
      else dst[k] = vals.find(v => v !== undefined);
    });
  };
  walk(list, out);
  return out;
}
/* Wrap a single TestResults object into the {mean,std} shape. */
function wrapSingle(res){ return aggResults([res]); }
const M = (node, key) => node && node[key] && isNum(node[key].mean) ? node[key].mean : null;
const S = (node, key) => node && node[key] && isNum(node[key].std) ? node[key].std : null;

/* Build the derived view the pages use. */
function prepare(raw){
  const d = raw;
  d.val = (raw.val_stylised||[]).map(r => ({
    epoch:r.Epoch,
    neg:{b1:r['negative BLEU-1'],b4:r['negative BLEU-4'],rouge:r['negative ROUGE-L'],cider:r['negative CIDEr'],acc:r['negative StyleAcc']},
    pos:{b1:r['positive BLEU-1'],b4:r['positive BLEU-4'],rouge:r['positive ROUGE-L'],cider:r['positive CIDEr'],acc:r['positive StyleAcc']},
    mean:{b1:r['mean BLEU-1'],b4:r['mean BLEU-4'],rouge:r['mean ROUGE-L'],cider:r['mean CIDEr'],acc:r['mean StyleAcc'],sel:r['mean Selection']}
  }));
  d.tr  = raw.train_stylised || [];
  d.tr1 = raw.train_pretrain || [];
  d.v1  = (raw.val_pretrain||[]).map(r => ({epoch:r.Epoch,b1:r['factual BLEU-1'],b4:r['factual BLEU-4'],rouge:r['factual ROUGE-L'],cider:r['factual CIDEr']}));

  /* Best epoch of the main run (whose curves are plotted) */
  let be = raw.tests && raw.tests.best ? raw.tests.best.epoch : null;
  if (be == null && raw.pipeline && raw.pipeline.testing && raw.pipeline.testing.folders){
    const f = raw.pipeline.testing.folders.find(x => /^EpochNumber_\d+$/.test(x));
    if (f) be = parseInt(f.split('_')[1]);
  }
  if (be == null && d.val.length) be = d.val.reduce((b,v)=> v.mean.sel > b.mean.sel ? v : b).epoch;
  d.bestEpoch = be;

  /* Test summary: full-model seeds if present, else main run */
  const seeds = raw.full_seeds || [];
  const seedBest = seeds.map(s => s.best).filter(Boolean);
  const seedUnc  = seeds.map(s => s.best_unconstrained).filter(Boolean);
  const T = {};
  if (seedBest.length){
    T.source = 'seeds'; T.n = seedBest.length;
    T.best = aggResults(seedBest.map(s => s.results));
    T.unc  = seedUnc.length ? aggResults(seedUnc.map(s => s.results)) : null;
    T.epochs = seedBest.map(s => s.epoch);
    T.detail = seedBest[0];
    T.dead = seedBest.map(s => s.dead).filter(Boolean);
    T.deadUnc = seedUnc.map(s => s.dead).filter(Boolean);
  } else if (raw.tests && raw.tests.best){
    T.source = 'main'; T.n = 1;
    T.best = wrapSingle(raw.tests.best.results);
    T.unc  = raw.tests.best_unconstrained ? wrapSingle(raw.tests.best_unconstrained.results) : null;
    T.epochs = [raw.tests.best.epoch];
    T.detail = raw.tests.best;
    T.dead = raw.tests.best.dead ? [raw.tests.best.dead] : [];
    T.deadUnc = raw.tests.best_unconstrained && raw.tests.best_unconstrained.dead ? [raw.tests.best_unconstrained.dead] : [];
  } else { T.source = null; T.n = 0; }
  d.T = T;

  /* Lexicon (word → style) from the presence spread */
  d.lex = {};
  ((T.detail && T.detail.presence_spread) || []).forEach(w => d.lex[w.word] = w.style);
  return d;
}

/* ══════════════════════════════════════════════════════════════
   2.  BATCH MODAL
   ══════════════════════════════════════════════════════════════ */
function setStatus(msg, type='loading'){
  const bar=document.getElementById('statusBar'), txt=document.getElementById('statusText'), spn=document.getElementById('statusSpinner');
  bar.className='status-bar'+(type==='ok'?' ok':type==='err'?' err':'');
  txt.textContent=msg;
  if(spn) spn.className='status-spinner'+(type==='loading'?'':' hide');
}
function openModal(){ document.getElementById('overlay').style.display='flex'; }
window.openModal = openModal;

const AV_KEYS = [
  ['pipeline','Pipeline status'], ['train_stylised','Training logs'], ['val_stylised','Validation'],
  ['tests','Test results'], ['ablations','Ablations']
];
function avOk(av, k){
  if (!av) return false;
  if (k === 'tests') return (Array.isArray(av.tests) && av.tests.length>0) || (av.full_seeds>0);
  return !!av[k];
}

async function scanBatches(){
  const list=document.getElementById('batchList');
  list.innerHTML=''; document.getElementById('extraInfo').innerHTML='';
  document.getElementById('btnLoad').disabled=true; SEL=null;
  document.getElementById('repoName').textContent=`${GH.owner} / ${GH.repo}`;
  setStatus('Loading batches…','loading');
  try{
    INDEX = await fetchJSON(`${GH.data}/batches.json`);
    if(!Array.isArray(INDEX)||!INDEX.length){ setStatus('⚠ batches.json is empty — run export_results.py.','err'); return; }
    const names = INDEX.map(b=>b.name);
    const all = [...new Set([...EXPECTED_BATCHES, ...names])].sort((a,b)=>parseInt(a.replace(/\D/g,''))-parseInt(b.replace(/\D/g,'')));
    all.forEach(n => addBatchCard(list, n, INDEX.find(b=>b.name===n)));
    const ready = INDEX.filter(b=>avOk(b.availability,'train_stylised')).length;
    const pend = all.length - names.length;
    setStatus(`✓ ${ready} batch${ready!==1?'es':''} ready${pend?` · ${pend} pending`:''}`,'ok');
    const want = new URLSearchParams(location.search).get('batch');
    if (want && names.includes(want)){ SEL=want; loadSelectedBatch(); }
  }catch(err){
    console.error(err);
    setStatus('❌ data/batches.json not found.','err');
    document.getElementById('extraInfo').innerHTML=`
      <div class="src-note"><b>Run the exporter first:</b><br>
      <code>python export_results.py --src "path/to/SavedResources" --out data</code><br>
      then commit the <code>data/</code> folder. Opening index.html straight from disk needs a local server
      (<code>python -m http.server</code>).</div>
      <button class="retry-btn" onclick="scanBatches()">↺ Retry</button>`;
  }
}

function addBatchCard(list, name, info){
  const div=document.createElement('div');
  const ok = info && avOk(info.availability,'train_stylised');
  div.className='batch-opt'+(info?(ok?'':' bad'):' pending');
  div.dataset.name=name;
  if(!info){
    div.innerHTML=`<div class="batch-opt-ico">⏳</div>
      <div style="flex:1;min-width:0">
        <div class="batch-opt-name">${name} <span style="font-size:10px;font-weight:700;color:var(--orange)">● Pending</span></div>
        <div class="batch-opt-desc">Not exported yet — add the folder to SavedResources and rerun export_results.py</div>
        <div class="batch-dots">${AV_KEYS.map(([k,l])=>`<span class="bdot na" title="${l}"></span>`).join('')}</div>
      </div>`;
    list.appendChild(div); return;
  }
  const av=info.availability||{};
  const dots=AV_KEYS.map(([k,l])=>`<span class="bdot ${avOk(av,k)?'ok':'no'}" title="${l}: ${avOk(av,k)?'available':'missing'}"></span>`).join('');
  const n=AV_KEYS.filter(([k])=>avOk(av,k)).length;
  const tag = n===AV_KEYS.length ? '<span style="font-size:10px;font-weight:700;color:var(--blue)">⬤ Complete</span>'
                                 : `<span style="font-size:10px;font-weight:700;color:var(--orange)">◐ ${n}/${AV_KEYS.length} parts</span>`;
  div.innerHTML=`<div class="batch-opt-ico">📁</div>
    <div style="flex:1;min-width:0">
      <div class="batch-opt-name">${name} ${tag}</div>
      <div class="batch-opt-desc">Batch size ${info.batch_size} · exported ${esc(info.exported||'')}</div>
      <div class="batch-dots">${dots}</div>
    </div><div class="chk">✓</div>`;
  if(ok) div.addEventListener('click',()=>{
    document.querySelectorAll('.batch-opt').forEach(o=>o.classList.remove('sel'));
    div.classList.add('sel'); SEL=name; document.getElementById('btnLoad').disabled=false;
  });
  list.appendChild(div);
}

async function loadSelectedBatch(){
  if(!SEL) return;
  const btn=document.getElementById('btnLoad'), prog=document.getElementById('fetchProgress'), bar=document.getElementById('fetchProgressBar');
  btn.disabled=true; prog.style.display='block'; bar.style.width='25%';
  setStatus(`Loading ${SEL}…`,'loading');
  try{
    D = await getBatch(SEL); bar.style.width='100%';
    setTimeout(()=>{
      document.getElementById('overlay').style.display='none';
      prog.style.display='none'; bar.style.width='0%'; btn.disabled=false;
      document.getElementById('batchLabel').textContent=`${D.batch} · SentiCap · ${D.tr.length} stylised epochs`;
      document.getElementById('cpBadge').textContent = D.T.source==='seeds'
        ? `Full model · ${D.T.n} seeds` : D.T.source==='main' ? `Epoch ${D.T.epochs[0]} — Best Checkpoint` : 'No test results';
      const u=new URL(location.href); u.searchParams.set('batch',D.batch); history.replaceState(null,'',u);
      setStatus(`✓ ${D.batch} loaded`,'ok');
      renderAll();
    },250);
  }catch(err){
    console.error(err); setStatus('❌ '+err.message,'err'); btn.disabled=false; prog.style.display='none';
  }
}
window.loadSelectedBatch=loadSelectedBatch; window.scanBatches=scanBatches;

/* ══════════════════════════════════════════════════════════════
   3.  CHART HELPERS
   ══════════════════════════════════════════════════════════════ */
Chart.defaults.color='#8892b0';
Chart.defaults.borderColor='#e2e6f0';
Chart.defaults.font.family="'Outfit',sans-serif";
Chart.defaults.font.size=11;

const GC='#e8edf5';
const LEG={position:'top',labels:{usePointStyle:true,boxWidth:7,color:'#4b5580',padding:10}};
function sc(xl,yl){
  return{x:{title:{display:!!xl,text:xl,color:'#8892b0'},grid:{color:GC},ticks:{color:'#8892b0'}},
         y:{title:{display:!!yl,text:yl,color:'#8892b0'},grid:{color:GC},ticks:{color:'#8892b0'}}};
}
function grd(ctx,c1,c2,h=300){ const g=ctx.createLinearGradient(0,0,0,h); g.addColorStop(0,c1); g.addColorStop(1,c2); return g; }
function rgba(hex,a){ const n=parseInt(hex.slice(1),16); return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`; }
function mkChart(id,type,data,opts,plugins){
  if(CHS[id]) CHS[id].destroy();
  const el=document.getElementById(id); if(!el) return null;
  CHS[id]=new Chart(el,{type,data,options:{responsive:true,maintainAspectRatio:true,...opts},plugins:plugins||[]});
  return CHS[id];
}
function mkChartNoAR(id,type,data,opts,plugins){
  if(CHS[id]) CHS[id].destroy();
  const el=document.getElementById(id); if(!el) return null;
  CHS[id]=new Chart(el,{type,data,options:{responsive:true,maintainAspectRatio:false,...opts},plugins:plugins||[]});
  return CHS[id];
}
/* Draws ±σ whiskers for any dataset that carries an `errors` array. */
const errorBars = {
  id:'errorBars',
  afterDatasetsDraw(chart){
    const {ctx} = chart; const horiz = chart.options.indexAxis === 'y';
    chart.data.datasets.forEach((ds,di)=>{
      if(!ds.errors) return; const meta=chart.getDatasetMeta(di); if(meta.hidden) return;
      const vScale = horiz ? chart.scales.x : chart.scales.y;
      ctx.save(); ctx.strokeStyle = ds.errorColor || '#1e2340'; ctx.lineWidth=1.3;
      meta.data.forEach((el,i)=>{
        const e=ds.errors[i], v=ds.data[i]; const val = typeof v==='object' && v ? (horiz?v.x:v.y) : v;
        if(!isNum(e)||!isNum(val)||e===0) return;
        const a=vScale.getPixelForValue(val-e), b=vScale.getPixelForValue(val+e), w=4;
        ctx.beginPath();
        if(horiz){ ctx.moveTo(a,el.y); ctx.lineTo(b,el.y); ctx.moveTo(a,el.y-w); ctx.lineTo(a,el.y+w); ctx.moveTo(b,el.y-w); ctx.lineTo(b,el.y+w); }
        else     { ctx.moveTo(el.x,a); ctx.lineTo(el.x,b); ctx.moveTo(el.x-w,a); ctx.lineTo(el.x+w,a); ctx.moveTo(el.x-w,b); ctx.lineTo(el.x+w,b); }
        ctx.stroke();
      });
      ctx.restore();
    });
  }
};
/* Prints significance stars above/beside bars for datasets carrying `stars`. */
const starLabels = {
  id:'starLabels',
  afterDatasetsDraw(chart){
    const {ctx}=chart; const horiz=chart.options.indexAxis==='y';
    chart.data.datasets.forEach((ds,di)=>{
      if(!ds.stars) return; const meta=chart.getDatasetMeta(di); if(meta.hidden) return;
      ctx.save(); ctx.fillStyle=C.orange; ctx.font="700 12px 'Outfit',sans-serif"; ctx.textAlign='center';
      meta.data.forEach((el,i)=>{
        const s=ds.stars[i]; if(!s) return;
        const v=ds.data[i], e=(ds.errors&&ds.errors[i])||0;
        if(horiz){ const x=chart.scales.x.getPixelForValue(v+(v>=0?e:-e)); ctx.textAlign=v>=0?'left':'right'; ctx.fillText(s,x+(v>=0?4:-4),el.y+4); }
        else     { const y=chart.scales.y.getPixelForValue(v+(v>=0?e:-e)); ctx.fillText(s,el.x,v>=0?y-4:y+12); }
      });
      ctx.restore();
    });
  }
};
function heatColor(t){
  const stops=[[255,255,255],[255,237,213],[249,115,22],[185,28,28]];
  const n=stops.length-1,si=Math.min(Math.floor(t*n),n-1),f=t*n-si;
  const[r1,g1,b1]=stops[si],[r2,g2,b2]=stops[si+1]||stops[si];
  return`rgb(${Math.round(r1+(r2-r1)*f)},${Math.round(g1+(g2-g1)*f)},${Math.round(b1+(b2-b1)*f)})`;
}
/* Diverging colour for "good" (green) vs "bad" (red) changes, t in [-1,1]. */
function divColor(t){
  t=Math.max(-1,Math.min(1,t||0));
  if(t>=0) return `rgb(${Math.round(255-t*(255-209))},${Math.round(255-t*(255-250))},${Math.round(255-t*(255-229))})`;
  const u=-t; return `rgb(${Math.round(255-u*(255-254))},${Math.round(255-u*(255-202))},${Math.round(255-u*(255-202))})`;
}
function emptyCanvas(id,msg){
  if(CHS[id]){CHS[id].destroy(); delete CHS[id];}
  const el=document.getElementById(id); if(!el) return;
  const ctx=el.getContext('2d'); ctx.clearRect(0,0,el.width,el.height);
  ctx.fillStyle='#8892b0'; ctx.font="13px 'Outfit',sans-serif"; ctx.textAlign='center';
  ctx.fillText(msg, el.width/2, el.height/2);
}

/* ══════════════════════════════════════════════════════════════
   4.  NAVIGATION & TABS
   ══════════════════════════════════════════════════════════════ */
const TITLES={dashboard:'Dashboard — Overview',training:'Training Logs',evaluation:'Evaluation Metrics',style:'Style & Grounding',
  captions:'Stylised Captions',ablations:'Ablation Study',bench:'Benchmark Comparison',compare:'Batch-Size Comparison',insights:'Key Insights'};

function goPage(name,btn){
  if(window.innerWidth<=900) closeSb();
  const prev=document.querySelector('.page.active');
  if(prev){ prev.classList.remove('active'); void prev.offsetWidth; }
  document.getElementById('page-'+name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  if(btn){ btn.classList.add('active'); const ico=btn.querySelector('.nav-ico'); if(ico){ico.style.transform='scale(1.35)';setTimeout(()=>ico.style.transform='',220);} }
  document.getElementById('pageTitle').textContent=TITLES[name]||name;
  if(name==='compare' && D) renderCompare();
  if(name==='bench' && D) renderBench();
  /* charts drawn while a page was hidden need a resize once it is visible */
  setTimeout(()=>Object.values(CHS).forEach(c=>{ if(c.canvas && c.canvas.offsetParent) c.resize(); }),30);
}
window.goPage=goPage;

function toggleSb(){
  const sb=document.getElementById('sidebar'),ov=document.getElementById('sbOverlay'),hb=document.getElementById('hamburger');
  if(sb.classList.contains('open')) closeSb(); else { sb.classList.add('open'); ov.classList.add('show'); hb.classList.add('open'); document.body.style.overflow='hidden'; }
}
function closeSb(){
  document.getElementById('sidebar').classList.remove('open'); document.getElementById('sbOverlay').classList.remove('show');
  document.getElementById('hamburger').classList.remove('open'); document.body.style.overflow='';
}
window.toggleSb=toggleSb; window.closeSb=closeSb;
window.addEventListener('resize',()=>{ if(window.innerWidth>900) closeSb(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeSb(); });

function initTabs(){
  document.querySelectorAll('.tabs').forEach(bar=>{
    bar.addEventListener('click',e=>{
      const tab=e.target.closest('.tab'); if(!tab||!tab.dataset.pane) return;
      bar.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); tab.classList.add('active');
      const panes=[...bar.querySelectorAll('[data-pane]')].map(t=>t.dataset.pane);
      panes.forEach(p=>{ const el=document.getElementById(p); if(el) el.style.display=p===tab.dataset.pane?'block':'none'; });
      setTimeout(()=>Object.values(CHS).forEach(c=>{ if(c.canvas && c.canvas.offsetParent) c.resize(); }),20);
    });
  });
}
/* Tabs whose buttons are generated (no panes; a callback redraws one chart). */
function buildTabs(id, items, onPick, activeKey){
  const bar=document.getElementById(id);
  bar.innerHTML=items.map(([k,l])=>`<button class="tab${k===activeKey?' active':''}" data-k="${esc(k)}">${l}</button>`).join('');
  bar.onclick=e=>{ const t=e.target.closest('.tab'); if(!t) return; bar.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); onPick(t.dataset.k); };
}

/* ══════════════════════════════════════════════════════════════
   5.  KPI GRID
   ══════════════════════════════════════════════════════════════ */
function kpiHTML(kpis){
  return kpis.map(k=>`
    <div class="kpi">
      <div class="kpi-ico" style="background:${k.bg}">${k.ico}</div>
      <div>
        <div class="kpi-lbl">${k.lbl}</div>
        <div class="kpi-val" style="color:${k.col}" data-target="${k.val}">${k.val}</div>
        ${k.delta?`<div class="kpi-delta ${k.dn?'dn':'up'}">${k.delta}</div>`:''}
        ${k.sub?`<div class="kpi-sub">${k.sub}</div>`:''}
      </div>
    </div>`).join('');
}
function countUp(root){
  requestAnimationFrame(()=>{
    root.querySelectorAll('.kpi-val').forEach((el,i)=>{
      const raw=parseFloat(el.dataset.target); if(isNaN(raw)) return;
      const dec=(el.dataset.target.split('.')[1]||'').length; let start=null; const dur=800+i*60;
      (function step(ts){ if(!start) start=ts; const p=Math.min((ts-start)/dur,1),e=1-Math.pow(1-p,3); el.textContent=(raw*e).toFixed(dec); if(p<1) requestAnimationFrame(step); })(performance.now());
    });
  });
}

function srcText(){
  const T=D.T;
  if(T.source==='seeds') return `Test figures are the <b>full model averaged over ${T.n} seeds</b> (best checkpoints at epochs ${T.epochs.join(', ')}), mean ± σ. Training and validation curves are the main run (best epoch <b>${D.bestEpoch}</b>).`;
  if(T.source==='main')  return `Test figures are the <b>main run</b>, best checkpoint at epoch <b>${T.epochs[0]}</b> (single seed). Training and validation curves are from the same run.`;
  return `No test results were exported for this batch. Training and validation curves are shown.`;
}

function renderKPI(){
  const B=D.T.best;
  const el=document.getElementById('kpiGrid');
  if(!B){ el.innerHTML=''; return; }
  const n=B.negative, p=B.positive, g=B.grounding||{};
  const sub=(node,k,d=1)=> D.T.n>1 ? `± ${fx(S(node,k),d)} across seeds` : 'single run';
  const kpis=[
    {ico:'🌧️',bg:'#fee2e2',col:C.red,   lbl:'Negative CIDEr',      val:fx(M(n,'CIDEr')),sub:sub(n,'CIDEr')},
    {ico:'☀️',bg:'#d1fae5',col:C.green, lbl:'Positive CIDEr',      val:fx(M(p,'CIDEr')),sub:sub(p,'CIDEr')},
    {ico:'🎭',bg:'#fee2e2',col:C.red,   lbl:'Negative VADER Acc.', val:fx(M(n,'StyleAcc(VADER)')),sub:sub(n,'StyleAcc(VADER)')},
    {ico:'😊',bg:'#d1fae5',col:C.green, lbl:'Positive VADER Acc.', val:fx(M(p,'StyleAcc(VADER)')),sub:sub(p,'StyleAcc(VADER)')},
    {ico:'🎯',bg:'#dbeafe',col:C.blue,  lbl:'Classifier Style Acc.',val:fx(mean([M(n,'StyleAcc(clf)'),M(p,'StyleAcc(clf)')])),sub:'mean of both styles'},
    {ico:'🖼️',bg:'#ede9fe',col:C.purple,lbl:'CLIPScore',           val:fx(mean([M(n,'CLIPScore'),M(p,'CLIPScore')])),sub:'mean of both styles'},
    {ico:'👻',bg:'#fef3c7',col:C.orange,lbl:'CHAIR-s (↓)',         val:fx(mean([M(n,'CHAIR-s'),M(p,'CHAIR-s')])),sub:'object hallucination %',dn:true},
    {ico:'🧭',bg:'#cffafe',col:C.cyan,  lbl:'Prior Agreement',     val:fx(M(g,'prior_agreement_pct')),delta:isNum(M(g,'chance_pct'))?`× ${(M(g,'prior_agreement_pct')/M(g,'chance_pct')).toFixed(0)} chance (${fx(M(g,'chance_pct'))}%)`:''},
  ];
  el.innerHTML=kpiHTML(kpis); countUp(el);
}

/* ══════════════════════════════════════════════════════════════
   6.  DASHBOARD PAGE
   ══════════════════════════════════════════════════════════════ */
function renderDashboard(){
  document.getElementById('srcNote').innerHTML=srcText();
  const ep=D.tr.map(r=>r.Epoch), be=D.bestEpoch;

  const ctx=document.getElementById('c-totalLoss').getContext('2d');
  mkChart('c-totalLoss','line',{labels:ep,datasets:[
    {label:'Total loss',data:D.tr.map(r=>r.total),borderColor:C.blue,backgroundColor:grd(ctx,'rgba(37,99,235,.22)','rgba(37,99,235,0)'),borderWidth:2.5,fill:true,tension:.42,
     pointRadius:ep.map(e=>e===be?7:0),pointBackgroundColor:C.red,pointBorderColor:'#fff',pointBorderWidth:2},
    {label:'Caption loss',data:D.tr.map(r=>r.caption),borderColor:C.purple,backgroundColor:'transparent',borderWidth:2,borderDash:[5,4],tension:.42,pointRadius:0}
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false,callbacks:{title:c=>`Epoch ${c[0].label}${+c[0].label===be?' · best':''}`}}},scales:sc('Epoch','Loss')});

  const B=D.T.best;
  if(B){
    const keys=[['BLEU-4','BLEU-4'],['METEOR','METEOR'],['ROUGE-L','ROUGE-L'],['CIDEr','CIDEr'],['CLIPScore','CLIPScore'],['StyleAcc(VADER)','VADER Acc.']];
    mkChart('c-negPos','bar',{labels:keys.map(k=>k[1]),datasets:[
      {label:'Negative',data:keys.map(k=>M(B.negative,k[0])),errors:keys.map(k=>S(B.negative,k[0])),backgroundColor:rgba(NEG,.78),borderRadius:6,borderSkipped:false},
      {label:'Positive',data:keys.map(k=>M(B.positive,k[0])),errors:keys.map(k=>S(B.positive,k[0])),backgroundColor:rgba(POS,.72),borderRadius:6,borderSkipped:false}
    ]},{plugins:{legend:LEG,tooltip:{mode:'index'}},scales:sc('','Score')},[errorBars]);
  } else emptyCanvas('c-negPos','No test results for this batch');

  const vctx=document.getElementById('c-valCider').getContext('2d');
  mkChartNoAR('c-valCider','line',{labels:D.val.map(v=>v.epoch),datasets:[
    {label:'Negative',data:D.val.map(v=>v.neg.cider),borderColor:NEG,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0},
    {label:'Positive',data:D.val.map(v=>v.pos.cider),borderColor:POS,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0},
    {label:'Mean',data:D.val.map(v=>v.mean.cider),borderColor:C.orange,backgroundColor:grd(vctx,rgba(C.orange,.16),rgba(C.orange,0),220),fill:'origin',borderWidth:2.5,tension:.35,
     pointRadius:D.val.map(v=>v.epoch===be?7:0),pointBackgroundColor:C.orange,pointBorderColor:'#fff',pointBorderWidth:2}
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Epoch','CIDEr')});

  mkChartNoAR('c-valStyle','line',{labels:D.val.map(v=>v.epoch),datasets:[
    {label:'Neg. style acc.',data:D.val.map(v=>v.neg.acc),borderColor:NEG,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0},
    {label:'Pos. style acc.',data:D.val.map(v=>v.pos.acc),borderColor:POS,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0},
    {label:'Selection score',data:D.val.map(v=>v.mean.sel),borderColor:C.purple,backgroundColor:rgba(C.purple,.08),fill:true,borderWidth:2.5,tension:.35,
     pointRadius:D.val.map(v=>v.epoch===be?7:0),pointBackgroundColor:C.purple,pointBorderColor:'#fff',pointBorderWidth:2}
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Epoch','%')});

  if(B){
    const R=[['BLEU-1','BLEU-1'],['BLEU-4','BLEU-4'],['METEOR','METEOR'],['ROUGE-L','ROUGE-L'],['CIDEr','CIDEr'],['CLIPScore','CLIPScore'],['StyleAcc(VADER)','VADER'],['StyleAcc(clf)','Classifier'],['Distinct-2','Distinct-2']];
    const raw=(node)=>R.map(r=>Math.min(100,M(node,r[0])||0));
    mkChartNoAR('c-radar','radar',{labels:R.map(r=>r[1]),datasets:[
      {label:'Negative',data:raw(B.negative),borderColor:NEG,backgroundColor:rgba(NEG,.13),borderWidth:2,pointRadius:3,pointBackgroundColor:NEG},
      {label:'Positive',data:raw(B.positive),borderColor:POS,backgroundColor:rgba(POS,.12),borderWidth:2,pointRadius:3,pointBackgroundColor:POS}
    ]},{plugins:{legend:LEG,tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${fx(c.parsed.r,2)}`}}},
      scales:{r:{min:0,max:100,angleLines:{color:'#e2e6f0'},grid:{color:'#e2e6f0'},pointLabels:{color:'#4b5580',font:{size:11}},ticks:{color:'#8892b0',stepSize:25,backdropColor:'transparent'}}}});
  } else emptyCanvas('c-radar','No test results for this batch');
}

/* ══════════════════════════════════════════════════════════════
   7.  TRAINING PAGE
   ══════════════════════════════════════════════════════════════ */
const COMPONENTS=[['caption','Caption'],['style_clf','Style classifier'],['style_consistency','Style consistency'],['mil','MIL'],['mil_contrastive','MIL contrastive'],
  ['slot_usage','Slot usage'],['prior_null','Prior · NULL'],['prior_patch','Prior · patch'],['overuse','Overuse']];

function renderTraining(){
  /* Stage 1 */
  if(D.tr1.length){
    const c1=document.getElementById('c-stage1').getContext('2d');
    mkChart('c-stage1','line',{labels:D.tr1.map(r=>r.Epoch),datasets:[
      {label:'Caption loss',data:D.tr1.map(r=>r.caption),borderColor:C.blue,backgroundColor:grd(c1,'rgba(37,99,235,.2)','rgba(37,99,235,0)'),fill:true,borderWidth:2.5,tension:.4,pointRadius:3,yAxisID:'y'},
      {label:'Val. factual CIDEr',data:D.v1.map(r=>r.cider),borderColor:C.orange,backgroundColor:'transparent',borderWidth:2.5,tension:.4,pointRadius:3,yAxisID:'y2'}
    ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},
      scales:{x:{title:{display:true,text:'Epoch'},grid:{color:GC}},y:{position:'left',title:{display:true,text:'Loss'},grid:{color:GC},ticks:{color:C.blue}},
              y2:{position:'right',title:{display:true,text:'CIDEr'},grid:{drawOnChartArea:false},ticks:{color:C.orange}}}});
  } else emptyCanvas('c-stage1','No stage-1 logs');

  /* Summary table */
  const t=D.timing||{}, last=D.tr[D.tr.length-1]||{}, first=D.tr[0]||{};
  const b1=D.v1.length?D.v1.reduce((b,v)=>v.cider>b.cider?v:b):null;
  const pl=D.pipeline&&D.pipeline.training;
  document.getElementById('trainStats').innerHTML=`
    <table class="data-table">
      <tr><td>Stage 1 epochs</td><td>${t.pretrain?t.pretrain.epochs:'–'}</td></tr>
      <tr><td>Stage 1 best val. CIDEr</td><td class="best">${b1?`${fx(b1.cider)} (epoch ${b1.epoch})`:'–'}</td></tr>
      <tr><td>Stage 1 time</td><td>${t.pretrain?fx(t.pretrain.total_min)+' min':'–'}</td></tr>
      <tr><td>Stage 2 epochs</td><td>${D.tr.length}</td></tr>
      <tr><td>Stage 2 time (main run)</td><td>${t.stylised?`${fx(t.stylised.total_min,2)} min (${fx(t.stylised.per_epoch_s)} s/epoch)`:'–'}</td></tr>
      ${t.stylised_seeds?`<tr><td>Stage 2 time (full model, ${t.stylised_seeds.n} seeds)</td><td class="best">${pm(t.stylised_seeds.mean_min,t.stylised_seeds.std_min,2)} min</td></tr>`:''}
      <tr><td>Stage 2 total loss</td><td>${fx(first.total,2)} → <span class="best">${fx(last.total,2)}</span> (${isNum(first.total)?fx(100-last.total/first.total*100):'–'}% ↓)</td></tr>
      <tr><td>Best checkpoint (main run)</td><td class="best">Epoch ${D.bestEpoch??'–'}</td></tr>
      ${pl?`<tr><td>Pipeline window</td><td class="muted">${esc(pl.started)} → ${esc((pl.finished||'').slice(11))}</td></tr>`:''}
    </table>
    <div class="cap-note" style="margin-top:8px">Times are the sum of the logged per-epoch seconds. The seed average is the figure reported in the paper (Table I).</div>`;

  /* Components */
  const ep=D.tr.map(r=>r.Epoch);
  const comps=COMPONENTS.filter(([k])=>D.tr.some(r=>isNum(r[k])));
  mkChart('c-components','line',{labels:ep,datasets:[
    ...comps.map(([k,l],i)=>({label:l,data:D.tr.map(r=>r[k]),borderColor:SERIES[i%SERIES.length],backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0,yAxisID:'y'})),
    {label:'Total',data:D.tr.map(r=>r.total),borderColor:'#1e2340',backgroundColor:'transparent',borderWidth:2.5,borderDash:[6,4],tension:.35,pointRadius:0,yAxisID:'y2'}
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},
    scales:{x:{title:{display:true,text:'Epoch'},grid:{color:GC}},y:{position:'left',title:{display:true,text:'Component loss'},grid:{color:GC}},
            y2:{position:'right',title:{display:true,text:'Total'},grid:{drawOnChartArea:false}}}});

  const sl=document.getElementById('compSlider');
  sl.max=Math.max(0,D.tr.length-1); sl.value=D.bestEpoch??0;
  document.getElementById('compSliderVal').textContent=`Epoch ${sl.value}`;
  const drawComp=i=>{
    const r=D.tr[i]; if(!r) return;
    mkChart('c-compBar','bar',{labels:comps.map(c=>c[1]),datasets:[{label:`Epoch ${r.Epoch}`,data:comps.map(([k])=>r[k]),
      backgroundColor:comps.map((_,j)=>SERIES[j%SERIES.length]+'cc'),borderRadius:6,borderSkipped:false}]},
      {indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${fx(c.parsed.x,4)}  (${fx(c.parsed.x/r.total*100)}% of total)`}}},scales:sc('Loss','')});
  };
  drawComp(+sl.value);
  sl.oninput=function(){ document.getElementById('compSliderVal').textContent=`Epoch ${this.value}`; drawComp(+this.value); };

  /* Schedules */
  mkChart('c-sched','line',{labels:ep,datasets:[
    {label:'Learning rate',data:D.tr.map(r=>r.lr),borderColor:C.blue,backgroundColor:'transparent',borderWidth:2,tension:.3,pointRadius:0,yAxisID:'y'},
    {label:'Teacher forcing',data:D.tr.map(r=>r.teacher_forcing),borderColor:C.purple,backgroundColor:'transparent',borderWidth:2,tension:.3,pointRadius:0,yAxisID:'y2'},
    {label:'Ignored style tokens %',data:D.tr.map(r=>r.ignored_style_tokens_pct),borderColor:C.orange,backgroundColor:'transparent',borderWidth:1.5,borderDash:[4,3],tension:.3,pointRadius:0,yAxisID:'y2'},
    {label:'Swapped style tokens %',data:D.tr.map(r=>r.swapped_style_tokens_pct),borderColor:C.cyan,backgroundColor:'transparent',borderWidth:1.5,borderDash:[4,3],tension:.3,pointRadius:0,yAxisID:'y2'}
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},
    scales:{x:{title:{display:true,text:'Epoch'},grid:{color:GC}},y:{position:'left',title:{display:true,text:'LR'},grid:{color:GC},ticks:{color:C.blue,callback:v=>Number(v).toExponential(0)}},
            y2:{position:'right',title:{display:true,text:'Ratio / %'},grid:{drawOnChartArea:false}}}});

  /* Caption length evolution */
  const ev=D.evolution&&D.evolution.stats;
  if(ev){
    const L=(s,f)=>ev[s].map(f);
    mkChart('c-capLen','line',{labels:ev.negative.map(r=>r.epoch),datasets:[
      {label:'Negative mean',data:L('negative',r=>r.mean_len),borderColor:NEG,backgroundColor:rgba(NEG,.08),fill:false,borderWidth:2,tension:.3,pointRadius:0},
      {label:'Neg. ±σ',data:L('negative',r=>r.mean_len+r.std_len),borderColor:rgba(NEG,.3),backgroundColor:rgba(NEG,.06),fill:'+1',borderWidth:1,borderDash:[4,3],tension:.3,pointRadius:0},
      {label:'',data:L('negative',r=>r.mean_len-r.std_len),borderColor:rgba(NEG,.3),backgroundColor:'transparent',borderWidth:1,borderDash:[4,3],tension:.3,pointRadius:0},
      {label:'Positive mean',data:L('positive',r=>r.mean_len),borderColor:POS,backgroundColor:'transparent',borderWidth:2,tension:.3,pointRadius:0},
      {label:'Pos. ±σ',data:L('positive',r=>r.mean_len+r.std_len),borderColor:rgba(POS,.3),backgroundColor:rgba(POS,.06),fill:'+1',borderWidth:1,borderDash:[4,3],tension:.3,pointRadius:0},
      {label:'',data:L('positive',r=>r.mean_len-r.std_len),borderColor:rgba(POS,.3),backgroundColor:'transparent',borderWidth:1,borderDash:[4,3],tension:.3,pointRadius:0}
    ]},{plugins:{legend:{...LEG,labels:{...LEG.labels,filter:i=>!!i.text}},tooltip:{mode:'index',intersect:false,filter:i=>!!i.dataset.label}},scales:sc('Epoch','Words')});
  } else emptyCanvas('c-capLen','No caption dumps for this batch');
}

/* ══════════════════════════════════════════════════════════════
   8.  EVALUATION PAGE
   ══════════════════════════════════════════════════════════════ */
const TEST_ROWS=['BLEU-1','BLEU-2','BLEU-3','BLEU-4','METEOR','ROUGE-L','CIDEr','CLIPScore','StyleAcc(clf)','StyleAcc(VADER)','LexHit(own)','LexHit(opposite)',
  'Distinct-1','Distinct-2','Unique captions %','AvgLen','PPL(teacher-forced)','CHAIR-i','CHAIR-s','StyleHalluc %','CrossPolarity %','OverGen (mean)'];
const LOWER_BETTER=new Set(['PPL(teacher-forced)','CHAIR-i','CHAIR-s','StyleHalluc %','CrossPolarity %','OverGen (mean)','LexHit(opposite)']);

function renderEvaluation(){
  const V=D.val, ep=V.map(v=>v.epoch), be=D.bestEpoch;
  const dot=(arr,col)=>({pointRadius:arr.map(v=>v.epoch===be?6:0),pointBackgroundColor:col,pointBorderColor:'#fff',pointBorderWidth:2});
  const line=(label,data,col,extra={})=>({label,data,borderColor:col,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0,...extra});

  mkChart('c-valBleu','line',{labels:ep,datasets:[
    line('Neg. BLEU-1',V.map(v=>v.neg.b1),NEG,{borderDash:[5,4]}),line('Pos. BLEU-1',V.map(v=>v.pos.b1),POS,{borderDash:[5,4]}),
    line('Neg. BLEU-4',V.map(v=>v.neg.b4),NEG,{yAxisID:'y2',...dot(V,NEG)}),line('Pos. BLEU-4',V.map(v=>v.pos.b4),POS,{yAxisID:'y2',...dot(V,POS)})
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},
    scales:{x:{title:{display:true,text:'Epoch'},grid:{color:GC}},y:{position:'left',title:{display:true,text:'BLEU-1'},grid:{color:GC}},y2:{position:'right',title:{display:true,text:'BLEU-4'},grid:{drawOnChartArea:false}}}});
  mkChart('c-valRouge','line',{labels:ep,datasets:[
    line('Negative',V.map(v=>v.neg.rouge),NEG,dot(V,NEG)),line('Positive',V.map(v=>v.pos.rouge),POS,dot(V,POS)),line('Mean',V.map(v=>v.mean.rouge),C.blue,{borderWidth:2.5})
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Epoch','ROUGE-L')});
  const cc=document.getElementById('c-valCiderFull').getContext('2d');
  mkChart('c-valCiderFull','line',{labels:ep,datasets:[
    line('Negative',V.map(v=>v.neg.cider),NEG),line('Positive',V.map(v=>v.pos.cider),POS),
    line('Mean',V.map(v=>v.mean.cider),C.orange,{borderWidth:2.5,fill:true,backgroundColor:grd(cc,rgba(C.orange,.14),rgba(C.orange,0)),...dot(V,C.orange)})
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Epoch','CIDEr')});
  mkChart('c-valStyleFull','line',{labels:ep,datasets:[
    line('Negative style acc.',V.map(v=>v.neg.acc),NEG),line('Positive style acc.',V.map(v=>v.pos.acc),POS),
    line('Selection score',V.map(v=>v.mean.sel),C.purple,{borderWidth:2.5,...dot(V,C.purple)})
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Epoch','%')});

  const esl=document.getElementById('evalSlider');
  esl.max=Math.max(0,V.length-1); esl.value=be??0;
  document.getElementById('evalSliderVal').textContent=`Epoch ${esl.value}`;
  renderEvalChips(+esl.value);
  esl.oninput=function(){ document.getElementById('evalSliderVal').textContent=`Epoch ${this.value}`; renderEvalChips(+this.value); };

  /* Test table: every available configuration */
  const cols=[];
  if(D.T.source==='seeds'){
    cols.push({h:`Full · ${D.T.n} seeds`,r:D.T.best});
    if(D.T.unc) cols.push({h:'Full · seeds · unconstr.',r:D.T.unc});
  }
  const lab={best:'Main · best',best_unconstrained:'Main · best · unconstr.',last:'Main · last'};
  Object.entries(D.tests||{}).sort().forEach(([k,t])=>cols.push({h:`${lab[k]||k} (E${t.epoch})`,r:wrapSingle(t.results)}));
  const tbl=document.getElementById('testTable');
  document.getElementById('testCols').textContent=`${cols.length} configuration${cols.length!==1?'s':''}`;
  if(!cols.length){ tbl.innerHTML='<tr><td class="muted">No test results were exported for this batch.</td></tr>'; }
  else{
    const head=`<thead><tr><th>Metric</th>${cols.map(c=>`<th class="grp" colspan="2">${esc(c.h)}</th>`).join('')}</tr>
      <tr><th></th>${cols.map(()=>`<th class="neg-c">Neg</th><th class="pos-c">Pos</th>`).join('')}</tr></thead>`;
    const rows=TEST_ROWS.filter(k=>cols.some(c=>isNum(M(c.r.negative,k)))).map(k=>{
      const cells=cols.map(c=>['negative','positive'].map(s=>{const m=M(c.r[s],k),sdv=S(c.r[s],k);return `<td class="num">${pm(m,c.r===D.T.best||c.r===D.T.unc?sdv:0,k==='AvgLen'||k.startsWith('OverGen')?2:1)}</td>`;}).join('')).join('');
      return `<tr><td>${esc(k)}${LOWER_BETTER.has(k)?' <span class="muted">↓</span>':''}</td>${cells}</tr>`;
    }).join('');
    const extra=[];
    const any=cols.find(c=>c.r.classifier_accuracy_on_ground_truth);
    if(any) extra.push(`<tr><td>Classifier acc. on ground truth</td>${cols.map(c=>`<td class="num" colspan="2">${pm(c.r.classifier_accuracy_on_ground_truth?.mean,0)}</td>`).join('')}</tr>`);
    tbl.innerHTML=head+'<tbody>'+rows+extra.join('')+'</tbody>';
  }

  /* Constrained vs unconstrained */
  const B=D.T.best,U=D.T.unc;
  if(B&&U){
    const K=[['negative','CIDEr','Neg CIDEr'],['positive','CIDEr','Pos CIDEr'],['negative','StyleAcc(clf)','Neg clf acc'],['positive','StyleAcc(clf)','Pos clf acc'],
             ['negative','StyleAcc(VADER)','Neg VADER'],['positive','StyleAcc(VADER)','Pos VADER'],['negative','LexHit(own)','Neg lexicon hit'],['positive','LexHit(own)','Pos lexicon hit']];
    mkChart('c-constr','bar',{labels:K.map(k=>k[2]),datasets:[
      {label:'Constrained (selected word required)',data:K.map(k=>M(B[k[0]],k[1])),errors:K.map(k=>S(B[k[0]],k[1])),backgroundColor:rgba(C.blue,.8),borderRadius:6,borderSkipped:false},
      {label:'Unconstrained',data:K.map(k=>M(U[k[0]],k[1])),errors:K.map(k=>S(U[k[0]],k[1])),backgroundColor:rgba(C.purple,.55),borderRadius:6,borderSkipped:false}
    ]},{plugins:{legend:LEG,tooltip:{mode:'index'}},scales:sc('','Score / %')},[errorBars]);
  } else emptyCanvas('c-constr','Unconstrained decoding not available');

  /* Seed spread */
  const seeds=(D.full_seeds||[]).filter(s=>s.best);
  if(seeds.length){
    const K=[['negative','CIDEr','Neg CIDEr'],['positive','CIDEr','Pos CIDEr'],['negative','StyleAcc(VADER)','Neg VADER'],['positive','StyleAcc(VADER)','Pos VADER'],['negative','CLIPScore','Neg CLIPScore'],['negative','CHAIR-s','Neg CHAIR-s']];
    mkChart('c-seeds','bar',{labels:K.map(k=>k[2]),datasets:seeds.map((s,i)=>({label:`Seed ${s.seed} (E${s.best.epoch})`,data:K.map(k=>s.best.results[k[0]][k[1]]),
      backgroundColor:[C.blue,C.purple,C.cyan,C.orange][i%4]+'bb',borderRadius:6,borderSkipped:false}))},
      {plugins:{legend:LEG,tooltip:{mode:'index'}},scales:sc('','Score / %')});
  } else emptyCanvas('c-seeds','Only one seed (main run) for this batch');

  /* Top 10 */
  const sorted=[...V].sort((a,b)=>b.mean.sel-a.mean.sel).slice(0,10);
  document.getElementById('top10Table').innerHTML=`
    <thead><tr><th>#</th><th>Epoch</th><th>Selection</th><th>Mean CIDEr</th><th>Neg CIDEr</th><th>Pos CIDEr</th><th>Neg acc.</th><th>Pos acc.</th><th>Mean BLEU-4</th></tr></thead>
    <tbody>${sorted.map((v,i)=>`<tr${v.epoch===be?' class="hl"':''}>
      <td>${i+1}</td><td class="${v.epoch===be?'best':''}">${v.epoch}${v.epoch===be?' ⭐':''}</td>
      <td class="best">${fx(v.mean.sel,2)}</td><td>${fx(v.mean.cider,2)}</td><td>${fx(v.neg.cider,2)}</td><td>${fx(v.pos.cider,2)}</td>
      <td>${fx(v.neg.acc,1)}</td><td>${fx(v.pos.acc,1)}</td><td>${fx(v.mean.b4,2)}</td></tr>`).join('')}</tbody>`;
}
function renderEvalChips(i){
  const d=D.val[i]; if(!d) return; const t=D.tr[i]||{};
  const items=[
    {l:'Selection',v:fx(d.mean.sel,2),c:C.purple},{l:'Mean CIDEr',v:fx(d.mean.cider,2),c:C.orange},
    {l:'Neg CIDEr',v:fx(d.neg.cider,2),c:NEG},{l:'Pos CIDEr',v:fx(d.pos.cider,2),c:POS},
    {l:'Neg Style Acc',v:fx(d.neg.acc,1),c:NEG},{l:'Pos Style Acc',v:fx(d.pos.acc,1),c:POS},
    {l:'Mean BLEU-4',v:fx(d.mean.b4,2),c:C.blue},{l:'Mean ROUGE-L',v:fx(d.mean.rouge,2),c:C.cyan},
    {l:'Total Loss',v:fx(t.total,3),c:C.slate},{l:'Neg Top Word',v:esc(t.val_negative_top1_word||'–'),c:NEG},{l:'Pos Top Word',v:esc(t.val_positive_top1_word||'–'),c:POS}
  ];
  document.getElementById('evalChips').innerHTML=items.map(x=>`<div class="chip"><div class="chip-l">${x.l}</div><div class="chip-v" style="color:${x.c};font-size:${x.v.length>7?15:20}px">${x.v}</div></div>`).join('');
}

/* ══════════════════════════════════════════════════════════════
   9.  STYLE & GROUNDING PAGE
   ══════════════════════════════════════════════════════════════ */
function renderStyle(){
  const B=D.T.best||{}; const g=B.grounding||{}, cg=B.copy_gate||{}, sel=B.selector||{}, ss=B.style_switch||{};
  const kp=[
    {ico:'🧭',bg:'#cffafe',col:C.cyan,lbl:'Prior Agreement %',val:fx(M(g,'prior_agreement_pct')),sub:`chance ${fx(M(g,'chance_pct'))}%`},
    {ico:'⚖️',bg:'#ede9fe',col:C.purple,lbl:'NULL-Mass Gap',val:fx(M(g,'null_mass_gap'),3),sub:'flat − localisable words'},
    {ico:'🔗',bg:'#dbeafe',col:C.blue,lbl:'Copy Gate · Selected',val:fx(M(cg,'mean_gate_at_selected_words'),3),sub:`elsewhere ${fx(M(cg,'mean_gate_elsewhere'),3)}`},
    {ico:'✅',bg:'#d1fae5',col:C.green,lbl:'Classifier on GT %',val:fx(B.classifier_accuracy_on_ground_truth?.mean),sub:'sentiment classifier sanity'},
    {ico:'🔀',bg:'#fef3c7',col:C.orange,lbl:'Style-Switch Differs %',val:fx(M(ss,'captions_all_different_pct')),sub:`${fx(M(ss,'n_images'),0)} images captioned both ways`},
    {ico:'🌧️',bg:'#fee2e2',col:C.red,lbl:'Neg. Word Sets',val:fx(M(sel.negative,'distinct_sets'),0),sub:`top-1 share ${fx(M(sel.negative,'top1_share_pct'))}%`},
    {ico:'☀️',bg:'#d1fae5',col:C.green,lbl:'Pos. Word Sets',val:fx(M(sel.positive,'distinct_sets'),0),sub:`top-1 share ${fx(M(sel.positive,'top1_share_pct'))}%`},
    {ico:'📏',bg:'#fce7f3',col:C.pink,lbl:'Words / Image',val:fx(mean([M(sel.negative,'words_per_image'),M(sel.positive,'words_per_image')]),2),sub:'selected style words'},
  ];
  const gk=document.getElementById('groundKpi');
  gk.innerHTML=D.T.best?kpiHTML(kp):''; countUp(gk);

  /* Diagnostics per epoch */
  const dg=D.diagnostics||[];
  ['negative','positive'].forEach(s=>{
    const id=s==='negative'?'c-diagNeg':'c-diagPos', col=s==='negative'?NEG:POS;
    if(!dg.length){ emptyCanvas(id,'No epoch diagnostics'); return; }
    mkChart(id,'line',{labels:dg.map(r=>r.epoch),datasets:[
      {label:'Classifier %',data:dg.map(r=>r[`${s} clf %`]),borderColor:col,backgroundColor:rgba(col,.08),fill:true,borderWidth:2.5,tension:.35,pointRadius:0},
      {label:'VADER %',data:dg.map(r=>r[`${s} VADER %`]),borderColor:C.blue,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0},
      {label:'Own-lexicon word %',data:dg.map(r=>r[`${s} own-word %`]),borderColor:C.purple,backgroundColor:'transparent',borderWidth:2,tension:.35,pointRadius:0},
      {label:'Uses selected word %',data:dg.map(r=>r[`${s} uses selected %`]),borderColor:C.orange,backgroundColor:'transparent',borderWidth:1.5,borderDash:[5,4],tension:.35,pointRadius:0},
      {label:'Opposite-lexicon %',data:dg.map(r=>r[`${s} opposite-word %`]),borderColor:C.slate,backgroundColor:'transparent',borderWidth:1.5,borderDash:[2,3],tension:.35,pointRadius:0},
      {label:'Captions differ %',data:dg.map(r=>r['captions differ %']),borderColor:C.cyan,backgroundColor:'transparent',borderWidth:1.5,borderDash:[5,4],tension:.35,pointRadius:0}
    ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false,callbacks:{afterBody:c=>{const r=dg[c[0].dataIndex];return `Top-1: ${r[`${s} top-1`]||'–'} · ${r[`${s} distinct sets`]} word sets`;}}}},scales:sc('Epoch','%')});
  });

  /* Selector evolution */
  const se=D.selector_evolution;
  ['negative','positive'].forEach(s=>{
    const id=s==='negative'?'c-selNeg':'c-selPos';
    if(!se){ emptyCanvas(id,'No selector log'); return; }
    mkChart(id,'line',{labels:se.epochs.map(e=>e.epoch),datasets:se.words[s].map((w,i)=>({label:w,data:se.epochs.map(e=>e[s][w]),
      borderColor:SERIES[i%SERIES.length],backgroundColor:'transparent',borderWidth:w==='dead'?3:2,tension:.3,pointRadius:0}))},
      {plugins:{legend:LEG,tooltip:{mode:'index',intersect:false,itemSort:(a,b)=>b.parsed.y-a.parsed.y}},scales:{...sc('Epoch','% of images (top-1)'),y:{...sc().y,min:0}}});
  });

  /* Presence spread */
  const ps=(D.T.detail&&D.T.detail.presence_spread)||[];
  if(ps.length){
    const top=s=>ps.filter(w=>w.style===s).sort((a,b)=>b.selected_pct-a.selected_pct).slice(0,10);
    const W=[...top('negative'),...top('positive')];
    mkChart('c-presence','bar',{labels:W.map(w=>w.word),datasets:[{label:'Mean presence score',data:W.map(w=>w.mean),errors:W.map(w=>w.std),
      backgroundColor:W.map(w=>rgba(w.style==='negative'?NEG:POS,.75)),borderRadius:4,borderSkipped:false,errorColor:'#4b5580'}]},
      {indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>{const w=W[c.dataIndex];return [`mean ${fx(w.mean,3)} ± ${fx(w.std,3)}`,`selected for ${fx(w.selected_pct)}% of ${w.style} images`];}}}},
       scales:{x:{title:{display:true,text:'Presence logit (relative)'},grid:{color:GC}},y:{grid:{display:false},ticks:{autoSkip:false,font:{size:10.5}}}}},[errorBars]);
  } else emptyCanvas('c-presence','No presence-spread file');

  /* NULL mass */
  if(D.T.best && g.mean_null_mass_flat_words){
    mkChart('c-null','bar',{labels:['Flat (non-visual) words','Localisable words'],datasets:[
      {label:'Model NULL mass',data:[M(g,'mean_null_mass_flat_words'),M(g,'mean_null_mass_localisable_words')],errors:[S(g,'mean_null_mass_flat_words'),S(g,'mean_null_mass_localisable_words')],backgroundColor:rgba(C.purple,.75),borderRadius:6,borderSkipped:false},
      {label:'CLIP prior p(NULL)',data:[M(g,'prior_p_null_flat_words'),M(g,'prior_p_null_localisable_words')],errors:[S(g,'prior_p_null_flat_words'),S(g,'prior_p_null_localisable_words')],backgroundColor:rgba(C.cyan,.6),borderRadius:6,borderSkipped:false}
    ]},{plugins:{legend:LEG,tooltip:{callbacks:{afterBody:c=>c[0].dataIndex===0?`n = ${fx(M(g,'n_flat'),0)} words`:`n = ${fx(M(g,'n_localisable'),0)} words`}}},scales:{...sc('','Mass'),y:{...sc().y,min:0,max:1}}},[errorBars]);
  } else emptyCanvas('c-null','No grounding diagnostics');

  /* Over-generation (detail run) */
  const det=D.T.detail&&D.T.detail.results;
  if(det && det.negative && det.negative['OverGen top-5']){
    const n5=det.negative['OverGen top-5'], p5=det.positive['OverGen top-5']||[];
    const L=[...n5.map(x=>x[0]),...p5.map(x=>x[0])];
    mkChart('c-overgen','bar',{labels:L,datasets:[{label:'Over-generation ratio',data:[...n5.map(x=>x[1]),...p5.map(x=>x[1])],
      backgroundColor:[...n5.map(()=>rgba(NEG,.75)),...p5.map(()=>rgba(POS,.7))],borderRadius:5,borderSkipped:false}]},
      {plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`× ${fx(c.parsed.y,2)} vs reference rate`}}},scales:sc('','Generated ÷ reference frequency')});
  } else emptyCanvas('c-overgen','Not available');

  /* "dead" failure — headline from the main run (the run the paper quotes), seeds listed below */
  const mainD=D.tests&&D.tests.best&&D.tests.best.dead, mainU=D.tests&&D.tests.best_unconstrained&&D.tests.best_unconstrained.dead;
  const dd=mainD?[mainD]:(D.T.dead||[]), du=mainD?(mainU?[mainU]:[]):(D.T.deadUnc||[]);
  const box=document.getElementById('deadStats');
  if(dd.length){
    const tot=mean(dd.map(x=>x.n_negative)), wd=mean(dd.map(x=>x.with_dead)), an=mean(dd.map(x=>x.dead_on_animate));
    const srcLbl=mainD?`main run, epoch ${D.tests.best.epoch}`:(dd.length>1?'mean of seeds':'');
    const per=(D.full_seeds||[]).length?`<div class="sub-label" style="margin-top:4px">Full-model seeds</div><table class="data-table compact" style="margin-top:6px"><thead><tr><th>Seed</th><th>“dead”</th><th>On animate</th><th>Unconstr.</th></tr></thead><tbody>${
      (D.full_seeds||[]).filter(s=>s.best&&s.best.dead).map(s=>`<tr><td>${s.seed}</td><td>${s.best.dead.with_dead}/${s.best.dead.n_negative}</td><td>${s.best.dead.dead_on_animate}</td><td>${s.best_unconstrained&&s.best_unconstrained.dead?s.best_unconstrained.dead.with_dead:'–'}</td></tr>`).join('')}</tbody></table>`:'';
    box.innerHTML=`<div class="stat-rows">
      <div><div class="stat-big" style="color:${NEG}">${fx(wd,0)} <span style="font-size:15px;color:var(--t3)">/ ${fx(tot,0)}</span></div><div class="stat-cap">negative test captions contain “dead” (${fx(wd/tot*100)}%)${srcLbl?' · '+srcLbl:''}</div></div>
      <div><div class="stat-big" style="color:${C.orange}">${fx(an,0)}</div><div class="stat-cap">of them attach it to a person or animal (“dead man”, “dead dog”)</div></div>
      ${du.length?`<div><div class="stat-big" style="color:${C.purple}">${fx(mean(du.map(x=>x.with_dead)),0)}</div><div class="stat-cap">with unconstrained decoding (no selected word required)</div></div>`:''}
      ${per}
      <div class="cap-note">Animate = word right after “dead” (or one later) is in a fixed person/animal list, so counts can differ slightly from a manual tally.</div></div>`;
    const fol=((mainD&&mainD.following_word_top)||(D.T.detail&&D.T.detail.dead&&D.T.detail.dead.following_word_top))||[];
    if(fol.length) mkChart('c-dead','bar',{labels:fol.map(x=>x[0]),datasets:[{label:'Count',data:fol.map(x=>x[1]),
      backgroundColor:fol.map(x=>ANIMATE.has(x[0])?rgba(NEG,.8):rgba(C.slate,.35)),borderRadius:5,borderSkipped:false}]},
      {plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:c=>ANIMATE.has(fol[c.dataIndex][0])?'animate noun':''}}},scales:sc('','Captions')});
    else emptyCanvas('c-dead','No caption file');
  } else { box.innerHTML='<div class="muted">No test captions exported for this batch.</div>'; emptyCanvas('c-dead','Not available'); }
}

/* ══════════════════════════════════════════════════════════════
   10.  CAPTIONS PAGE
   ══════════════════════════════════════════════════════════════ */
function hl(text, style){
  return esc(text).split(/(\s+)/).map(tok=>{
    const w=tok.toLowerCase().replace(/[^a-z']/g,'');
    const s=D.lex[w];
    return s ? `<mark class="${s==='negative'?'neg':'pos'}">${tok}</mark>` : tok;
  }).join('');
}
const wordsLine = ws => ws&&ws.length ? `<div class="cap-words">selected: ${ws.map(([w,s])=>`${esc(w)} ${fx(s,2)}`).join(' · ')}</div>` : '';
const thumb = img => `<img class="cap-img" loading="lazy" src="${cocoUrl(img)}" alt="" onerror="this.style.display='none'">`;

function renderCaptions(){
  CAP_SHOWN=12; drawCaptionGrid();
  renderFig3().catch(e=>console.error('fig3',e));

  /* Evolution */
  const ev=D.evolution;
  const tabs=document.getElementById('evoTabs');
  if(ev && ev.images.length){
    tabs.innerHTML=ev.images.map((img,i)=>`<button class="evo-tab${i===0?' active':''}" onclick="setEvoImg('${img}',this)">${img.replace(/\.jpg$/,'').slice(-6)}</button>`).join('');
    setEvoImg(ev.images[0],tabs.querySelector('.evo-tab'));
  } else { tabs.innerHTML=''; document.getElementById('evoTimeline').innerHTML='<div class="muted">No caption dumps for this batch.</div>'; }

  /* Qualitative */
  const qb=document.getElementById('qualTabs');
  qb.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  qb.onclick=e=>{ const t=e.target.closest('.tab'); if(!t) return; qb.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); drawQual(t.dataset.q); };
  drawQual('negative|best');

  /* Length distribution */
  const cs=D.T.detail&&D.T.detail.caption_stats;
  if(cs && cs.negative){
    const bins=Array.from({length:14},(_,i)=>i+5);
    const pct=(st,b)=>{const h=st.len_hist||{};const n=Object.values(h).reduce((a,v)=>a+v,0)||1;return (h[b]||0)/n*100;};
    mkChart('c-capDist','bar',{labels:bins,datasets:[
      {label:`Negative (mean ${fx(cs.negative.mean_len,2)})`,data:bins.map(b=>pct(cs.negative,b)),backgroundColor:rgba(NEG,.45),borderColor:NEG,borderWidth:1.5,borderRadius:3},
      {label:`Positive (mean ${fx(cs.positive.mean_len,2)})`,data:bins.map(b=>pct(cs.positive,b)),backgroundColor:rgba(POS,.4),borderColor:POS,borderWidth:1.5,borderRadius:3}
    ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Length (words)','Frequency %')});
  } else emptyCanvas('c-capDist','No test captions');
}
function drawCaptionGrid(){
  const sw=(D.T.detail&&D.T.detail.style_switch)||[];
  const g=document.getElementById('capGrid');
  if(!sw.length){ g.innerHTML='<div class="muted">No style-switch captions exported for this batch.</div>'; document.getElementById('moreCaps').style.display='none'; return; }
  g.innerHTML=sw.slice(0,CAP_SHOWN).map(c=>`
    <div class="cap-item">${thumb(c.image)}
      <div class="cap-body">
        <div class="cap-file">${esc(c.image)}</div>
        <div class="cap-line"><span class="cap-tag neg">neg</span><div><div class="cap-text">${hl(c.negative)}</div>${wordsLine(c.neg_words)}</div></div>
        <div class="cap-line"><span class="cap-tag pos">pos</span><div><div class="cap-text">${hl(c.positive)}</div>${wordsLine(c.pos_words)}</div></div>
      </div>
    </div>`).join('');
  document.getElementById('moreCaps').style.display=CAP_SHOWN<sw.length?'inline-flex':'none';
}
function moreCaptions(){ CAP_SHOWN+=12; drawCaptionGrid(); }
window.moreCaptions=moreCaptions;

function setEvoImg(img,btn){
  document.querySelectorAll('.evo-tab').forEach(b=>b.classList.remove('active')); if(btn) btn.classList.add('active');
  const ev=D.evolution, caps=ev.captions[img]||{}, be=D.bestEpoch;
  document.getElementById('evoTimeline').innerHTML=`<div class="cap-item" style="margin-bottom:10px">${thumb(img)}<div class="cap-body"><div class="cap-file">${esc(img)}</div><div class="cap-note">Validation image · captions from every stage-2 epoch · best epoch highlighted</div></div></div>`+
    ev.epochs.map(ep=>`
    <div class="evo-row${ep===be?' best-ep':''}">
      <div class="evo-ep">E${ep}${ep===be?'★':''}</div>
      <div class="evo-pair">
        <div class="cap-line"><span class="cap-tag neg">neg</span><div class="evo-cap">${caps.negative&&caps.negative[ep]!=null?hl(caps.negative[ep]):'–'}</div></div>
        <div class="cap-line"><span class="cap-tag pos">pos</span><div class="evo-cap">${caps.positive&&caps.positive[ep]!=null?hl(caps.positive[ep]):'–'}</div></div>
      </div>
    </div>`).join('');
}
window.setEvoImg=setEvoImg;

function drawQual(key){
  const [s,b]=key.split('|'); const q=(D.T.detail&&D.T.detail.qualitative&&D.T.detail.qualitative[s])||[];
  const items=q.filter(x=>x.bucket===b);
  document.getElementById('qualGrid').innerHTML=items.length?items.map(x=>`
    <div class="cap-item">${thumb(x.image)}
      <div class="cap-body">
        <div class="cap-file">${esc(x.image)} · CIDEr ${fx(x.cider,1)}</div>
        <div class="cap-line"><span class="cap-tag ${s==='negative'?'neg':'pos'}">gen</span><div><div class="cap-text">${hl(x.generated)}</div>${wordsLine(x.style_words)}</div></div>
        ${(x.ground_truth||[]).map(t=>`<div class="cap-line"><span class="cap-tag gt">ref</span><div class="cap-gt">${hl(t)}</div></div>`).join('')}
      </div>
    </div>`).join(''):'<div class="muted">No qualitative examples for this batch.</div>';
}

/* ══════════════════════════════════════════════════════════════
   11.  ABLATIONS PAGE
   ══════════════════════════════════════════════════════════════ */
const ABL_METRICS=[
  ['mean CIDEr','Mean CIDEr',1],['negative CIDEr','Neg CIDEr',1],['positive CIDEr','Pos CIDEr',1],
  ['negative StyleAcc(VADER)','Neg VADER',1],['positive StyleAcc(VADER)','Pos VADER',1],['negative StyleAcc(clf)','Neg clf acc.',1],
  ['mean BLEU-4','Mean BLEU-4',1],['negative CLIPScore','Neg CLIPScore',1],['negative CHAIR-s','Neg CHAIR-s',-1],
  ['grounding prior_agreement_pct','Prior agreement',1],['grounding null_mass_gap','NULL-mass gap',1],['selector negative top1_share_pct','Neg top-1 share',-1]
];
let ABL_KEY='mean CIDEr';

function renderAblations(){
  const A=D.ablations, empty=document.getElementById('ablEmpty'), body=document.getElementById('ablBody');
  if(!A||!A.summary||!A.summary.full){
    body.style.display='none';
    empty.innerHTML=`<div class="empty-state"><div class="es-ico">🧪</div><h3>No ablation results for ${esc(D.batch)}</h3>
      <p>The exporter looks for <code>${esc(D.batch)}/AblationResults/Summary/Ablations.json</code>. Once that folder exists, rerun
      <code>python export_results.py</code> and commit <code>data/</code>; this page fills in automatically.</p></div>`;
    return;
  }
  empty.innerHTML=''; body.style.display='block';
  document.getElementById('ablSeeds').textContent=`${(A.seeds||[]).length} seeds · ${Object.keys(A.summary).length} variants${(A.failures||[]).length?` · ${A.failures.length} failed`:''}`;
  const avail=ABL_METRICS.filter(m=>A.summary.full[m[0]]);
  if(!avail.find(m=>m[0]===ABL_KEY)) ABL_KEY=avail[0][0];
  buildTabs('ablTabs',avail.map(m=>[m[0],m[1]]),k=>{ABL_KEY=k;drawAblDelta();},ABL_KEY);
  buildTabs('ablScope',[['paper','Paper variants (Table II)'],['all','All variants']],k=>{ABL_SCOPE=k;renderAblations();},ABL_SCOPE);
  drawAblDelta();

  /* Table */
  const cols=[['negative CIDEr','Neg CIDEr'],['positive CIDEr','Pos CIDEr'],['mean CIDEr','Δ Mean CIDEr','delta'],['negative StyleAcc(VADER)','Neg VADER'],['positive StyleAcc(VADER)','Pos VADER'],
    ['negative StyleAcc(clf)','Neg clf'],['negative CLIPScore','CLIPScore'],['negative CHAIR-s','CHAIR-s ↓'],['grounding prior_agreement_pct','Prior agr.'],['test epoch','Test ep.']];
  const vs=['full',...ablVariants(A.summary)];
  document.getElementById('ablTable').innerHTML=`<thead><tr><th>Variant</th><th>n</th>${cols.map(c=>`<th>${c[1]}</th>`).join('')}</tr></thead><tbody>${
    vs.map(v=>{const s=A.summary[v]||{},p=(A.p_vs_full||{})[v]||{};
      return `<tr${v==='full'?' class="hl"':''}><td><b>${esc(vlabel(v))}</b>${extraTag(v)}<div class="muted" style="font-size:10px;font-family:'Space Mono',monospace">${esc(v)}</div></td><td>${(s['negative CIDEr']||{}).n??'–'}</td>${
        cols.map(([k,_,mode])=>{const x=s[k]||{};
          if(mode==='delta'){ if(v==='full') return `<td class="num">${pm(x.mean,x.std)}</td>`;
            const dlt=x.mean-A.summary.full[k].mean; return `<td class="num ${dlt>=0?'delta-up':'delta-dn'}">${dlt>=0?'+':''}${fx(dlt,2)}<span class="sig">${stars(p[k])}</span></td>`; }
          const st=v==='full'?'':stars(p[k]);
          return `<td class="num">${k==='test epoch'?fx(x.mean,1):pm(x.mean,x.std)}${st?`<span class="sig">${st}</span>`:''}</td>`;}).join('')}</tr>`;}).join('')}</tbody>`;

  /* Heatmap of Δ, coloured by good/bad direction, normalised per column */
  const hv=ablVariants(A.summary);
  const deltas=avail.map(m=>hv.map(v=>{const a=A.summary[v][m[0]],f=A.summary.full[m[0]];return a&&f?a.mean-f.mean:null;}));
  const scale=deltas.map(col=>Math.max(...col.filter(isNum).map(Math.abs),1e-9));
  document.getElementById('ablHeat').innerHTML=`<table class="heatmap-table"><thead><tr><th></th>${avail.map(m=>`<th>${m[1]}</th>`).join('')}</tr></thead><tbody>${
    hv.map((v,ri)=>`<tr><th style="text-align:right;padding-right:10px;color:${C.blue};font-weight:700;white-space:nowrap">${esc(vlabel(v))}</th>${
      avail.map((m,ci)=>{const d=deltas[ci][ri];const p=((A.p_vs_full||{})[v]||{})[m[0]];
        if(!isNum(d)) return '<td>–</td>';
        const t=d/scale[ci]*m[2];
        return `<td style="background:${divColor(t)};color:#1e2340" title="${esc(vlabel(v))} · ${m[1]}: Δ ${fx(d,3)}${isNum(p)?` · p=${p.toPrecision(2)}`:''}">${d>=0?'+':''}${fx(d,Math.abs(d)<1?2:1)}${stars(p)}</td>`;}).join('')}</tr>`).join('')}</tbody></table>
    <div class="cap-note" style="margin-top:8px">Green = change in the desirable direction for that metric, red = undesirable. Shade is relative to the largest change in each column.</div>`;
}
function drawAblDelta(){
  const A=D.ablations; const k=ABL_KEY; const m=ABL_METRICS.find(x=>x[0]===k)||[k,k,1];
  const f=A.summary.full[k].mean;
  const vs=ablVariants(A.summary).filter(v=>A.summary[v][k]);
  const rows=vs.map(v=>({v,d:A.summary[v][k].mean-f,e:A.summary[v][k].std,p:((A.p_vs_full||{})[v]||{})[k]})).sort((a,b)=>b.d*m[2]-a.d*m[2]);
  mkChart('c-ablDelta','bar',{labels:rows.map(r=>vlabel(r.v)),datasets:[{label:`Δ ${m[1]} vs full (${fx(f,2)})`,data:rows.map(r=>r.d),errors:rows.map(r=>r.e),stars:rows.map(r=>stars(r.p)),
    backgroundColor:rows.map(r=>(r.d*m[2]>=0?rgba(C.green,.75):rgba(C.red,.75))),borderRadius:5,borderSkipped:false}]},
    {plugins:{legend:LEG,tooltip:{callbacks:{label:c=>{const r=rows[c.dataIndex];return [`Δ ${fx(r.d,3)}  (σ ${fx(r.e,3)})`,isNum(r.p)?`Welch p = ${r.p.toPrecision(2)}`:''];}}}},
     scales:{x:{grid:{display:false},ticks:{autoSkip:false,maxRotation:40,minRotation:30,font:{size:10.5}}},y:{title:{display:true,text:`Δ ${m[1]}${m[2]<0?' (lower is better)':''}`},grid:{color:GC}}}},[errorBars,starLabels]);
}

/* ══════════════════════════════════════════════════════════════
   12.  BATCH COMPARISON PAGE
   ══════════════════════════════════════════════════════════════ */
let CMP_KEY='mean CIDEr', CMP_RUN=0;
async function renderCompare(){
  const run=++CMP_RUN;
  const note=document.getElementById('cmpNote');
  let all=[];
  try{
    note.innerHTML='Loading all batches…';
    all=(await Promise.all(INDEX.map(b=>getBatch(b.name).catch(()=>null)))).filter(Boolean).sort((a,b)=>a.batch_size-b.batch_size);
  }catch(e){ note.innerHTML='Could not load the other batches.'; return; }
  if(run!==CMP_RUN) return;   /* a newer call superseded this one */
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const pend=EXPECTED_BATCHES.filter(n=>!all.find(b=>b.batch===n));
  note.innerHTML=`Comparing <b>${all.map(b=>b.batch_size).join(', ')}</b>. Test values use the full model averaged over seeds where ablations exist, otherwise the main run (marked †).${pend.length?` Pending: <b>${pend.join(', ')}</b>.`:''}`;
  const L=all.map(b=>`B = ${b.batch_size}${b.T.source==='main'?' †':''}`);
  const get=(b,s,k)=>b.T.best?M(b.T.best[s],k):null, gsd=(b,s,k)=>b.T.best?S(b.T.best[s],k):null;
  const getU=(b,s,k)=>b.T.unc?M(b.T.unc[s],k):null;
  const gg=(b,k)=>b.T.best&&b.T.best.grounding?M(b.T.best.grounding,k):null;
  const cg=(b,k)=>b.T.best&&b.T.best.copy_gate?M(b.T.best.copy_gate,k):null;

  /* Summary table */
  const rows=[
    ['Test source',b=>b.T.source==='seeds'?`${b.T.n} seeds`:b.T.source==='main'?'main run':'–'],
    ['Best epoch(s)',b=>b.T.epochs?b.T.epochs.join(', '):'–'],
    ['Neg CIDEr',b=>pm(get(b,'negative','CIDEr'),gsd(b,'negative','CIDEr'))],
    ['Pos CIDEr',b=>pm(get(b,'positive','CIDEr'),gsd(b,'positive','CIDEr'))],
    ['Neg VADER %',b=>pm(get(b,'negative','StyleAcc(VADER)'),gsd(b,'negative','StyleAcc(VADER)'))],
    ['Pos VADER %',b=>pm(get(b,'positive','StyleAcc(VADER)'),gsd(b,'positive','StyleAcc(VADER)'))],
    ['Neg clf % (unconstr.)',b=>fx(getU(b,'negative','StyleAcc(clf)'))],
    ['Neg lexicon hit % (unconstr.)',b=>fx(getU(b,'negative','LexHit(own)'))],
    ['CLIPScore (neg)',b=>pm(get(b,'negative','CLIPScore'),gsd(b,'negative','CLIPScore'))],
    ['CHAIR-s (neg) ↓',b=>pm(get(b,'negative','CHAIR-s'),gsd(b,'negative','CHAIR-s'))],
    ['Prior agreement %',b=>fx(gg(b,'prior_agreement_pct'))],
    ['Copy gate @ selected',b=>fx(cg(b,'mean_gate_at_selected_words'),3)],
    ['“dead” in neg captions (main run)',b=>{const d=b.tests&&b.tests.best&&b.tests.best.dead;return d?`${d.with_dead} / ${d.n_negative} (${fx(d.with_dead/d.n_negative*100)}%)`:'–';}],
    ['“dead” unconstrained (main run)',b=>{const d=b.tests&&b.tests.best_unconstrained&&b.tests.best_unconstrained.dead;return d?`${d.with_dead}`:'–';}],
    ['“dead” in neg captions (seed mean)',b=>b.T.dead&&b.T.dead.length?`${fx(mean(b.T.dead.map(x=>x.with_dead)),0)} / ${fx(mean(b.T.dead.map(x=>x.n_negative)),0)}`:'–'],
    ['Stage-1 best val CIDEr',b=>b.v1.length?fx(Math.max(...b.v1.map(v=>v.cider))):'–'],
    ['Stage-2 time, min (seed mean)',b=>b.timing&&b.timing.stylised_seeds?pm(b.timing.stylised_seeds.mean_min,b.timing.stylised_seeds.std_min,2):'–'],
    ['Stage-2 time, min (main run)',b=>b.timing&&b.timing.stylised?fx(b.timing.stylised.total_min,2):'–'],
    ['Val. selection @ tested checkpoint',b=>{const v=b.val.find(x=>x.epoch===b.bestEpoch);return v?`${fx(v.mean.sel,1)} (E${b.bestEpoch})`:'–';}],
    ['Max val. selection',b=>{if(!b.val.length) return '–';const v=b.val.reduce((a,x)=>x.mean.sel>a.mean.sel?x:a);return `${fx(v.mean.sel,1)} (E${v.epoch})`;}],
  ];
  document.getElementById('cmpTable').innerHTML=`<thead><tr><th>Metric</th>${all.map(b=>`<th${b.batch===D.batch?' style="color:var(--blue)"':''}>${b.batch}</th>`).join('')}</tr></thead><tbody>${
    rows.map(([l,f])=>`<tr><td>${l}</td>${all.map(b=>`<td class="num">${f(b)}</td>`).join('')}</tr>`).join('')}</tbody>`;

  const ln=(label,data,col,errors,extra={})=>({label,data,errors,borderColor:col,backgroundColor:col,borderWidth:2.5,tension:0,pointRadius:5,pointHoverRadius:7,...extra});
  mkChart('c-cmpCider','line',{labels:L,datasets:[
    ln('Negative CIDEr',all.map(b=>get(b,'negative','CIDEr')),NEG,all.map(b=>gsd(b,'negative','CIDEr'))),
    ln('Positive CIDEr',all.map(b=>get(b,'positive','CIDEr')),POS,all.map(b=>gsd(b,'positive','CIDEr')))
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Batch size','CIDEr')},[errorBars]);
  mkChart('c-cmpStyle','line',{labels:L,datasets:[
    ln('Neg VADER % (constrained)',all.map(b=>get(b,'negative','StyleAcc(VADER)')),NEG,all.map(b=>gsd(b,'negative','StyleAcc(VADER)'))),
    ln('Neg clf % (unconstrained)',all.map(b=>getU(b,'negative','StyleAcc(clf)')),C.purple),
    ln('Neg lexicon hit % (unconstrained)',all.map(b=>getU(b,'negative','LexHit(own)')),C.orange)
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},scales:sc('Batch size','%')},[errorBars]);
  mkChart('c-cmpGround','line',{labels:L,datasets:[
    ln('Prior agreement %',all.map(b=>gg(b,'prior_agreement_pct')),C.cyan,null,{yAxisID:'y'}),
    ln('Copy gate @ selected',all.map(b=>cg(b,'mean_gate_at_selected_words')),C.blue,null,{yAxisID:'y2'}),
    ln('NULL-mass gap',all.map(b=>gg(b,'null_mass_gap')),C.purple,null,{yAxisID:'y2',borderDash:[5,4]})
  ]},{plugins:{legend:LEG,tooltip:{mode:'index',intersect:false}},
    scales:{x:{title:{display:true,text:'Batch size'},grid:{color:GC}},y:{position:'left',title:{display:true,text:'%'},grid:{color:GC},ticks:{color:C.cyan}},y2:{position:'right',title:{display:true,text:'Gate / mass'},grid:{drawOnChartArea:false}}}},[errorBars]);
  mkChart('c-cmpTime','bar',{labels:L,datasets:[
    {label:'Stage 1 (min)',data:all.map(b=>b.timing&&b.timing.pretrain?b.timing.pretrain.total_min:null),backgroundColor:rgba(C.blue,.75),borderRadius:6,borderSkipped:false,yAxisID:'y'},
    {label:'Stage 2 (min, seed mean)',data:all.map(b=>b.timing&&b.timing.stylised_seeds?b.timing.stylised_seeds.mean_min:(b.timing&&b.timing.stylised?b.timing.stylised.total_min:null)),
     errors:all.map(b=>b.timing&&b.timing.stylised_seeds?b.timing.stylised_seeds.std_min:0),backgroundColor:rgba(C.orange,.75),borderRadius:6,borderSkipped:false,yAxisID:'y2'}
  ]},{plugins:{legend:LEG,tooltip:{mode:'index'}},
    scales:{x:{grid:{display:false}},y:{position:'left',title:{display:true,text:'Stage 1 min'},grid:{color:GC},ticks:{color:C.blue}},y2:{position:'right',title:{display:true,text:'Stage 2 min'},grid:{drawOnChartArea:false},ticks:{color:C.orange}}}},[errorBars]);

  /* Ablation × batch heatmap */
  const withA=all.filter(b=>b.ablations&&b.ablations.summary);
  const wrap=document.getElementById('cmpAblHeat');
  if(!withA.length){ document.getElementById('cmpAblTabs').innerHTML=''; wrap.innerHTML='<div class="muted">No batch has ablation results yet.</div>'; return; }
  const avail=ABL_METRICS.filter(m=>withA.some(b=>b.ablations.summary.full[m[0]]));
  buildTabs('cmpAblTabs',avail.map(m=>[m[0],m[1]]),k=>{CMP_KEY=k;draw();},CMP_KEY);
  buildTabs('cmpAblScope',[['paper','Paper variants (Table II)'],['all','All variants']],k=>{ABL_SCOPE=k;draw();},ABL_SCOPE);
  function draw(){
    const m=ABL_METRICS.find(x=>x[0]===CMP_KEY)||avail[0];
    const merged={}; withA.forEach(b=>Object.assign(merged,b.ablations.summary));
    const vars=ablVariants(merged);
    const cell=(b,v)=>{const s=b.ablations.summary; if(!s[v]||!s[v][m[0]]||!s.full[m[0]]) return null; return {d:s[v][m[0]].mean-s.full[m[0]].mean,p:((b.ablations.p_vs_full||{})[v]||{})[m[0]]};};
    const mx=Math.max(...vars.flatMap(v=>withA.map(b=>{const c=cell(b,v);return c?Math.abs(c.d):0;})),1e-9);
    const missing=all.filter(b=>!withA.includes(b)).map(b=>b.batch);
    wrap.innerHTML=`<table class="heatmap-table"><thead><tr><th></th>${withA.map(b=>`<th>B = ${b.batch_size}</th>`).join('')}</tr></thead><tbody>${
      vars.map(v=>`<tr><th style="text-align:right;padding-right:10px;color:${C.blue};font-weight:700;white-space:nowrap">${esc(vlabel(v))}${extraTag(v)}</th>${
        withA.map(b=>{const c=cell(b,v); if(!c) return '<td>–</td>';
          return `<td style="background:${divColor(c.d/mx*m[2])};color:#1e2340" title="p=${isNum(c.p)?c.p.toPrecision(2):'–'}">${c.d>=0?'+':''}${fx(c.d,Math.abs(c.d)<1?2:1)}${stars(c.p)}</td>`;}).join('')}</tr>`).join('')}
      <tr><th style="text-align:right;padding-right:10px;white-space:nowrap">Full model ${m[1]}</th>${withA.map(b=>`<td><b>${fx(b.ablations.summary.full[m[0]]?.mean,2)}</b></td>`).join('')}</tr></tbody></table>
      <div class="cap-note" style="margin-top:8px">Δ vs the full model at the same batch size. ${missing.length?`No ablations for ${missing.join(', ')}.`:''}</div>`;
  }
  draw();
  ['c-cmpCider','c-cmpStyle','c-cmpGround','c-cmpTime'].forEach(id=>CHS[id]&&CHS[id].resize());
}

/* ══════════════════════════════════════════════════════════════
   13.  INSIGHTS PAGE
   ══════════════════════════════════════════════════════════════ */
function renderInsights(){
  const ins=[]; const B=D.T.best, U=D.T.unc;
  const V=D.val, best=V.find(v=>v.epoch===D.bestEpoch)||V[V.length-1];
  if(best) ins.push({ico:'🎯',bg:'#fef3c7',title:`Best Checkpoint: Epoch ${D.bestEpoch}`,desc:`The checkpoint the pipeline saved as <i>stylised_best</i> (validation selection score ${fx(best.mean.sel,1)}; the highest logged score is ${fx(Math.max(...V.map(v=>v.mean.sel)),1)} at epoch ${V.reduce((b,v)=>v.mean.sel>b.mean.sel?v:b).epoch}). At epoch ${D.bestEpoch}, validation CIDEr is ${fx(best.neg.cider,1)} negative / ${fx(best.pos.cider,1)} positive with style accuracy ${fx(best.neg.acc,1)}% / ${fx(best.pos.acc,1)}%.`});
  if(B) ins.push({ico:'🎭',bg:'#fee2e2',title:'Sentiment Control',desc:`The classifier marks ${fx(M(B.negative,'StyleAcc(clf)'))}% of negative and ${fx(M(B.positive,'StyleAcc(clf)'))}% of positive captions as on-style; VADER agrees on ${fx(M(B.negative,'StyleAcc(VADER)'))}% and ${fx(M(B.positive,'StyleAcc(VADER)'))}%. Negative sentiment is the harder side.`});
  if(B&&U) ins.push({ico:'🔓',bg:'#ede9fe',title:'Constrained vs Unconstrained',desc:`Dropping the selected-word constraint moves negative classifier accuracy from ${fx(M(B.negative,'StyleAcc(clf)'))}% to ${fx(M(U.negative,'StyleAcc(clf)'))}% and the own-lexicon hit rate to ${fx(M(U.negative,'LexHit(own)'))}%, while negative CIDEr goes ${fx(M(B.negative,'CIDEr'))} → ${fx(M(U.negative,'CIDEr'))}.`});
  if(B&&B.grounding) ins.push({ico:'🧭',bg:'#cffafe',title:'Grounded Word Choice',desc:`Selected words agree with the CLIP prior ${fx(M(B.grounding,'prior_agreement_pct'))}% of the time against ${fx(M(B.grounding,'chance_pct'))}% chance. Non-visual (“flat”) words put ${fx(M(B.grounding,'mean_null_mass_flat_words'),2)} of their mass on the NULL slot versus ${fx(M(B.grounding,'mean_null_mass_localisable_words'),2)} for localisable words.`});
  if(B&&B.copy_gate) ins.push({ico:'🔗',bg:'#dbeafe',title:'Copy Gate',desc:`The gate opens to ${fx(M(B.copy_gate,'mean_gate_at_selected_words'),2)} on selected style words and stays at ${fx(M(B.copy_gate,'mean_gate_elsewhere'),3)} elsewhere, so style words come from the copy path while the rest of the caption is generated normally.`});
  const mD=D.tests&&D.tests.best&&D.tests.best.dead;
  const dd=mD?[mD]:(D.T.dead||[]);
  if(dd.length){ const wd=mean(dd.map(x=>x.with_dead)),tot=mean(dd.map(x=>x.n_negative)),an=mean(dd.map(x=>x.dead_on_animate));
    ins.push({ico:'⚠️',bg:'#fee2e2',title:'Failure Mode: “dead”',desc:`“dead” appears in ${fx(wd,0)} of ${fx(tot,0)} negative captions (${fx(wd/tot*100)}%), ${fx(an,0)} of them on people or animals. A noun-compatibility mask at decode time or a per-word overuse penalty are the natural fixes.`}); }
  const A=D.ablations;
  if(A&&A.summary&&A.summary.full&&A.summary.full['mean CIDEr']){
    const f=A.summary.full['mean CIDEr'].mean;
    const r=PAPER_VARIANTS.filter(v=>v!=='full_unconstrained'&&A.summary[v]&&A.summary[v]['mean CIDEr']).map(v=>({v,d:A.summary[v]['mean CIDEr'].mean-f,p:(A.p_vs_full[v]||{})['mean CIDEr']}));
    const worst=r.reduce((a,b)=>b.d<a.d?b:a), bestv=r.reduce((a,b)=>b.d>a.d?b:a);
    const ns=r.filter(x=>!(x.p<0.05)).map(x=>vlabel(x.v));
    ins.push({ico:'🧪',bg:'#d1fae5',title:'Ablation Headline',desc:`Largest loss: ${vlabel(worst.v)} (${fx(worst.d,1)} mean CIDEr${stars(worst.p)?', p'+(worst.p<0.001?'<0.001':'='+worst.p.toPrecision(2)):''}). Largest gain: ${vlabel(bestv.v)} (${bestv.d>=0?'+':''}${fx(bestv.d,1)}). No significant CIDEr effect: ${ns.length?ns.join(', '):'none'}.`});
  }
  const cs=D.T.detail&&D.T.detail.results;
  if(cs) ins.push({ico:'🔤',bg:'#fce7f3',title:'Caption Diversity',desc:`Distinct-2 is ${fx(cs.negative['Distinct-2'])}% (neg) / ${fx(cs.positive['Distinct-2'])}% (pos) with ${fx(cs.negative['Unique captions %'])}% / ${fx(cs.positive['Unique captions %'])}% unique captions; average length ${fx(cs.negative.AvgLen,1)} / ${fx(cs.positive.AvgLen,1)} words.`});
  const t=D.timing||{};
  if(t.stylised_seeds||t.stylised) ins.push({ico:'⚡',bg:'#d1fae5',title:'Training Cost',desc:`Stage 2 needs ${t.stylised_seeds?`${fx(t.stylised_seeds.mean_min,1)} min (mean of ${t.stylised_seeds.n} seeds)`:`${fx(t.stylised.total_min,2)} min`} for ${t.stylised?t.stylised.epochs:25} epochs, on top of ${t.pretrain?fx(t.pretrain.total_min,1)+' min':'–'} of factual pre-training at batch size ${D.batch_size}.`});

  const drawIns=()=>{ document.getElementById('insightGrid').innerHTML=ins.map(x=>`
    <div class="insight"><div class="ins-ico" style="background:${x.bg}">${x.ico}</div><div class="ins-title">${x.title}</div><div class="ins-desc">${x.desc}</div></div>`).join(''); };
  drawIns();
  /* benchmark insight (needs data/benchmarks.json) */
  const forBatch=D.batch;
  getBench().then(bm=>{
    if(!bm||D.batch!==forBatch||!B) return;
    const g=s=>{const best=bestPublished(bm,s,'C');return best?{d:M(B[s],'CIDEr')-best.v,best}:null;};
    const gn=g('negative'),gp=g('positive'); if(!gn||!gp) return;
    ins.unshift({ico:'🏆',bg:'#fef3c7',title:'Benchmark Comparison',desc:`On SentiCap, this batch reaches CIDEr ${fx(M(B.negative,'CIDEr'))} (negative) and ${fx(M(B.positive,'CIDEr'))} (positive): ${gn.d>=0?'+':''}${fx(gn.d)} over ${esc(gn.best.name)} (${fx(gn.best.v)}) and ${gp.d>=0?'+':''}${fx(gp.d)} over ${esc(gp.best.name)} (${fx(gp.best.v)}), the strongest published results.`});
    drawIns();
  }).catch(()=>{});

  const meta=(D.T.detail&&D.T.detail.results&&D.T.detail.results.meta)||{};
  const b1=D.v1.length?D.v1.reduce((b,v)=>v.cider>b.cider?v:b):null;
  document.getElementById('archTable').innerHTML=`
    <table class="data-table">
      <tr><td>Task</td><td class="best">Stylised (sentiment) image captioning</td></tr>
      <tr><td>Dataset</td><td>SentiCap (negative / positive), COCO val2014 images</td></tr>
      <tr><td>Stage 1</td><td>Factual pre-training on COCO · ${D.tr1.length} epochs${b1?` · best val. CIDEr ${fx(b1.cider)} (epoch ${b1.epoch})`:''}</td></tr>
      <tr><td>Stage 2</td><td>Stylised fine-tuning · ${D.tr.length} epochs · tested checkpoint: <i>stylised_best</i> (epoch ${D.bestEpoch??'–'})</td></tr>
      <tr><td>Grounding</td><td>Region-wise alignment · weakly supervised presence (MIL) · CLIP prior with NULL slot</td></tr>
      <tr><td>Decoding</td><td>Copy gate for selected style words · beam ${meta.beam??'–'} · no-repeat n-gram ${meta.no_repeat_ngram??'–'} · selected word required: ${meta.require_selected_word===undefined?'–':meta.require_selected_word?'yes':'no'}</td></tr>
      <tr><td>Batch size</td><td class="best">${D.batch_size}</td></tr>
      <tr><td>Test checkpoint(s)</td><td class="best">${D.T.epochs?`epoch ${D.T.epochs.join(', ')}`:'–'} ${D.T.source==='seeds'?`(${D.T.n} seeds)`:D.T.source==='main'?'(main run)':''}</td></tr>
      <tr><td>Negative / Positive CIDEr</td><td class="best">${B?`${pm(M(B.negative,'CIDEr'),S(B.negative,'CIDEr'))} / ${pm(M(B.positive,'CIDEr'),S(B.positive,'CIDEr'))}`:'–'}</td></tr>
      <tr><td>Exported</td><td class="muted">${esc(D.exported||'')}</td></tr>
    </table>`;
}

/* ══════════════════════════════════════════════════════════════
   13b. PAPER FIGURE 3 (Captions page)
   Same images as the paper; captions from the main run of each batch
   (the run the paper's qualitative figure uses).
   ══════════════════════════════════════════════════════════════ */
const wordsOf = text => (text||'').toLowerCase().split(/[^a-z']+/).filter(Boolean);
const hasStyleWord = text => wordsOf(text).some(w=>D.lex[w]);
function deadOnAnimate(text){
  const t=wordsOf(text);
  return t.some((w,i)=>w==='dead'&&(ANIMATE.has(t[i+1])||ANIMATE.has(t[i+2])));
}
function figSource(b){
  if(b.tests&&b.tests.best&&b.tests.best.featured&&Object.keys(b.tests.best.featured).length)
    return {c:b.tests.best,u:b.tests.best_unconstrained,lbl:`main run · epoch ${b.tests.best.epoch}`};
  const s=(b.full_seeds||[])[0];
  if(s&&s.best&&s.best.featured) return {c:s.best,u:s.best_unconstrained,lbl:`seed ${s.seed} · epoch ${s.best.epoch}`};
  return null;
}
function figCard(img,src,all){
  const f=src.c.featured[img]||{}, n=f.negative||{}, p=f.positive||{};
  const braces=ws=>ws&&ws.length?`{${ws.map(w=>esc(w[0])).join(', ')}}`:'{}';
  const fail=deadOnAnimate(n.caption);
  const uRows=all?all.map(b=>{
      const fs=figSource(b), u=fs&&fs.u&&fs.u.featured&&fs.u.featured[img], c=u&&u.negative&&u.negative.caption;
      return `<div class="cap-line"><span class="cap-tag gt">B=${b.batch_size}</span><div class="cap-gt">${c?hl(c):'–'}${
        c&&!hasStyleWord(c)?' <span class="muted">(no style)</span>':''}${c&&deadOnAnimate(c)?' <span class="tag-fail">dead + person/animal</span>':''}</div></div>`;
    }).join(''):'<div class="cap-note">Loading the other batch sizes…</div>';
  const id=parseInt((img.match(/(\d+)\.jpg$/)||[0,0])[1],10);
  return `<div class="cap-item">${thumb(img)}
    <div class="cap-body">
      <div class="cap-file">COCO ${id} ${fail?'<span class="tag-fail">✗ failure</span>':'<span class="tag-ok">✓</span>'}</div>
      <div class="cap-line"><span class="cap-tag neg">neg</span><div><div class="cap-text">${hl(n.caption||'–')}</div><div class="cap-words">selector kept ${braces(n.words)}</div></div></div>
      <div class="cap-line"><span class="cap-tag pos">pos</span><div><div class="cap-text">${hl(p.caption||'–')}</div><div class="cap-words">selector kept ${braces(p.words)}</div></div></div>
      <div class="sub-label" style="margin:10px 0 5px">Negative, decoded without the constraint</div>${uRows}
    </div>
  </div>`;
}
async function renderFig3(){
  const grid=document.getElementById('figGrid'); if(!grid) return;
  const src=figSource(D), forBatch=D.batch;
  if(!src){ grid.innerHTML='<div class="muted">The paper-figure captions were not exported for this batch. Rerun export_results.py.</div>'; document.getElementById('figSrc').textContent='not available'; return; }
  document.getElementById('figSrc').textContent=`${D.batch} · ${src.lbl}`;
  const imgs=Object.keys(src.c.featured);
  grid.innerHTML=imgs.map(img=>figCard(img,src,null)).join('');
  const all=(await Promise.all(INDEX.map(b=>getBatch(b.name).catch(()=>null)))).filter(Boolean).sort((a,b)=>a.batch_size-b.batch_size);
  if(D.batch!==forBatch) return;
  grid.innerHTML=imgs.map(img=>figCard(img,src,all)).join('');
}

/* ══════════════════════════════════════════════════════════════
   13c. BENCHMARK COMPARISON PAGE  (data/benchmarks.json = paper Table III)
   ══════════════════════════════════════════════════════════════ */
let BENCH=null, BENCH_BATCH=null, BENCH_METRIC='C', BENCH_RUN=0;
async function getBench(){ if(!BENCH) BENCH=await fetchJSON(`${GH.data}/benchmarks.json`); return BENCH; }
function bestPublished(bm,style,key){
  let best=null;
  bm.methods.forEach(m=>{ const v=m[style]&&m[style][key]; if(isNum(v)&&(!best||v>best.v)) best={v,name:m.name,mark:m.mark||''}; });
  return best;
}
function sageVals(bm,b,cfg){
  const node=cfg==='unc'?b.T.unc:b.T.best; if(!node) return null;
  const o={};
  ['positive','negative'].forEach(s=>{ o[s]={}; bm.metrics.forEach(m=>{ o[s][m.key]={v:M(node[s],m.result),sd:S(node[s],m.result)}; }); });
  return o;
}
/* Prints short labels next to scatter points that carry a `pointLabels` array. */
const pointNames={
  id:'pointNames',
  afterDatasetsDraw(chart){
    const {ctx}=chart;
    chart.data.datasets.forEach((ds,di)=>{
      if(!ds.pointLabels) return; const meta=chart.getDatasetMeta(di); if(meta.hidden) return;
      ctx.save(); ctx.font="600 10.5px 'Outfit',sans-serif"; ctx.fillStyle=ds.labelColor||'#4b5580';
      meta.data.forEach((el,i)=>{ const t=ds.pointLabels[i]; if(!t) return; ctx.textAlign=ds.labelAlign||'left'; ctx.fillText(t, el.x+(ds.labelAlign==='right'?-8:8), el.y+(ds.labelDy||4)); });
      ctx.restore();
    });
  }
};

async function renderBench(){
  const run=++BENCH_RUN;
  const note=document.getElementById('benchNote');
  let bm;
  try{ bm=await getBench(); }
  catch(e){
    note.innerHTML='<b>data/benchmarks.json</b> was not found. Upload it to the <code>data</code> folder of the repository.';
    ['benchKpi','benchTable','benchMethods','benchNotes'].forEach(id=>document.getElementById(id).innerHTML=''); return;
  }
  const names=INDEX.map(b=>b.name);
  if(!BENCH_BATCH||!names.includes(BENCH_BATCH)) BENCH_BATCH=names.includes(bm.paper_batch)?bm.paper_batch:D.batch;
  buildTabs('benchBatchTabs',names.map(n=>[n,`B = ${n.replace(/\D/g,'')}${n===bm.paper_batch?' · paper':''}`]),k=>{BENCH_BATCH=k;renderBench();},BENCH_BATCH);
  const b=await getBatch(BENCH_BATCH);
  if(run!==BENCH_RUN) return;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const sage=sageVals(bm,b,'best'), unc=sageVals(bm,b,'unc');
  if(!sage){ note.innerHTML=`No test results exported for ${esc(b.batch)}.`; return; }
  const isPaper=BENCH_BATCH===bm.paper_batch;

  /* does the live SAGE row reproduce the paper's table? */
  let match='';
  if(isPaper&&bm.sage_paper){
    let ok=true;
    [['constrained',sage],['unconstrained',unc]].forEach(([cfg,live])=>{ if(!live||!bm.sage_paper[cfg]) return;
      ['positive','negative'].forEach(s=>bm.metrics.forEach(m=>{ const pv=bm.sage_paper[cfg][s][m.key], lv=live[s][m.key].v;
        if(isNum(pv)&&isNum(lv)&&Math.abs(Math.round(lv*10)/10-pv)>0.051) ok=false; })); });
    match=ok?' <span class="tag-ok">✓ identical to Table III of the paper</span>':' <span class="tag-fail">differs from Table III of the paper</span>';
  }
  note.innerHTML=`Published results on the <b>${esc(bm.dataset)}</b> (Table III of the paper) against SAGE at <b>batch size ${b.batch_size}</b>, full model, mean of ${b.T.n} seed${b.T.n>1?'s':''}${isPaper?'':' (the paper reports B = '+esc(String(bm.paper_batch).replace(/\D/g,''))+')'}.${match}`;

  /* KPIs: SAGE vs best published, per comparable metric and style */
  const kp=[];
  [['C','CIDEr'],['B3','BLEU-3'],['M','METEOR'],['B1','BLEU-1']].forEach(([k,l])=>['negative','positive'].forEach(s=>{
    const best=bestPublished(bm,s,k), v=sage[s][k].v; if(!best||!isNum(v)) return; const d=v-best.v;
    kp.push({ico:s==='negative'?'🌧️':'☀️',bg:s==='negative'?'#fee2e2':'#d1fae5',col:s==='negative'?C.red:C.green,
      lbl:`${s==='negative'?'Negative':'Positive'} ${l}`,val:fx(v),delta:`${d>=0?'▲ +':'▼ '}${fx(d)} vs ${best.name}${best.mark} (${fx(best.v)})`,dn:d<0});
  }));
  const kg=document.getElementById('benchKpi'); kg.innerHTML=kpiHTML(kp); countUp(kg);

  /* Table III */
  const cols=bm.metrics, S2=['positive','negative'];
  const pub=bm.methods.map(m=>({name:m.name,mark:m.mark||'',ref:m.ref,kind:'pub',vals:Object.fromEntries(S2.map(s=>[s,Object.fromEntries(cols.map(c=>[c.key,{v:m[s]?m[s][c.key]:null}]))]))}));
  const rows=[...pub,{name:'SAGE (ours)',kind:'sage',vals:sage},...(unc?[{name:'↳ unconstrained',kind:'unc',vals:unc}]:[])];
  const top={}; S2.forEach(s=>cols.forEach(c=>{ top[s+c.key]=Math.max(...rows.filter(r=>r.kind!=='unc').map(r=>r.vals[s][c.key].v).filter(isNum)); }));
  const cell=(r,s,c)=>{ const x=r.vals[s][c.key]; if(!isNum(x.v)) return '<td class="num muted">–</td>';
    const isTop=r.kind!=='unc'&&Math.abs(x.v-top[s+c.key])<1e-9;
    return `<td class="num${isTop?' best':''}">${fx(x.v)}${r.kind!=='pub'&&isNum(x.sd)&&x.sd>0?`<span class="sd">±${fx(x.sd)}</span>`:''}</td>`; };
  document.getElementById('benchTable').innerHTML=`<thead>
      <tr><th rowspan="2">Model</th>${S2.map(s=>`<th class="grp ${s==='negative'?'neg-c':'pos-c'}" colspan="${cols.length}">${s==='negative'?'Negative':'Positive'}</th>`).join('')}</tr>
      <tr>${S2.map(()=>cols.map(c=>`<th>${esc(c.label)}</th>`).join('')).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr class="${r.kind==='sage'?'hl':r.kind==='unc'?'sub-row':''}">
      <td>${r.kind==='pub'?`${esc(r.name)}${r.mark} <span class="muted">[${r.ref}]</span>`:`<b>${esc(r.name)}</b>`}</td>
      ${S2.map(s=>cols.map(c=>cell(r,s,c)).join('')).join('')}</tr>`).join('')}</tbody>`;
  document.getElementById('benchNotes').innerHTML=(bm.notes||[]).map(n=>`<li>${esc(n)}</li>`).join('')+
    '<li>Bold: best value in the column among published methods and SAGE (the unconstrained row is left out).</li>';

  /* metric-by-method bars */
  const chartRows=[...pub,{name:'SAGE ★',kind:'sage',vals:sage}];
  buildTabs('benchMetricTabs',cols.map(c=>[c.key,c.label]),k=>{BENCH_METRIC=k;drawBenchBar(bm,chartRows);setTimeout(()=>CHS['c-benchBar']&&CHS['c-benchBar'].resize(),30);},BENCH_METRIC);
  drawBenchBar(bm,chartRows);

  /* progress over time (CIDEr) */
  const pts=s=>[...bm.methods.map(m=>({x:m.year,y:m[s]?m[s].C:null,name:m.name+(m.mark||'')})),{x:2026,y:sage[s].C.v,name:'SAGE'}].filter(p=>isNum(p.y)).sort((a,b)=>a.x-b.x||b.y-a.y);
  const record=arr=>{ let best=-1; return arr.map(p=>{ if(p.y>best){ best=p.y; return p.name; } return ''; }); };
  const runMax=arr=>{ let best=-Infinity; return arr.map(p=>({x:p.x,y:(best=Math.max(best,p.y))})); };
  const pN=pts('negative'), pP=pts('positive');
  mkChart('c-benchYear','scatter',{datasets:[
    {label:'Negative',data:pN,backgroundColor:pN.map(p=>p.name==='SAGE'?NEG:rgba(NEG,.55)),pointRadius:pN.map(p=>p.name==='SAGE'?8:5),pointLabels:record(pN),labelColor:C.red,labelDy:-8},
    {label:'Positive',data:pP,backgroundColor:pP.map(p=>p.name==='SAGE'?POS:rgba(POS,.55)),pointRadius:pP.map(p=>p.name==='SAGE'?8:5),pointLabels:record(pP),labelColor:C.green,labelDy:14},
    {label:'Best so far (neg)',type:'line',data:runMax(pN),borderColor:rgba(NEG,.45),borderWidth:1.5,borderDash:[5,4],stepped:true,pointRadius:0,fill:false},
    {label:'Best so far (pos)',type:'line',data:runMax(pP),borderColor:rgba(POS,.45),borderWidth:1.5,borderDash:[5,4],stepped:true,pointRadius:0,fill:false}
  ]},{plugins:{legend:{...LEG,labels:{...LEG.labels,filter:i=>!i.text.startsWith('Best')}},tooltip:{filter:i=>!!i.raw.name,callbacks:{label:c=>`${c.raw.name} (${c.raw.x}): CIDEr ${fx(c.raw.y)}`}}},
     scales:{x:{type:'linear',min:2015,max:2027,title:{display:true,text:'Year'},ticks:{stepSize:1,callback:v=>String(v)},grid:{color:GC}},y:{title:{display:true,text:'CIDEr'},grid:{color:GC}}}},[pointNames]);

  /* margin over the best published value */
  const G=[['B1','BLEU-1'],['B3','BLEU-3'],['M','METEOR'],['C','CIDEr']];
  const gain=s=>G.map(([k])=>{ const best=bestPublished(bm,s,k), v=sage[s][k].v; return best&&isNum(v)?{d:v-best.v,best}:null; });
  const gN=gain('negative'), gP=gain('positive');
  mkChart('c-benchGain','bar',{labels:G.map(g=>g[1]),datasets:[
    {label:'Negative',data:gN.map(x=>x?x.d:null),backgroundColor:rgba(NEG,.78),borderRadius:6,borderSkipped:false},
    {label:'Positive',data:gP.map(x=>x?x.d:null),backgroundColor:rgba(POS,.72),borderRadius:6,borderSkipped:false}
  ]},{plugins:{legend:LEG,tooltip:{callbacks:{label:c=>{const x=(c.datasetIndex?gP:gN)[c.dataIndex];return x?`${c.dataset.label}: ${x.d>=0?'+':''}${fx(x.d,2)} vs ${x.best.name}${x.best.mark} (${fx(x.best.v)})`:'';}}}},
     scales:{x:{grid:{display:false}},y:{title:{display:true,text:'SAGE − best published'},grid:{color:GC}}}});

  /* method details */
  document.getElementById('benchMethods').innerHTML=`<thead><tr><th>Model</th><th>Ref.</th><th>Venue</th><th>Year</th><th>Supervision</th><th>Approach</th><th>CIDEr neg / pos</th></tr></thead><tbody>${
    bm.methods.map(m=>`<tr><td><b>${esc(m.name)}</b>${m.mark||''}</td><td>[${m.ref}]</td><td>${esc(m.venue)}</td><td>${m.year}</td><td><span class="type-tag">${esc(m.type)}</span></td><td>${esc(m.approach||'')}</td><td class="num">${fx(m.negative&&m.negative.C)} / ${fx(m.positive&&m.positive.C)}</td></tr>`).join('')}
    <tr class="hl"><td><b>SAGE (ours)</b></td><td>–</td><td>This work</td><td>2026</td><td><span class="type-tag">Paired + grounding</span></td><td>CLIP region-wise style grounding with MIL presence, copy gate and constrained decoding</td><td class="num"><b>${fx(sage.negative.C.v)} / ${fx(sage.positive.C.v)}</b></td></tr></tbody>`;
  /* charts built while the page was still animating in: size them again once it is visible */
  [60,350].forEach(ms=>setTimeout(()=>['c-benchBar','c-benchYear','c-benchGain'].forEach(id=>CHS[id]&&CHS[id].resize()),ms));
}
function drawBenchBar(bm,rows){
  const k=BENCH_METRIC, lab=(bm.metrics.find(m=>m.key===k)||{}).label||k;
  const R=rows.filter(r=>isNum(r.vals.negative[k].v)||isNum(r.vals.positive[k].v))
    .sort((a,b)=>(mean([b.vals.negative[k].v,b.vals.positive[k].v])||0)-(mean([a.vals.negative[k].v,a.vals.positive[k].v])||0));
  const op=(r,a,b)=>r.kind==='sage'?a:b;
  mkChartNoAR('c-benchBar','bar',{labels:R.map(r=>r.name+(r.mark||'')),datasets:[
    {label:'Negative',data:R.map(r=>r.vals.negative[k].v),errors:R.map(r=>r.vals.negative[k].sd||0),backgroundColor:R.map(r=>rgba(NEG,op(r,.95,.45))),borderRadius:4,borderSkipped:false},
    {label:'Positive',data:R.map(r=>r.vals.positive[k].v),errors:R.map(r=>r.vals.positive[k].sd||0),backgroundColor:R.map(r=>rgba(POS,op(r,.95,.42))),borderRadius:4,borderSkipped:false}
  ]},{indexAxis:'y',plugins:{legend:LEG,tooltip:{mode:'index',intersect:false,callbacks:{label:c=>c.parsed.x==null?`${c.dataset.label}: not reported`:`${c.dataset.label}: ${fx(c.parsed.x)}`}}},
     scales:{x:{title:{display:true,text:lab+(k==='Acc'?' (each paper’s own classifier)':'')},grid:{color:GC},min:k==='Acc'?50:0},y:{grid:{display:false},ticks:{autoSkip:false,font:{size:11}}}}},[errorBars]);
}
window.renderBench=renderBench;

/* ══════════════════════════════════════════════════════════════
   14.  RENDER ALL
   ══════════════════════════════════════════════════════════════ */
function renderAll(){
  const steps=[renderKPI,renderDashboard,renderTraining,renderEvaluation,renderStyle,renderCaptions,renderAblations,renderInsights];
  steps.forEach(f=>{ try{ f(); }catch(e){ console.error(f.name,e); } });
  if(document.getElementById('page-compare').classList.contains('active')) renderCompare();
  if(document.getElementById('page-bench').classList.contains('active')) renderBench();
}

/* ══════════════════════════════════════════════════════════════
   15.  INIT
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded',()=>{ initTabs(); scanBatches(); });
