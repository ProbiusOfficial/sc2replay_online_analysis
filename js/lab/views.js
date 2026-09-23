/* ============================================================================
   录像数据分析台 · 视图层
   ⚠️ 本文件由 scripts/extract-lab-views.mjs 从 prototype/data-lab.template.html
      的内联 <script> **逐字节提取**，只做了 5 处有断言保护的定点替换（见该脚本头部）。
      它是一份自洽的模块：不 import 任何东西，所有渲染/交互/语音/悬浮探测都在这一层。

   为什么是一个文件：这段代码已经过 3 轮真实 Chromium 渲染验收，提取能保证零偏差。
   **后续重构方向**（尚未做）：按 section 注释拆成 core / metrics / charts / timeline /
   readouts / table / buildorder / voice / overlay 若干模块。拆分时请保留本文件的验收脚本，
   拆完必须重跑一遍 `node prototype/shot-datalab.mjs` 与生产页验收。

   状态与数据：
     `DATA.replays` 由 `mountLab()` 在运行期注入（原型里是构建期 JSON 注入）；
     `S` 是视图状态（游标 S.t、模式、视图、筛选），`V` 是语音播报状态。
   ============================================================================ */

let DATA = { generated: '', replays: [] };

/* ==========================================================================
   指标注册表 —— 分组名与指标名照搬官方回放 overlay 的口径
   ========================================================================== */
const P = (id, g, label, en, pick, opts = {}) => ({ id, g, label, en, pick, ...opts });
const DERIVED = new Set(['spendTotal','gasSpend','armyValue','lostTotal','killTotal']);
const M = [
  P('mCur','资源','矿存量','Minerals Current',(p,i)=>p.series.mCur[i]),
  P('vCur','资源','气存量','Vespene Current',(p,i)=>p.series.vCur[i]),
  P('supUsed','资源','人口占用','Supply Used',(p,i)=>p.series.supUsed[i]),
  P('supMade','资源','人口上限','Supply Made',(p,i)=>p.series.supMade[i]),
  P('workers','资源','工人数','Workers Active',(p,i)=>p.series.workers[i]),

  P('mRate','收入','矿采集率','Minerals Collection Rate',(p,i)=>p.series.mRate[i]),
  P('vRate','收入','气采集率','Vespene Collection Rate',(p,i)=>p.series.vRate[i]),

  P('mUsedEco','支出','经济 · 当前','Minerals Used Current Economy',(p,i)=>p.series.mUsedEco[i]),
  P('mUsedTech','支出','科技 · 当前','Minerals Used Current Technology',(p,i)=>p.series.mUsedTech[i]),
  P('mUsedArmy','支出','军队 · 当前','Minerals Used Current Army',(p,i)=>p.series.mUsedArmy[i]),
  P('mProgEco','支出','经济 · 建造中','Minerals Used In Progress Economy',(p,i)=>p.series.mProgEco[i]),
  P('mProgTech','支出','科技 · 建造中','Minerals Used In Progress Technology',(p,i)=>p.series.mProgTech[i]),
  P('mProgArmy','支出','军队 · 建造中','Minerals Used In Progress Army',(p,i)=>p.series.mProgArmy[i]),
  P('spendTotal','支出','支出合计','Economy + Tech + Army',
    (p,i)=>p.series.mUsedEco[i]+p.series.mUsedTech[i]+p.series.mUsedArmy[i]),
  P('gasSpend','支出','气体支出','Vespene Used',
    (p,i)=>p.series.vUsedEco[i]+p.series.vUsedTech[i]+p.series.vUsedArmy[i]),

  P('armyValue','军事','军队价值','Army Value',
    (p,i)=>p.series.mUsedArmy[i]+p.series.vUsedArmy[i], { main:1 }),
  P('mActive','军事','活跃部队','Minerals Used Active Forces',(p,i)=>p.series.mActive[i]),

  P('lostArmy','战损','军队损失','Minerals Lost Army',(p,i)=>p.series.mLostArmy[i]),
  P('lostEco','战损','经济损失','Minerals Lost Economy',(p,i)=>p.series.mLostEco[i]),
  P('lostTech','战损','科技损失','Minerals Lost Technology',(p,i)=>p.series.mLostTech[i]),
  P('lostTotal','战损','总损失','All Lost',
    (p,i)=>p.series.mLostEco[i]+p.series.mLostTech[i]+p.series.mLostArmy[i]),
  P('killArmy','战果','击杀军队','Minerals Killed Army',(p,i)=>p.series.mKillArmy[i]),
  P('killEco','战果','击杀经济','Minerals Killed Economy',(p,i)=>p.series.mKillEco[i]),
  P('killTech','战果','击杀科技','Minerals Killed Technology',(p,i)=>p.series.mKillTech[i]),
  P('killTotal','战果','总战果','All Killed',
    (p,i)=>p.series.mKillEco[i]+p.series.mKillTech[i]+p.series.mKillArmy[i]),

  P('ffEco','自伤','经济自伤','Minerals Friendly Fire Economy',(p,i)=>p.series.mFfEco[i]),
  P('ffTech','自伤','科技自伤','Minerals Friendly Fire Technology',(p,i)=>p.series.mFfTech[i]),
  P('ffArmy','自伤','军队自伤','Minerals Friendly Fire Army',(p,i)=>p.series.mFfArmy[i]),
];
const BY_ID = Object.fromEntries(M.map(m => [m.id, m]));
const GROUPS = [...new Set(M.map(m => m.g))];
const DEFAULT_ON = ['mCur','workers','mRate','armyValue','mUsedTech','lostTotal'];
const TABLE_METRICS = ['armyValue','mCur','workers','mRate','spendTotal','lostTotal','killTotal','supUsed'];

const S = {
  ri: 0, t: 0, mode: 'overlay',
  on: new Set(DEFAULT_ON),
  tblMetric: 'armyValue',
  openGroups: new Set(GROUPS),
};

/* ---------- 工具 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mmss = s => `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(Math.round(s % 60)).padStart(2,'0')}`;
function fmt(v){
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 10) return v.toFixed(0);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/\.?0+$/, '') || '0';
}
function niceMax(v){
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= e * k) return e * k;
  return e * 10;
}
const rep = () => DATA.replays[S.ri];
const P1 = () => rep().players[0];
const P2 = () => rep().players[1];
const COL = { a:'#d94f45', b:'#2f80d6', diff:'#7a6cf0' };
const nPts = () => Math.min(P1().t.length, P2().t.length);

/** 二分：t 秒对应的最近采样索引。 */
function idxAt(pl, t){
  const arr = pl.t; let lo = 0, hi = arr.length - 1;
  if (t <= arr[0]) return 0;
  if (t >= arr[hi]) return hi;
  while (hi - lo > 1){ const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; }
  return (t - arr[lo] < arr[hi] - t) ? lo : hi;
}

/* ==========================================================================
   样本切换 / 对局头
   ========================================================================== */
function renderSamples(){
  const host = $('#samples'); host.innerHTML = '';
  DATA.replays.forEach((r, i) => {
    const b = el('button', 'smp' + (i === S.ri ? ' on' : ''));
    b.innerHTML = `<b>${esc(r.map)}</b>`
      + `<span>${esc(r.file.replace(/\.SC2Replay$/, ''))}</span>`
      + `<span>${mmss(r.duration)} · build ${r.build} · ${r.players.map(p => p.race).join(' v ')} · ${r.sampleCount} 采样</span>`;
    b.onclick = () => { S.ri = i; S.t = 0; renderAll(); };
    host.appendChild(b);
  });
}

function renderHead(){
  const r = rep(), [a, b] = r.players;
  const dt = r.playedAt ? new Date(r.playedAt * 1000).toISOString().slice(0, 10) : '—';
  const pcard = (p, side) => `
    <div class="pl ${side}">
      <div class="rc">${esc(p.race)}</div>
      <div class="nm">
        <b>${p.clan ? `<span style="color:var(--ink3);font-weight:400">${esc(p.clan)}</span> ` : ''}${esc(p.name)}${p.pid === r.winnerPid ? '<span class="win">WIN</span>' : ''}</b>
        <span>${esc(p.raceFull)} · ${p.t.length} 个采样点</span>
      </div>
    </div>`;
  $('#head').innerHTML = `
    <div class="hmeta">
      <h1>${esc(r.map)}</h1>
      <div class="sub">
        <span>时长 <b>${mmss(r.duration)}</b></span><span>·</span>
        <span>版本 <b>${r.build}</b></span><span>·</span>
        <span>区服 <b>${esc(r.region || '—')}</b></span><span>·</span>
        <span>日期 <b>${dt}</b></span><span>·</span>
        <span>采样间隔 <b>${r.sampleIntervalSec}s</b></span>
      </div>
    </div>
    <div class="vs">${pcard(a,'pa')}<span class="vslab">VS</span>${pcard(b,'pb')}</div>`;
}

/* ==========================================================================
   时间轴：军队价值差包络 + 事件标记 + 游标
   ========================================================================== */
let TL_EVENTS = [];
function computeEvents(){
  const [a, b] = rep().players, n = nPts();
  const A = i => a.series.mUsedArmy[i] + a.series.vUsedArmy[i];
  const B = i => b.series.mUsedArmy[i] + b.series.vUsedArmy[i];
  let mx = 1; for (let i = 0; i < n; i++) mx = Math.max(mx, A(i), B(i));
  const raw = [];
  for (let i = 1; i < n; i++){
    const d1 = A(i - 1) - A(i), d2 = B(i - 1) - B(i);
    if (Math.max(d1, d2) > mx * 0.05) raw.push({ t: a.t[i], kind:'battle', who: d1 >= d2 ? 'a' : 'b', mag: Math.max(d1, d2) });
    const w1 = a.series.workers[i - 1] - a.series.workers[i];
    const w2 = b.series.workers[i - 1] - b.series.workers[i];
    if (Math.max(w1, w2) >= 3) raw.push({ t: a.t[i], kind:'harass', who: w1 >= w2 ? 'a' : 'b', mag: Math.max(w1, w2) });
  }
  const out = [];
  for (const e of raw.sort((x, y) => x.t - y.t)){
    const last = out[out.length - 1];
    if (last && last.kind === e.kind && e.t - last.t < 20){ last.mag = Math.max(last.mag, e.mag); continue; }
    out.push({ ...e });
  }
  return out;
}

function renderTimeline(){
  const r = rep(), [a, b] = r.players, D = r.duration, n = nPts();
  const host = $('#tl');
  const W = Math.max(420, host.clientWidth - 28);
  const H = 96, padT = 8, padB = 16, bandH = H - padT - padB;
  const mid = padT + bandH / 2;

  const A = i => a.series.mUsedArmy[i] + a.series.vUsedArmy[i];
  const B = i => b.series.mUsedArmy[i] + b.series.vUsedArmy[i];
  let mx = 1; for (let i = 0; i < n; i++) mx = Math.max(mx, A(i), B(i));
  const sc = (bandH / 2) / mx;
  const X = t => (t / D) * W;
  const cy = v => clamp(mid - v * sc, padT, padT + bandH);

  const pA = [], pB = [];
  for (let i = 0; i < n; i++){
    const d = A(i) - B(i);
    pA.push([X(a.t[i]), cy(d)]);
    pB.push([X(a.t[i]), cy(-d)]);
  }
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = (pts, col, op) => {
    const d = path(pts);
    return `<path d="${d} L${pts[pts.length - 1][0].toFixed(1)},${mid} L${pts[0][0].toFixed(1)},${mid} Z" fill="${col}" opacity="${op}"/>`;
  };

  const ticks = [];
  const step = D > 1800 ? 300 : D > 900 ? 120 : D > 300 ? 60 : 30;
  for (let t = 0; t <= D; t += step){
    ticks.push(`<line x1="${X(t).toFixed(1)}" y1="${padT}" x2="${X(t).toFixed(1)}" y2="${padT + bandH}" stroke="#e6eaf1"/>`);
    ticks.push(`<text x="${X(t).toFixed(1)}" y="${H - 3}" fill="#8792a5" font-size="10" font-family="monospace" text-anchor="middle">${mmss(t)}</text>`);
  }
  const svg = $('#tlsvg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.height = H + 'px';
  svg.innerHTML =
    `<rect x="0" y="${padT}" width="${W}" height="${bandH}" fill="#fafbfd" stroke="#edf0f6"/>`
    + area(pA, COL.a, 0.15) + area(pB, COL.b, 0.15)
    + ticks.join('')
    + `<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#d7dde8"/>`
    + `<path d="${path(pA)}" fill="none" stroke="${COL.a}" stroke-width="1.7" stroke-linejoin="round"/>`
    + `<path d="${path(pB)}" fill="none" stroke="${COL.b}" stroke-width="1.7" stroke-linejoin="round" stroke-dasharray="4 2.5"/>`;
  host._W = W;

  const lay = $('#evlay'); lay.innerHTML = '';
  const merged = [];
  for (const e of TL_EVENTS){
    const last = merged[merged.length - 1];
    if (last && last.kind === e.kind && Math.abs(e.t - last.t) < D * 0.012){ continue; }
    merged.push(e);
  }
  merged.forEach(e => {
    const d = el('div', 'ev' + (e.kind === 'battle' ? ' battle' : ''));
    d.style.left = (e.t / D * 100) + '%';
    d.title = `${e.kind === 'battle' ? '交战' : '工人损失'} @ ${mmss(e.t)} · ${e.who === 'a' ? a.name : b.name}`;
    lay.appendChild(d);
  });

  $('#tllegend').innerHTML = [
    `<span><i style="background:${COL.a}"></i>${esc(a.name)} 军队价值领先</span>`,
    `<span><i style="background:${COL.b}"></i>${esc(b.name)} 军队价值领先</span>`,
    `<span><i style="background:var(--warn);width:2px;height:10px;border-radius:1px"></i>工人数单步损失 ≥ 3</span>`,
    `<span><i style="background:${COL.a};width:2px;height:10px;border-radius:1px;opacity:.6"></i>交战标记 · 军队价值单步跌幅超峰值 5%</span>`,
    `<span style="color:var(--ink4)">中线上下两部分为双方军队价值差的镜像</span>`,
  ].join('');
}

/* ==========================================================================
   游标读数
   ========================================================================== */
const READOUT_KEYS = ['mCur','mRate','workers','supUsed','armyValue','spendTotal','lostTotal','killTotal'];
function renderReadouts(){
  const [a, b] = rep().players;
  const ia = idxAt(a, S.t), ib = idxAt(b, S.t);
  const host = $('#readouts'); host.innerHTML = '';
  READOUT_KEYS.forEach(k => {
    const m = BY_ID[k], va = m.pick(a, ia), vb = m.pick(b, ib), d = va - vb;
    const node = el('div', 'ro');
    node.innerHTML = `
      <div class="t">${esc(m.label)}</div>
      <div class="row"><span class="k"><i style="background:${COL.a}"></i>${esc(a.name)}</span><span class="v">${fmt(va)}</span></div>
      <div class="row"><span class="k"><i style="background:${COL.b}"></i>${esc(b.name)}</span><span class="v">${fmt(vb)}</span></div>
      <div class="d">差值 <b class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : ''}${fmt(d)}</b>
        <span style="color:var(--ink4)">${d === 0 ? '持平' : (d > 0 ? esc(a.name) + '领先' : esc(b.name) + '领先')}</span></div>`;
    host.appendChild(node);
  });
}

/* ==========================================================================
   侧栏指标选择
   ========================================================================== */
function renderSide(){
  const host = $('#side'); host.innerHTML = '';
  host.appendChild(el('h3', null, '指标'));
  GROUPS.forEach(g => {
    const items = M.filter(m => m.g === g);
    const on = items.filter(m => S.on.has(m.id)).length;
    const box = el('div', 'grp');
    const head = el('div', 'gh', `<b>${esc(g)}</b><em>${on}/${items.length}</em>`);
    head.onclick = () => { S.openGroups.has(g) ? S.openGroups.delete(g) : S.openGroups.add(g); renderSide(); };
    box.appendChild(head);
    if (S.openGroups.has(g)) items.forEach(m => {
      const ck = el('label', 'ck' + (S.on.has(m.id) ? ' on' : ''));
      ck.innerHTML = `<input type="checkbox" ${S.on.has(m.id) ? 'checked' : ''}>`
        + `<span>${esc(m.label)}</span><em>${DERIVED.has(m.id) ? '派生' : '原始'}</em>`;
      ck.querySelector('input').onchange = () => {
        S.on.has(m.id) ? S.on.delete(m.id) : S.on.add(m.id);
        renderSide(); renderCharts(); renderTable();
      };
      box.appendChild(ck);
    });
    host.appendChild(box);
  });
  const foot = el('div', 'sidefoot');
  foot.innerHTML = `<button class="mini" data-p="core">核心 6 项</button>
    <button class="mini" data-p="econ">仅经济</button>
    <button class="mini" data-p="army">仅军事</button>
    <button class="mini" data-p="all">全选</button>
    <button class="mini" data-p="none">清空</button>`;
  foot.onclick = e => {
    const p = e.target.dataset.p; if (!p) return;
    if (p === 'core') S.on = new Set(DEFAULT_ON);
    if (p === 'econ') S.on = new Set(['mCur','vCur','mRate','vRate','workers','supUsed','mProgEco','mUsedEco']);
    if (p === 'army') S.on = new Set(['armyValue','mUsedArmy','mProgArmy','mActive','lostArmy','killArmy']);
    if (p === 'all') S.on = new Set(M.map(m => m.id));
    if (p === 'none') S.on = new Set();
    renderSide(); renderCharts(); renderTable();
  };
  host.appendChild(foot);
}

/* ==========================================================================
   图表
   ========================================================================== */
function renderCharts(){
  const host = $('#charts'); host.innerHTML = '';
  const list = M.filter(m => S.on.has(m.id));
  if (!list.length){ host.innerHTML = '<div class="card"><div class="empty">勾选左侧指标以显示图表</div></div>'; return; }
  const cards = list.map(m => {
    const card = el('div', 'card');
    card.innerHTML = `<header>
        <div class="tt"><b>${esc(m.label)}</b><span>${esc(m.en)}</span></div>
        <div class="sp"></div>
        <div class="curread"></div>
      </header>
      <div class="plot">
        <svg></svg>
        <div class="cl" data-cl></div>
        <div class="dot" data-dot="a" style="background:${COL.a};display:none"></div>
        <div class="dot" data-dot="b" style="background:${COL.b};display:none"></div>
      </div>`;
    card._m = m;
    host.appendChild(card);
    return card;
  });
  cards.forEach(drawChart);
  syncCursor();
}

function drawChart(card){
  const m = card._m, r = rep(), [a, b] = r.players, D = r.duration, n = nPts();
  const plot = card.querySelector('.plot'), svg = card.querySelector('svg');
  const W = Math.max(320, plot.clientWidth - 24);
  const H = m.main ? 200 : 160;
  const pad = { l: 54, r: 14, t: 12, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  let hi = 0, lo = 0;
  for (let i = 0; i < n; i++){ const va = m.pick(a, i), vb = m.pick(b, i); hi = Math.max(hi, va, vb); lo = Math.min(lo, va, vb); }
  if (S.mode === 'diff'){
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(m.pick(a, i) - m.pick(b, i)));
    hi = niceMax(mx); lo = 0;
  } else {
    hi = niceMax(hi); lo = lo < 0 ? -niceMax(-lo) : 0;
  }
  const X = t => pad.l + (t / D) * iw;
  const Y = v => pad.t + ih - ((v - lo) / ((hi - lo) || 1)) * ih;
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');

  let g = '';
  for (let i = 0; i <= 4; i++){
    const v = lo + (hi - lo) * i / 4, y = Y(v);
    g += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#edf0f6"/>`;
    g += `<text x="${pad.l - 8}" y="${(y + 3.5).toFixed(1)}" fill="#8792a5" font-size="10" font-family="monospace" text-anchor="end">${fmt(v)}</text>`;
  }
  const step = D > 1800 ? 300 : D > 900 ? 120 : D > 300 ? 60 : 30;
  // t=0 的刻度会与 y 轴底部的 0 标签打架，故从第二个刻度起画，超出右边界即止
  for (let t = step; t <= D; t += step){
    if (X(t) > W - pad.r - 16) break;
    g += `<text x="${X(t).toFixed(1)}" y="${H - 4}" fill="#aab3c2" font-size="9.5" font-family="monospace" text-anchor="middle">${mmss(t)}</text>`;
  }

  const base = Y(Math.max(0, lo));
  if (S.mode === 'overlay' || S.mode === 'a'){
    const sa = []; for (let i = 0; i < n; i++) sa.push([a.t[i], m.pick(a, i)]);
    const d = path(sa);
    g += `<path d="${d} L${X(sa[n - 1][0]).toFixed(1)},${base.toFixed(1)} L${X(sa[0][0]).toFixed(1)},${base.toFixed(1)} Z" fill="${COL.a}" opacity=".07"/>`;
    g += `<path d="${d}" fill="none" stroke="${COL.a}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }
  if (S.mode === 'overlay' || S.mode === 'b'){
    const sb = []; for (let i = 0; i < n; i++) sb.push([b.t[i], m.pick(b, i)]);
    g += `<path d="${path(sb)}" fill="none" stroke="${COL.b}" stroke-width="1.8" stroke-linejoin="round" stroke-dasharray="5 3"/>`;
  }
  if (S.mode === 'diff'){
    const sd = []; for (let i = 0; i < n; i++) sd.push([a.t[i], Math.abs(m.pick(a, i) - m.pick(b, i))]);
    const d = path(sd);
    g += `<path d="${d} L${X(sd[n - 1][0]).toFixed(1)},${Y(0).toFixed(1)} L${X(sd[0][0]).toFixed(1)},${Y(0).toFixed(1)} Z" fill="${COL.diff}" opacity=".12"/>`;
    g += `<path d="${d}" fill="none" stroke="${COL.diff}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.height = H + 'px';
  svg.innerHTML = g;
  card._geo = { W, H, pad, iw, ih, lo, hi, X, Y };

  // 交互：点击 / 拖动才移动游标 —— 与顶部时间轴同一约定。
  // ⚠️ 这里曾长期是「悬停即扫描」（pointermove 无条件 seek），当时的注释还写着「不要顺手统一」。
  // 实测那是误触源：鼠标从图表上划过就把游标带跑，而且同一屏里时间轴点一下才动、图表飘一下就动，
  // 两种手感互相打架。现已统一为拖动制，悬停**不得**改 S.t。
  if (!plot._bound){
    plot._bound = true;
    let down = false;
    const seek = e => {
      const rect = plot.getBoundingClientRect();
      const padL = card._geo.pad.l, padR = card._geo.pad.r;
      const usable = rect.width - 24;
      const x = clamp(e.clientX - rect.left - 12, 0, usable);
      S.t = clamp((x - padL) / (usable - padL - padR) * rep().duration, 0, rep().duration);
      scheduleSync();
    };
    plot.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      down = true;
      try { plot.setPointerCapture(e.pointerId); } catch (_) {}
      seek(e);
    });
    plot.addEventListener('pointermove', e => { if (down) seek(e); });
    plot.addEventListener('pointerup', () => { down = false; });
    plot.addEventListener('pointercancel', () => { down = false; });
    plot.addEventListener('pointerleave', () => { down = false; });
  }
}

/* ==========================================================================
   游标同步（时间轴 + 全部图表 + 读数 + 表格）
   ========================================================================== */
let syncQueued = false;
function scheduleSync(){ if (syncQueued) return; syncQueued = true; requestAnimationFrame(() => { syncQueued = false; syncCursor(); }); }

function syncCursor(){
  const r = rep(), [a, b] = r.players, D = r.duration;
  const pct = clamp(S.t / D, 0, 1);

  $('#tlcl').style.left = `calc(14px + (100% - 28px) * ${pct})`;
  $('#clock').innerHTML = `${mmss(S.t)} <em>/ ${mmss(D)}</em>`;

  const ia = idxAt(a, S.t), ib = idxAt(b, S.t);
  const cards = [...document.querySelectorAll('#charts .card')].filter(c => c._m);

  cards.forEach(card => {
    const m = card._m, geo = card._geo; if (!geo) return;
    const plot = card.querySelector('.plot');
    const svg = plot.querySelector('svg');
    const rect = svg.getBoundingClientRect();
    const plotRect = plot.getBoundingClientRect();
    const k = rect.width / geo.W;                 // 1:1（viewBox 宽 = clientWidth），仍按比例兜底
    const offX = rect.left - plotRect.left;

    plot.querySelector('[data-cl]').style.left = (offX + geo.pad.l + pct * geo.iw * k) + 'px';

    const va = m.pick(a, ia), vb = m.pick(b, ib);
    const dA = card.querySelector('[data-dot="a"]'), dB = card.querySelector('[data-dot="b"]');
    // 差值模式画的是 |A−B|，单方取值点在该曲线上没有位置意义，故一律隐藏
    const showA = S.mode === 'overlay' || S.mode === 'a';
    const showB = S.mode === 'overlay' || S.mode === 'b';
    if (dA){
      dA.style.display = showA ? 'block' : 'none';
      if (showA){ dA.style.left = (offX + geo.pad.l + pct * geo.iw * k) + 'px';
                  dA.style.top = (6 + geo.Y(va) * k) + 'px'; }
    }
    if (dB){
      dB.style.display = showB ? 'block' : 'none';
      if (showB){ dB.style.left = (offX + geo.pad.l + pct * geo.iw * k) + 'px';
                  dB.style.top = (6 + geo.Y(vb) * k) + 'px'; }
    }

    const diff = va - vb;
    card.querySelector('.curread').innerHTML =
      (S.mode !== 'b' ? `<span class="v"><i style="background:${COL.a}"></i>${fmt(va)}</span>` : '')
      + (S.mode !== 'a' && S.mode !== 'diff' ? `<span class="v"><i style="background:${COL.b}"></i>${fmt(vb)}</span>` : '')
      + (S.mode === 'diff'
          ? `<span class="v" style="color:${COL.diff}">|Δ| ${fmt(Math.abs(diff))}</span>`
          : `<span class="v" style="color:var(--ink3)">Δ <b class="${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}" style="font-weight:700">${diff > 0 ? '+' : ''}${fmt(diff)}</b></span>`);
  });

  renderReadouts();
  highlightRow();
  syncBo();
  renderVoiceUi();
}

/* ==========================================================================
   数据表
   ========================================================================== */
function renderTableTabs(){
  const seg = $('#tblSeg'); seg.innerHTML = '';
  TABLE_METRICS.forEach(k => {
    const b = el('button', S.tblMetric === k ? 'on' : '', esc(BY_ID[k].label));
    b.onclick = () => { S.tblMetric = k; renderTableTabs(); renderTable(); };
    seg.appendChild(b);
  });
}
function renderTable(){
  const r = rep(), [a, b] = r.players, m = BY_ID[S.tblMetric], n = nPts();
  $('#tbl thead').innerHTML = `<tr>
    <th>时间</th>
    <th class="sep" style="color:var(--a)">${esc(a.name)}</th>
    <th style="color:var(--b)">${esc(b.name)}</th>
    <th class="sep">Δ A−B</th>
    <th class="sep" style="color:var(--a)">${esc(a.name)} · 工人</th>
    <th style="color:var(--b)">${esc(b.name)} · 工人</th></tr>`;
  const rows = [];
  for (let i = 0; i < n; i++){
    const va = m.pick(a, i), vb = m.pick(b, i), d = va - vb;
    rows.push(`<tr data-i="${i}"><td>${mmss(a.t[i])}</td>
      <td class="sep">${fmt(va)}</td><td>${fmt(vb)}</td>
      <td class="sep" style="font-weight:600" class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : ''}${fmt(d)}</td>
      <td class="sep">${fmt(a.series.workers[i])}</td><td>${fmt(b.series.workers[i])}</td></tr>`);
  }
  $('#tbl tbody').innerHTML = rows.join('');
  $('#tblInfo').textContent = `${m.label} · ${n} 个采样点 · 间隔 ${r.sampleIntervalSec}s`;
  if (document.body.classList.contains('chatview')) highlightChatRow();
  highlightRow();
}
function highlightRow(){
  const tb = $('#tbl tbody'); if (!tb.children.length) return;
  const i = idxAt(P1(), S.t);
  const cur = tb.querySelector('tr.on'); if (cur) cur.classList.remove('on');
  const row = tb.querySelector(`tr[data-i="${i}"]`);
  if (!row) return;
  row.classList.add('on');
  const wrap = $('.tblwrap');
  // 同 `.borow`：表格行的 offsetParent 也是 body，必须用矩形相对量换算。
  const rel = row.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
  const rh = row.getBoundingClientRect().height;
  if (rel < wrap.scrollTop + 28 || rel + rh > wrap.scrollTop + wrap.clientHeight - 28)
    wrap.scrollTop = Math.max(0, rel - wrap.clientHeight / 2);
}

/* ==========================================================================
   CSV 导出
   ========================================================================== */
function exportCsv(){
  const r = rep(), [a, b] = r.players, n = nPts();
  const q = s => /[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s;
  const cols = ['time_sec', 'time_mmss', ...M.flatMap(m => [`${a.name}__${m.id}`, `${b.name}__${m.id}`])];
  const lines = [cols.map(q).join(',')];
  for (let i = 0; i < n; i++){
    const row = [a.t[i].toFixed(1), mmss(a.t[i])];
    M.forEach(m => row.push(m.pick(a, i), m.pick(b, i)));
    lines.push(row.join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = r.file.replace(/\.SC2Replay$/, '') + '_stats.csv';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ==========================================================================
   交互绑定
   ========================================================================== */
$('#modeSeg').onclick = e => {
  const btn = e.target.closest('button'); if (!btn) return;
  S.mode = btn.dataset.mode;
  [...$('#modeSeg').children].forEach(c => c.classList.toggle('on', c === btn));
  renderCharts();
};
$('#btnCsv').onclick = exportCsv;

(function bindTimeline(){
  const tl = $('#tl');
  let drag = false;
  const seek = e => {
    const rect = tl.getBoundingClientRect();
    S.t = clamp((e.clientX - rect.left - 14) / (rect.width - 28), 0, 1) * rep().duration;
    scheduleSync();
  };
  // ⚠️ 时间轴是「点击 / 拖动」制：悬停只显示预览浮标、不得移动游标（防误触）。
  // 图表仍保持悬停扫描 —— 两者职责不同，不要「顺手统一」。
  const peek = document.createElement('div');
  peek.className = 'tl-peek';
  tl.appendChild(peek);
  const hoverPeek = e => {
    const rect = tl.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 14, rect.width - 14);
    peek.style.left = x + 'px';
    peek.dataset.t = mmss(clamp((x - 14) / (rect.width - 28), 0, 1) * rep().duration);
    peek.classList.add('on');
  };
  tl.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = true; try { tl.setPointerCapture(e.pointerId); } catch (_) {} tl.classList.add('scrubbing'); seek(e); });
  tl.addEventListener('pointermove', e => { if (drag) seek(e); else hoverPeek(e); });
  tl.addEventListener('pointerup', () => { drag = false; tl.classList.remove('scrubbing'); });
  tl.addEventListener('pointerleave', () => { drag = false; tl.classList.remove('scrubbing'); peek.classList.remove('on'); });
  window.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    S.t = clamp(S.t + (e.key === 'ArrowRight' ? 10 : -10), 0, rep().duration);
    syncCursor();
  });
})();

let rzTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => { renderTimeline(); renderCharts(); syncCursor(); }, 160);
});

/* ==========================================================================
   建造顺序视图
   ========================================================================== */
const BO_KINDS = [
  ['building', '建筑'], ['unit', '单位'], ['worker', '农民'],
  ['upgrade', '科技'], ['recall', '星空加速'], ['unknown', '未分类'],
];
const BO_GLYPH = { building: '建', unit: '兵', worker: '农', upgrade: '科', recall: '加', unknown: '·' };
const boVisible = new Set(BO_KINDS.map(k => k[0]));
let boShowEn = false;

const boList = pl => pl.buildOrder.filter(it => boVisible.has(it.kind));
const lastIdxAt = (arr, t) => { let i = -1; for (let k = 0; k < arr.length; k++) { if (arr[k].t <= t + 1e-6) i = k; else break; } return i; };

function renderBoFilter(){
  const host = $('#boFilter'); host.innerHTML = '';
  const [a, b] = rep().players;
  BO_KINDS.forEach(([k, label]) => {
    const n = a.buildOrder.filter(x => x.kind === k).length + b.buildOrder.filter(x => x.kind === k).length;
    if (!n) return;
    const btn = el('button', boVisible.has(k) ? 'on' : '', `${label} ${n}`);
    btn.onclick = () => { boVisible.has(k) ? boVisible.delete(k) : boVisible.add(k); renderBoFilter(); renderBo(); voiceRebuild(); };
    host.appendChild(btn);
  });
  const eb = el('button', boShowEn ? 'on' : '', '英文原名');
  eb.onclick = () => { boShowEn = !boShowEn; renderBoFilter(); renderBo(); voiceRebuild(); };
  host.appendChild(eb);
}

function renderBo(){
  const r = rep(), host = $('#bo');
  host.innerHTML = '';
  r.players.forEach((pl, si) => {
    const items = boList(pl);
    const sec = el('section', 'bocol ' + (si === 0 ? 'pa' : 'pb'));
    const counts = {};
    for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    const gaps = items.length > 1 ? (items.at(-1).t - items[0].t) / (items.length - 1) : 0;
    const head = document.createElement('header');
    head.innerHTML = `<span class="rc">${esc(pl.race)}</span>
      <div class="who"><b>${esc(pl.name)}</b><span>${esc(pl.raceFull)} · ${items.length} 项 · 工人阵亡 ${pl.workerDeaths.length}</span></div>
      <div class="sp"></div>
      <span style="font-size:10.5px;color:var(--ink4);font-family:var(--mono)">${
        BO_KINDS.filter(([k]) => counts[k]).map(([k, l]) => `${l} ${counts[k]}`).join(' · ')}</span>`;
    sec.appendChild(head);

    const list = el('div', 'bolist');
    if (!items.length) {
      list.innerHTML = '<div class="boempty">当前筛选下没有建造项</div>';
    } else {
      const perMin = new Map();
      items.forEach(it => { const m = Math.floor(it.t / 60); perMin.set(m, (perMin.get(m) || 0) + 1); });
      const buf = [];
      let curMin = -1;
      items.forEach((it, i) => {
        const m = Math.floor(it.t / 60);
        if (m !== curMin) {
          curMin = m;
          buf.push(`<div class="bog"><b>${m}:00</b><span class="ln"></span><span>${perMin.get(m)} 项</span></div>`);
        }
        const zh = it.zh || it.unit || '';
        const en = (it.unit && it.unit !== zh) ? `<span class="en">${esc(it.unit)}</span>` : '';
        buf.push(`<div class="borow k-${it.kind}" data-i="${i}" data-t="${it.t}">
          <span class="tm">${mmss(it.t)}</span>
          <span class="sp2">${it.supply == null ? '—' : it.supply}</span>
          <i class="gly">${it.icon ? `<img class="glyimg" src="assets/units/${it.icon}.webp" alt="">` : BO_GLYPH[it.kind]}</i>
          <span class="nm">${esc(boShowEn ? (it.unit || zh) : zh)}${boShowEn ? '' : en}</span>
        </div>`);
      });
      list.innerHTML = buf.join('');
    }
    sec.appendChild(list);
    sec.appendChild(el('div', 'bostat',
      items.length
        ? `首条 ${mmss(items[0].t)} · 末条 ${mmss(items.at(-1).t)} · 平均间隔 ${gaps.toFixed(1)}s · 阵亡工人 ${pl.workerDeaths.length} 个`
        : '—'));
    host.appendChild(sec);
  });

  host.querySelectorAll('.borow').forEach(row => {
    row.onclick = () => { S.t = parseFloat(row.dataset.t); vSeek(); scheduleSync(); };
  });
  syncBo();
}

function syncBo(){
  document.querySelectorAll('#bo .borow.now').forEach(r => r.classList.remove('now'));
  rep().players.forEach((pl, si) => {
    const items = boList(pl);
    const i = lastIdxAt(items, S.t);
    if (i < 0) return;
    const col = document.querySelectorAll('#bo .bocol')[si];
    const row = col?.querySelector(`.borow[data-i="${i}"]`);
    if (!row) return;
    row.classList.add('now');
    const list = col.querySelector('.bolist');
    // ⚠️ 不能用 offsetTop —— `.borow` 的 offsetParent 是 <body>（列表内没有定位祖先），
    // 拿到的是「距文档顶部」的绝对坐标，直接和 scrollTop 比会把列表一路滚到底。
    // 必须换算成「行在列表内容坐标系中的位置」。
    const rel = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const rh = row.getBoundingClientRect().height;
    if (rel < list.scrollTop + 34 || rel + rh > list.scrollTop + list.clientHeight - 34)
      list.scrollTop = Math.max(0, rel - list.clientHeight * 0.42);
  });
}

/* ==========================================================================
   对局聊天视图
   ========================================================================== */
function renderChat(){
  const host = $('#chatList'); if (!host) return;
  const r = rep(), [a, b] = r.players;
  const msgs = r.chat ?? [];
  if (!msgs.length){
    host.innerHTML = '<div class="chatempty">本局没有聊天消息</div>';
    return;
  }
  host.innerHTML = msgs.map(m => {
    const side = m.player === a.name ? 'a' : m.player === b.name ? 'b' : 'n';
    const col = side === 'n' ? 'var(--ink2)' : `var(--${side})`;
    return `<div class="chatrow" data-t="${m.t}" style="--pc:${col}">
      <span class="tm">${mmss(m.t)}</span>
      <span class="who">${esc(m.player)}${m.ally ? ' <em>队友</em>' : ''}</span>
      <span class="tx">${esc(m.text)}</span>
    </div>`;
  }).join('');
  host.querySelectorAll('.chatrow').forEach(row => {
    row.onclick = () => { S.t = clamp(+row.dataset.t, 0, rep().duration); syncCursor(); };
  });
  highlightChatRow();
}

/** 随游标点亮已送达的消息（滚动跟随用矩形相对量，别用 offsetTop）。 */
function highlightChatRow(){
  const box = $('#chatList'); if (!box) return;
  const rows = box.querySelectorAll('.chatrow');
  let last = -1;
  rows.forEach((row, i) => {
    const on = +row.dataset.t <= S.t + 1e-6;
    row.classList.toggle('past', on);
    if (on) last = i;
  });
  rows.forEach((r, i) => r.classList.toggle('now', i === last));
  const cur = rows[last];
  if (!cur) return;
  const rel = cur.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  if (rel < box.scrollTop + 32 || rel + cur.offsetHeight > box.scrollTop + box.clientHeight - 32)
    box.scrollTop = rel - box.clientHeight * 0.4;
}

/* ==========================================================================
   语音播报（Web Speech API）—— 读完即推进全局时间轴，不再是独立计时器
   ========================================================================== */
const synth = window.speechSynthesis;
const V = { playing: false, wall0: 0, base: 0, spoken: -1, rate: 2, lang: 'zh-CN', speed: 2, who: 0, steps: [] };

const voText = it => boShowEn ? (it.unit || it.zh) : (it.kind === 'recall' ? '星空加速' : (it.zh || it.unit));

function voiceRebuild(){
  // 重建脚本（切样本 / 切播报对象 / 改筛选）不应打断正在进行的播报——
  // 保持 playing 状态，并把时间基准重锚到当前游标，避免进度跳变。
  const wasPlaying = V.playing, at = S.t;
  V.steps = boList(rep().players[V.who]).map(it => ({ t: it.t, text: voText(it), unit: it.unit || '' }));
  vStop();
  renderVoiceUi();
  syncBo();
  if (wasPlaying && V.steps.length) {
    V.base = at; V.wall0 = Date.now(); V.playing = true;
    V.spoken = lastIdxAt(V.steps, at);       // 不补读过去的项
    vTick();
  }
  renderVoiceUi();
}

function speak(txt){
  if (!txt) return;
  try {
    const u = new SpeechSynthesisUtterance(txt);
    u.rate = V.rate; u.lang = V.lang;
    synth.speak(u);
  } catch (_) {}
}
function vStop(){ V.playing = false; V.spoken = -1; try { synth.cancel(); } catch (_) {} }
function vPlayPause(){
  if (V.playing) { V.base = S.t; vStop(); }
  else {
    vStop();
    if (S.t >= rep().duration - 0.05) S.t = 0;
    V.base = S.t; V.wall0 = Date.now(); V.playing = true;
    V.spoken = lastIdxAt(V.steps, S.t);          // 不追读已经过去的建造项
    vTick();
  }
  renderVoiceUi();
}
function vReset(){
  vStop(); V.base = 0; S.t = 0; V.spoken = -1;
  renderVoiceUi(); scheduleSync();
}
/** 用户拖动时间轴：静默重定位（读的时间基准跟着走，但不补读跳过的项） */
function vSeek(){
  V.base = S.t; V.wall0 = Date.now();
  if (V.playing) V.spoken = lastIdxAt(V.steps, S.t);
  renderVoiceUi();
}
function vTick(){
  if (!V.playing) return;
  S.t = V.base + (Date.now() - V.wall0) / 1000 * V.speed;
  const D = rep().duration;
  if (S.t >= D) { S.t = D; vStop(); }
  const i = lastIdxAt(V.steps, S.t);
  if (i > V.spoken) {
    for (let k = V.spoken + 1; k <= i; k++) speak(V.steps[k].text);
    V.spoken = i;
  }
  syncCursor();
  renderVoiceUi();
}
setInterval(vTick, 100);

function renderVoiceUi(){
  $('#vbClock').textContent = mmss(S.t);
  $('#vbClock').classList.toggle('on', V.playing);
  $('#vbPlay').textContent = V.playing ? '暂停' : (S.t > 0.5 ? '继续' : '开始');
  const i = V.steps.length ? lastIdxAt(V.steps, S.t) : -1;
  const rows = [];
  for (let k = Math.max(0, i - 2); k <= Math.min(V.steps.length - 1, i + 2); k++) {
    const cls = k === i ? 'cur' : 'dim';
    rows.push(`<div class="qs ${cls}"><span class="t">${mmss(V.steps[k].t)}</span><span>${esc(V.steps[k].text)}</span></div>`);
  }
  $('#vbQueue').innerHTML = rows.join('')
    || `<div class="qs dim"><span>无可播报项 —— 请到「建造顺序」页勾选类别，当前 ${V.steps.length} 项</span></div>`;
  $('#vbProg').style.width = (clamp(S.t / (rep().duration || 1), 0, 1) * 100).toFixed(2) + '%';
  renderPip();
}

/* ==========================================================================
   悬浮通道
   —— 正式形态：Windows 外置组件（置顶 + 分层透明 + 点击穿透 + 不抢焦点）。
   —— 本原型只做三件真事：① 真实探测本地组件；② 真实推送播报脚本；③ 未安装时降级到
     浏览器 Document 画中画（即现在线上的实现），并如实标注当前走的是哪条路。
   ========================================================================== */
const OV_PORT = 18760;
const OV_ORIGIN = 'http://127.0.0.1:' + OV_PORT;
let pipWin = null;

function ovSet(state, text){
  $('#ovDot').className = 'ovdot ' + state;
  $('#ovTxt').textContent = text;
}

/** 探测本地悬浮组件。Chrome 142+ 对「公网页面 → 环回地址」要求 LNA 授权， */
/** 因此必须显式声明 targetAddressSpace:'local'，否则请求会静默失败。            */
let ovMode = null, ovModeTried = false;
const OV_MODES = [null, 'loopback', 'local'];
async function ovFetch(path, opts = {}, timeoutMs = 1500){
  const modes = ovModeTried ? [ovMode] : OV_MODES;
  let lastErr = null;
  for (const m of modes) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const init = { ...opts, signal: ac.signal };
      if (m) init.targetAddressSpace = m;
      const res = await fetch(OV_ORIGIN + path, init);
      clearTimeout(timer);
      ovMode = m; ovModeTried = true;
      return res;
    } catch (err) { lastErr = err; clearTimeout(timer); }
  }
  throw lastErr || new Error('fetch failed');
}
async function ovProbe(timeoutMs = 1500){
  ovSet('wait', '正在探测本地悬浮组件…');
  try {
    const res = await ovFetch('/health');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const info = await res.json();
    ovSet('ok', `已连接本地悬浮组件 ${info.name || 'overlay-agent'} v${info.version || '?'}`);
    return true;
  } catch (err) {
    const denied = err?.name === 'NotAllowedError';
    ovSet('bad', denied
      ? '本地网络访问被拒绝 —— 请在地址栏权限提示里允许访问本地网络后重试'
      : '未检测到本地悬浮组件');
    return false;
  }
}

/** 把播报脚本推给本地组件（正式形态里这一步是唯一的跨进程数据入口）。 */
let ovIconMap = null;
async function ensureOvIcons(){
  if (ovIconMap) return ovIconMap;
  try {
    const r = await fetch('icons.json');
    if (r.ok) ovIconMap = await r.json();
  } catch (_) {}
  return ovIconMap || {};
}

/** SC2 官方对局速度系数（Liquipedia `Game_Speed` 的精确分数，Normal = 1 为基准）。 */
const SC2_SPEED_FACTOR = {
  slower: 2457 / 4096, slow: 3276 / 4096, normal: 1,
  fast: 4915 / 4096, faster: 5734 / 4096,
};

/**
 * 悬浮窗自走倍率 = 回放速度系数 ÷ 录像速度系数。
 *
 * ⚠️ 这里踩过一次坑：本页时间轴 `t` **已经是「真实秒」口径**
 * （建造项已由 `start_time` 乘过 `gameSecFactor`，见构建脚本的 `boScale`），
 * 而 SC2 游戏内时钟（小地图上方，LotV 起）同样按真实秒走 —— 所以
 * **回放速度 = 录像速度时倍率必须正好是 1**，再乘一次 1.4 会让悬浮窗快 40%。
 */
function ovSpeedFactor(){
  const g = rep().gameSecFactor || 1; // 游戏秒 → 真实秒
  const rec = 1 / g;                  // 录像速度系数（由样本实测反推）
  const key = $('#ovSpeed')?.value || 'same';
  const pb = key === 'same' ? rec : (SC2_SPEED_FACTOR[key] ?? rec);
  return +(pb * g).toFixed(4);
}

async function ovPush(){
  const pl = rep().players[V.who];
  const icons = await ensureOvIcons();
  const payload = {
    player: pl.name, race: pl.race, who: V.who,
    duration: rep().duration, file: rep().file,
    rate: V.rate, lang: V.lang,
    speed: ovSpeedFactor(),
    layout: $('#ovLayout').value,
    plate: $('#ovPlate').value,
    autostart: $('#ovStart').value,
    steps: V.steps.map(s => ({ t: s.t, text: s.text, icon: icons[s.unit] || '' })),
  };
  const res = await ovFetch('/overlay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 2000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return payload.steps.length;
}

function renderPip(){
  if (!pipWin) return;
  try {
    if (pipWin.closed) { pipWin = null; return; }
    const doc = pipWin.document;
    const i = V.steps.length ? lastIdxAt(V.steps, S.t) : -1;
    const g = k => (k >= 0 && k < V.steps.length) ? `<div class="pq ${k === i ? 'cur' : ''}"><span>${mmss(V.steps[k].t)}</span> ${esc(V.steps[k].text)}</div>` : '';
    doc.getElementById('pipBody').innerHTML =
      `<div class="pipc">${mmss(S.t)}</div><div class="pipq">${g(i - 1)}${g(i)}${g(i + 1)}${g(i + 2)}</div>`;
  } catch (_) { pipWin = null; }
}

async function openPip(){
  if (pipWin) { try { pipWin.close(); } catch (_) {} pipWin = null; ovSet(ovState, ovTextLast); return; }
  if (!('documentPictureInPicture' in window)) { alert('当前浏览器不支持画中画。'); return; }
  try {
    // ⚠️ Document PiP 的窗口 UI 是**规范强制**的，去不掉：
    //   WICG spec §3.2.2 Origin Visibility —— "required that the user agent makes it clear
    //   to the user which origin is controlling the window at all times"（防冒充系统 UI）。
    //   唯一能优化的是「返回标签页」按钮：disallowReturnToOpener 可以把它藏掉，
    //   但**标题栏 + origin 本身一定会在**。这也是纯网页方案不可逾越的天花板之一。
    pipWin = await window.documentPictureInPicture.requestWindow({
      width: 520, height: 132, disallowReturnToOpener: true,
    });
    const doc = pipWin.document;
    doc.documentElement.style.cssText = 'height:100%;margin:0';
    doc.body.style.cssText = 'margin:0;height:100%;background:#0e1117;color:#e6edf3;overflow:hidden;'
      + 'font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex;align-items:center;padding:10px 14px;box-sizing:border-box';
    const st = doc.createElement('style');
    st.textContent =
      '.pipc{font-size:30px;font-weight:700;color:#39ff14;flex:0 0 auto;padding-right:14px;margin-right:14px;'
      + 'border-right:2px solid #3fb950;font-variant-numeric:tabular-nums;text-shadow:0 0 12px rgba(57,255,20,.35)}'
      + '.pipq{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}'
      + '.pq{color:#6e7681;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}'
      + '.pq span{color:#d29922;margin-right:7px;font-size:11px}'
      + '.pq.cur{color:#f0f6fc;font-weight:700;font-size:15px}';
    doc.head.appendChild(st);
    const wrap = doc.createElement('div');
    wrap.innerHTML = '<div class="pipc">00:00</div><div class="pipq" id="pipBody"></div>';
    wrap.style.cssText = 'display:flex;align-items:center;width:100%;min-width:0';
    doc.body.appendChild(wrap);
    doc.getElementById('pipBody').id = 'pipBody';
    pipWin.addEventListener('pagehide', () => { pipWin = null; }, { once: true });
    renderPip();
    ovSet('wait', '已降级为浏览器内画中画窗口');
  } catch (err) {
    pipWin = null;
    ovSet('bad', '画中画打开失败：' + (err?.message || err));
  }
}

let ovState = 'unknown', ovTextLast = '';
$('#ovBtn').onclick = async () => {
  ovTextLast = $('#ovTxt').textContent;
  if (await ovProbe()) {
    try {
      const n = await ovPush();
      ovSet('ok', $('#ovStart').value === 'foreground'
        ? `已推送 ${n} 项 —— 进入游戏后自动起表（时钟 ×${ovSpeedFactor()}）`
        : `已推送到本地悬浮组件：${n} 条播报项，立即开始（时钟 ×${ovSpeedFactor()}）`);
    } catch (err) { ovSet('bad', '推送失败：' + (err?.message || err)); }
  } else {
    await openPip();
  }
};

/* ==========================================================================
   视图切换与控件
   ========================================================================== */
$('#viewSeg').onclick = e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const v = btn.dataset.view;
  [...$('#viewSeg').children].forEach(c => c.classList.toggle('on', c === btn));
  document.body.classList.toggle('boview', v === 'bo');
  document.body.classList.toggle('chatview', v === 'chat');
  if (v === 'data') { renderTimeline(); renderCharts(); }
  else if (v === 'chat') { renderChat(); }
  else { renderBo(); }
  syncCursor();
};

function fillWho(){
  const sel = $('#vbWho'); sel.innerHTML = '';
  rep().players.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = `${p.name}（${p.race}）`;
    sel.appendChild(o);
  });
  sel.value = String(V.who);
}

$('#vbPlay').onclick = () => vPlayPause();
$('#vbReset').onclick = () => vReset();
$('#vbSpeed').onchange = e => { if (V.playing) { V.base = S.t; V.wall0 = Date.now(); } V.speed = parseFloat(e.target.value); renderVoiceUi(); };
$('#vbRate').oninput = e => { V.rate = parseFloat(e.target.value); };
$('#vbLang').onchange = e => { V.lang = e.target.value; };
$('#vbWho').onchange = e => { V.who = parseInt(e.target.value, 10) || 0; voiceRebuild(); fillWho(); };

window.addEventListener('keydown', e => {
  if (!e.altKey) return;
  if (e.key === 'ArrowUp') { e.preventDefault(); vPlayPause(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); vReset(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); vSeek(); scheduleSync(); }
});

/* ---------- 渲染总入口 ---------- */
function renderAll(){
  if (!DATA.replays.length) return; // 生产页面会先空后满，原型不会
  renderSamples();
  renderHead();
  TL_EVENTS = computeEvents();
  renderTimeline();
  renderSide();
  renderCharts();
  renderTableTabs();
  renderTable();
  // 建造顺序 / 播报：与样本强绑定，切样本必须重建（含 #vbWho 选项）
  if (V.who >= rep().players.length) V.who = 0;
  renderBoFilter();
  if (document.body.classList.contains('boview')) renderBo();
  if (document.body.classList.contains('chatview')) renderChat();
  fillWho();
  voiceRebuild();
  S.t = clamp(S.t, 0, rep().duration);
  syncCursor();
  renderVoiceUi();
}

/* ==========================================================================
   对外接口 —— 生产页面通过这里驱动（取代原型的构建期 JSON 注入）
   ========================================================================== */

/**
 * 喂入解析结果并重绘全部视图。
 * @param {object[]} replays 每项形如原型里的 `DATA.replays[i]`：
 *   `{ file, map, duration, build, region, playedAt, winner, players[], chat[] }`，
 *   每个 player 需要 `{ name, clan, race, raceFull, t[], series{}, buildOrder[], workerDeaths[] }`；
 *   `chat[]` 每项 `{ t, player, ally, text }`（对局聊天视图用，可为空数组）。
 *   形状由 `js/lab/data.js` 的 `toLabReplays()` 保证，两边是一份契约。
 */
export function mountLab(replays){
  DATA = { generated: new Date().toISOString().slice(0, 10), replays };
  S.ri = Math.max(0, Math.min(S.ri, replays.length - 1));
  S.t = 0;
  V.who = 0;
  renderAll();
  ovProbe();          // 探测本地悬浮组件（真实网络请求，失败会降级，不抛）
  return { count: replays.length };
}

/** 切到第 i 份录像（0 起）。越界忽略。 */
export function focusReplay(i){
  if (!Number.isInteger(i) || i < 0 || i >= DATA.replays.length) return false;
  S.ri = i; S.t = 0; V.who = 0;
  renderAll();
  return true;
}

/** 只读的页面状态，用于外部断言与调试（不要直接写它）。 */
export const labState = S;
/** 只读的播报状态。 */
export const voiceState = V;
/** 强制重绘（改过 labState 后调用）。 */
export function redraw(){ renderAll(); }

/**
 * 沙盘视图驱动的全局游标入口（唯一被 `js/lab/sandbox.js` 调用的写入口）。
 * `scheduleSync()` 自带 rAF 节流，沙盘按 60fps 推进也不会造成重绘风暴。
 */
export function sandboxSeek(t){
  S.t = clamp(t, 0, rep().duration);
  scheduleSync();
}

