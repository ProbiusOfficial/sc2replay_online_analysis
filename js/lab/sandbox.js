/* ============================================================================
   沙盘模拟视图 —— 用 tracker 流重建的单位级时间线，在抽象沙盘上重演对局。

   ## 它是什么 / 不是什么

   数据源是 `ReplayData.sandbox`（js/worker/decoder/replay_data.ts::buildSandbox）：
   单位的出生/死亡/变形 + `SUnitPositionsEvent` 的稀疏位置采样（实测每 240 gameloop
   一批、轮转覆盖，开局约 2 分钟后才开始出现）。**录像里没有地图几何、没有血量、
   没有迷雾信息**，所以这是上帝视角的抽象沙盘：坐标极值推地图范围，矿线来自开局
   中立单位，位置在采样点之间直线插值。与 starcraft2.ai 同一数据上限。

   ## 视图特性（对标 starcraft2.ai 的 overview 播放器复刻）

   - **斜视角**（默认开）：地图做 45° 菱形等距投影 + 基地椭圆平台；关闭回到平面俯视。
     投影只影响坐标（proj()），图标保持直立；斜视角下按深度（x+y）排序绘制。
   - **左上/右上 HUD**：玩家名 + 单位/农民/建筑实时计数 + 编成 chips（活体军队按类型
     计数，icon+数量）+ 生产条（建造中建筑带进度条 + 最近 12s 出生单位）+ 外侧色条。
   - **底部资源条**：双方 矿/气（含采集率）+ 人口，取自 stats_series（与图表同口径）。

   ## 单位图标

   `assets/units/<Name>.webp`（256×256，共 222 张，命名与 tracker 单位名一致，
   来自 starcraft2.ai 的图标集，素材版权归 Blizzard Entertainment、粉丝非商用）。
   懒加载 + 36px 预缩放缓存；iconKey() 归一化变体；缺失或加载失败回退矢量点阵。

   ## 与 views.js 的关系（刻意零侵入）

   views.js 是提取产物（scripts/extract-lab-views.mjs），本模块**不修改它**，只：
     - 读导出的 `labState`（S.ri 当前样本 / S.t 全局游标）；
     - 用导出的 `sandboxSeek()` 推进游标（内部 rAF 节流，60fps 推进不引发重绘风暴）；
     - 用导出的 `focusReplay()` 支持工具条内切换录像；
     - 自己在 #viewSeg 上另挂一个 click 监听切 body.sandboxview（两个监听共存）。
   沙盘视图的「大」由 lab.css 承担：切进来后录像列表 / 对局头 / 播报条隐藏、
   1600px 宽度上限解除；「⛶ 全屏」对 .wrap 申请 Fullscreen API。
   ============================================================================ */

import { labState, sandboxSeek, focusReplay } from "./views.js";
import { ICON_DIR, iconKey, hasIcon, hasIconKey, hasUpgradeIcon, upgradeIconKey } from "./unit_icons.js";

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/* ---------- 单位分类（渲染层自己的小名表；数据层不做分类，保持数据完整） ---------- */

const WORKER_NAMES = /^(SCV|Probe|Drone|MULE)$/;
const SKIP_NAMES = /^(Larva|Egg|Broodling|Interceptor|Changeling|ChangelingZealot|ChangelingMarine|ChangelingMarineShield|ChangelingZergling|ChangelingZerglingWings|AutoTurret|KD8Charge|PointDefenseDrone|InvisibleTargetDummy|Nuke|Beacon[A-Za-z0-9]*)$/;
const NEUTRAL_STYLE = [
  [/MineralField/, { c: "#d8a531", r: 3.5, shape: "diamond" }],
  [/Geyser/, { c: "#3f9e5f", r: 5, shape: "ring" }],
  [/XelNagaTower/, { c: "#dfe6f0", r: 7, shape: "ring" }],
  [/Destructible|Collapsible/, { c: "#414a5a", r: 5, shape: "square" }],
];

/** 建筑边长（世界单位，1 tile = 4）。按名字前缀匹配，先命中先用。 */
const BUILDING_SIZE = [
  [/CommandCenter|OrbitalCommand|PlanetaryFortress|Nexus|Hatchery|Lair|Hive|FusionCore/, 20],
  [/Barracks|Factory|Starport|Gateway|WarpGate|RoboticsFacility|Stargate|Spire|GreaterSpire|UltraliskCavern|HydraliskDen|BanelingNest|InfestationPit|RoachWarren|TwilightCouncil|TemplarArchive|DarkShrine|RoboticsBay|FleetBeacon|Armory|EngineeringBay|Forge|CyberneticsCore|SpawningPool|EvolutionChamber|Academy|Ghost|TechLab|Reactor/, 12],
  [/SupplyDepot|Pylon|ShieldBattery|PhotonCannon|Bunker|CreepTumor/, 8],
  [/Refinery|Extractor|Assimilator|MissileTurret|SpineCrawler|SporeCrawler|SensorTower/, 6],
];
const BUILDING_RE = /CommandCenter|Orbital|Planetary|Nexus|Hatchery|Lair|Hive|FusionCore|Barracks|Factory|Starport|Gateway|WarpGate|Robotics|Stargate|Spire|Cavern|Den|BanelingNest|InfestationPit|RoachWarren|Twilight|Templar|DarkShrine|FleetBeacon|Armory|EngineeringBay|Forge|Cybernetics|SpawningPool|EvolutionChamber|Academy|TechLab|Reactor|SupplyDepot|Pylon|ShieldBattery|PhotonCannon|Bunker|CreepTumor|Refinery|Extractor|Assimilator|MissileTurret|SpineCrawler|SporeCrawler|SensorTower/;

const isBuildingName = (n) => BUILDING_RE.test(n);
const buildingSize = (n) => {
  for (const [re, sz] of BUILDING_SIZE) if (re.test(n)) return sz;
  return 10;
};
const neutralStyle = (n) => {
  for (const [re, st] of NEUTRAL_STYLE) if (re.test(n)) return st;
  return null;
};

/* ---------- 单位图标 ---------- */

const ICON_CACHE = new Map(); // 归一化名 → 36px 预缩放 canvas；null = 加载中/失败
let iconsLoaded = 0;

/** tracker 名 → 图标文件名。图标集与 tracker 同名，只有少数变体要归一。 */
/** 非科技的升级流噪声：游戏厅喷漆、公会奖励动作、老录像的幽灵单位残影。 */
const NOISE_UPGRADE = /^(Spray|RewardDance)|^GameHeartActive$|^GhostAlternate$/i;

/** 懒加载：首次请求触发加载，就绪后换入 36px 缓存；失败永久 null（矢量兜底）。 */
function iconFor(name) {
  const key = iconKey(name);
  if (!key || !hasIconKey(key)) return null;
  if (ICON_CACHE.has(key)) return ICON_CACHE.get(key);
  ICON_CACHE.set(key, null);
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement("canvas");
    cv.width = 36; cv.height = 36;
    cv.getContext("2d").drawImage(img, 0, 0, 36, 36);
    ICON_CACHE.set(key, cv);
    iconsLoaded++;
    lastT = -1; // 图标是绘制那一帧才请求的：就绪后标脏，下一帧立刻换掉点阵兜底
  };
  img.onerror = () => { /* 保持 null：缺图/离线时回退到点阵，不刷控制台 */ };
  img.src = `${ICON_DIR}/${key}.webp`;
  return null;
}

/** 像素级缩放系数：跟随地图缩放（s = 世界单位→CSS px），但有上下限。 */
const zoomK = (s) => clamp(0.72 + s * 0.16, 0.9, 1.35);

/* ---------- 模块状态 ---------- */

let replays = [];          // 与 views.js 的 DATA.replays 同一数组（main.js 注入）
let model = null;          // 当前样本的预处理产物（按 S.ri 缓存）
let modelRi = -1;
let playing = false;
let speed = 8;
let showWorkers = true;
let iso = true;            // 斜视角（默认开，对标原站）
let lastT = -1;
let lastW = -1, lastH = -1;
let staticLayer = null;    // 离屏 canvas：底图 + 中立单位（切样本/缩放/切换视角时重建）
let hudAt = -1;            // HUD 上次更新时刻（节流用）
let hudCacheT = -1;        // HUD 数据对应的游标时刻

/* ---------- HUD 显示开关（用户可勾选，localStorage 记忆） ---------- */

const HUD_KEYS = [
  ["comp", "编成"], ["tech", "科技"], ["prod", "生产"], ["losses", "战损"],
  ["apm", "APM·EPM"], ["res", "资源条"], ["cam", "镜头标记"],
];
let hudOpts = { comp: true, tech: true, prod: true, losses: true, apm: true, res: true, cam: true };
try { Object.assign(hudOpts, JSON.parse(localStorage.getItem("sb-hud") ?? "{}")); } catch (_) {}
const saveHudOpts = () => { try { localStorage.setItem("sb-hud", JSON.stringify(hudOpts)); } catch (_) {} };

const els = {};            // 缓存的 DOM 引用

/** 玩家配色 —— 与 views.js 的 COL 一致；优先读 lab.css 的 --a/--b。 */
function playerColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    a: cs.getPropertyValue("--a").trim() || "#d94f45",
    b: cs.getPropertyValue("--b").trim() || "#2f80d6",
  };
}
let COL = { a: "#d94f45", b: "#2f80d6" };

/* ---------- 当前样本预处理 ---------- */

/**
 * 把当前样本拆成渲染友好的三组：静态中立（底图层）、动态单位（逐帧）、死亡事件（按时间排序）。
 * 同时从矿线聚类出「基地位置」（斜视角的椭圆平台 / 出生点标记都用它）。
 * @param {object} r lab 适配层的单份录像模型（r.sandbox 由 data.js 透传自 ReplayData.sandbox）
 */
function buildModel(r) {
  const sb = r.sandbox;
  const m = { sb, statics: [], units: [], deaths: [], startLocs: [], bases: [], cams: { 1: [], 2: [] }, lossByPid: { 1: [], 2: [] } };
  if (!sb) return m;
  const seenStart = new Set();
  for (const u of sb.units) {
    if (u.p === 0) {
      const st = neutralStyle(u.n);
      if (st) m.statics.push({ x: u.x, y: u.y, n: u.n, st });
      continue;
    }
    if (SKIP_NAMES.test(u.n) && !u.chg.length) continue; // 纯幼虫/虫卵等中间态（会变形的不跳）
    m.units.push(u);
    if (u.d != null) {
      m.deaths.push(u);
      m.lossByPid[u.p === 2 ? 2 : 1].push(u);
    }
    // 出生点标记：每名玩家第一座主堡
    if (!seenStart.has(u.p) && u.b < 5 && /CommandCenter$|Nexus$|Hatchery$/.test(u.n)) {
      seenStart.add(u.p);
      m.startLocs.push({ x: u.x, y: u.y, p: u.p });
    }
  }
  m.deaths.sort((a, b) => a.d - b.d);
  for (const pid of [1, 2]) m.lossByPid[pid].sort((a, b) => a.d - b.d);

  // 镜头轨迹（tracks.cameras 扁平 [pid, 秒, x, y, ...]，按时间升序）
  const cams = r.tracks?.cameras ?? [];
  for (let i = 0; i + 3 < cams.length; i += 4) {
    const pid = cams[i] === 2 ? 2 : 1;
    m.cams[pid].push({ t: cams[i + 1], x: cams[i + 2], y: cams[i + 3] });
  }

  // 基地聚类：把矿/气泉按距离归簇（≥3 个点的簇 = 一处基地），斜视角下画椭圆平台
  for (const st of m.statics) {
    if (!/MineralField|Geyser/.test(st.n)) continue;
    const c = m.bases.find((b) => Math.hypot(b.x - st.x, b.y - st.y) < 34);
    if (c) { c.n++; c.x = (c.x * (c.n - 1) + st.x) / c.n; c.y = (c.y * (c.n - 1) + st.y) / c.n; }
    else m.bases.push({ x: st.x, y: st.y, n: 1 });
  }
  m.bases = m.bases.filter((b) => b.n >= 3);
  return m;
}

/* ---------- 几何换算 ---------- */

/**
 * 世界坐标 → 画布 CSS 像素。iso=true 时为 45° 菱形等距投影：
 * X = (x−y)、Y = (x+y)/2，再统一缩放平移到画布内。
 */
function fitTransform(w, h) {
  const { minX, minY, maxX, maxY } = model.sb;
  const corner = (x, y) => (iso ? [x - y, (x + y) * 0.5] : [x, y]);
  const cs = [corner(minX, minY), corner(maxX, minY), corner(minX, maxY), corner(maxX, maxY)];
  const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
  const b0x = Math.min(...xs), b1x = Math.max(...xs), b0y = Math.min(...ys), b1y = Math.max(...ys);
  const s = Math.min((w - 24) / Math.max(40, b1x - b0x), (h - 24) / Math.max(40, b1y - b0y));
  return {
    s,
    ox: (w - (b1x - b0x) * s) / 2 - b0x * s,
    oy: (h - (b1y - b0y) * s) / 2 - b0y * s,
  };
}

let TF = null; // 当前帧的变换 { s, ox, oy }
const projX = (x, y) => (iso ? (x - y) : x) * TF.s + TF.ox;
const projY = (x, y) => (iso ? (x + y) * 0.5 : y) * TF.s + TF.oy;
const depthOf = (x, y) => (iso ? x + y : y);

/** 位置采样点之间的线性插值（pos 扁平 [t,x,y,...]）。 */
function posAt(u, t) {
  const p = u.pos;
  if (!p) return null;
  const n = p.length / 3;
  if (t <= p[0]) return [p[1], p[2]];
  const last = (n - 1) * 3;
  if (t >= p[last]) return [p[last + 1], p[last + 2]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid * 3] <= t) lo = mid; else hi = mid; }
  const t0 = p[lo * 3], k = (t - t0) / (p[hi * 3] - t0);
  return [p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * k, p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * k];
}

/** t 时刻的单位类型名（跟随变形）。 */
function nameAt(u, t) {
  let n = u.n;
  for (const c of u.chg) { if (c[0] <= t) n = c[1]; else break; }
  return n;
}

/* ---------- 底图（离屏层，切样本 / 缩放 / 切换视角才重建） ---------- */

function buildStaticLayer(w, h, dpr) {
  staticLayer = document.createElement("canvas");
  staticLayer.width = Math.round(w * dpr);
  staticLayer.height = Math.round(h * dpr);
  const c = staticLayer.getContext("2d");
  c.scale(dpr, dpr);
  TF = fitTransform(w, h);
  const X = (x, y) => projX(x, y), Y = (x, y) => projY(x, y);

  c.fillStyle = "#0b0f15";
  c.fillRect(0, 0, w, h);

  // 地图范围（iso 下是菱形）：四角连线 + 10-tile 网格（世界轴 → 投影后的斜线）
  const { minX, minY, maxX, maxY } = model.sb;
  const pad = 8;
  const c0 = [X(minX - pad, minY - pad), Y(minX - pad, minY - pad)];
  const c1 = [X(maxX + pad, minY - pad), Y(maxX + pad, minY - pad)];
  const c2 = [X(maxX + pad, maxY + pad), Y(maxX + pad, maxY + pad)];
  const c3 = [X(minX - pad, maxY + pad), Y(minX - pad, maxY + pad)];
  c.fillStyle = iso ? "#0d1219" : "#0e141d";
  c.strokeStyle = "#232c3b";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(c0[0], c0[1]); c.lineTo(c1[0], c1[1]); c.lineTo(c2[0], c2[1]); c.lineTo(c3[0], c3[1]);
  c.closePath();
  c.fill();
  c.stroke();
  c.strokeStyle = "rgba(120,140,170,.07)";
  c.beginPath();
  for (let gx = minX - (minX % 40); gx <= maxX; gx += 40) { c.moveTo(X(gx, minY - pad), Y(gx, minY - pad)); c.lineTo(X(gx, maxY + pad), Y(gx, maxY + pad)); }
  for (let gy = minY - (minY % 40); gy <= maxY; gy += 40) { c.moveTo(X(minX - pad, gy), Y(minX - pad, gy)); c.lineTo(X(maxX + pad, gy), Y(maxX + pad, gy)); }
  c.stroke();

  // 基地平台：矿线簇 → 椭圆底座（斜视角下的「立体平台」观感来源）
  for (const b of model.bases) {
    const x = X(b.x, b.y), y = Y(b.x, b.y);
    const rx = 15 * TF.s + 6, ry = iso ? rx * 0.5 : rx;
    c.fillStyle = "rgba(150,170,200,.07)";
    c.strokeStyle = "rgba(150,170,200,.16)";
    c.lineWidth = 1;
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fill(); c.stroke();
  }

  // 出生点圈
  for (const loc of model.startLocs) {
    const x = X(loc.x, loc.y), y = Y(loc.x, loc.y);
    c.strokeStyle = loc.p === 1 ? COL.a : loc.p === 2 ? COL.b : "#8792a5";
    c.globalAlpha = 0.4;
    c.lineWidth = 1.5;
    c.beginPath();
    c.ellipse(x, y, 22 * Math.max(TF.s, 0.6), (iso ? 0.5 : 1) * 22 * Math.max(TF.s, 0.6), 0, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 1;
  }

  // 中立地图锚点：矿 / 气泉 / Xel'Naga 塔 / 可破坏物
  for (const st of model.statics) {
    const x = X(st.x, st.y), y = Y(st.x, st.y);
    const r = Math.max(1.6, st.st.r * TF.s);
    c.fillStyle = st.st.c;
    c.globalAlpha = 0.9;
    if (st.st.shape === "diamond") {
      c.beginPath();
      c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y);
      c.closePath(); c.fill();
    } else if (st.st.shape === "ring") {
      c.strokeStyle = st.st.c;
      c.lineWidth = 1.4;
      c.beginPath(); c.ellipse(x, y, r, iso ? r * 0.6 : r, 0, 0, Math.PI * 2); c.stroke();
    } else {
      c.fillRect(x - r / 2, y - r / 2, r, r);
    }
    c.globalAlpha = 1;
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------- 逐帧绘制 ---------- */

function render() {
  const canvas = els.canvas;
  if (!canvas || !model || !model.sb) return;
  const stage = els.stage;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  if (!staticLayer || lastW !== w || lastH !== h) {
    buildStaticLayer(w, h, dpr);
    lastW = w; lastH = h;
  }
  const t = labState.t;
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.drawImage(staticLayer, 0, 0, w, h);

  const z = zoomK(TF.s); // 图标的像素缩放：跟随地图大小，但有上下限
  const X = (x, y) => projX(x, y), Y = (x, y) => projY(x, y);

  // 可见单位收集 → 按深度排序（斜视角下右上方的单位压在左下方之上）
  const drawList = [];
  for (const u of model.units) {
    if (u.b > t) continue;
    if (u.d != null && u.d <= t) continue;
    const n = nameAt(u, t);
    const isB = isBuildingName(n);
    const isW = !isB && WORKER_NAMES.test(n);
    if (isW && !showWorkers) continue;
    let x = u.x, y = u.y;
    if (!isB) { const p = posAt(u, t); if (!p) continue; x = p[0]; y = p[1]; }
    drawList.push({ u, n, isB, isW, x, y, d: depthOf(x, y) });
  }
  drawList.sort((p, q) => p.d - q.d);

  for (const it of drawList) {
    const col = it.u.p === 1 ? COL.a : it.u.p === 2 ? COL.b : "#8792a5";
    const x = X(it.x, it.y), y = Y(it.x, it.y);
    const icon = iconFor(it.n);
    if (it.isB) {
      const underConstruction = it.u.done != null && t < it.u.done;
      if (icon) {
        const size = clamp(buildingSize(it.n) * TF.s * 0.92, 13, 30);
        c.globalAlpha = underConstruction ? 0.55 : 0.95;
        c.drawImage(icon, x - size / 2, y - size / 2, size, size);
        c.globalAlpha = 1;
        c.strokeStyle = col;
        c.lineWidth = 1.6;
        if (underConstruction) c.setLineDash([3, 2.5]);
        c.beginPath();
        c.ellipse(x, y, size / 2 + 2, (iso ? 0.55 : 1) * (size / 2 + 2), 0, 0, Math.PI * 2);
        c.stroke();
        if (underConstruction) c.setLineDash([]);
      } else {
        const size = Math.max(3, buildingSize(it.n) * TF.s);
        if (underConstruction) {
          c.strokeStyle = col;
          c.globalAlpha = 0.55;
          c.setLineDash([3, 2.5]);
          c.lineWidth = 1.2;
          c.strokeRect(x - size / 2, y - size / 2, size, size);
          c.setLineDash([]);
          c.globalAlpha = 1;
        } else {
          c.fillStyle = col;
          c.globalAlpha = 0.82;
          c.fillRect(x - size / 2, y - size / 2, size, size);
          c.globalAlpha = 1;
        }
      }
    } else if (icon) {
      const size = (it.isW ? 12 : 17) * z;
      const r = size * 0.46 + 1.5;
      c.fillStyle = col;
      c.globalAlpha = 0.9;
      c.beginPath(); c.ellipse(x, y, r, iso ? r * 0.75 : r, 0, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
      c.drawImage(icon, x - size / 2, y - size / 2, size, size);
    } else {
      const r = Math.max(1.6, (it.isW ? 3.5 : 5) * Math.min(TF.s, 1.4));
      c.fillStyle = col;
      c.beginPath(); c.ellipse(x, y, r, iso ? r * 0.75 : r, 0, 0, Math.PI * 2); c.fill();
    }
  }

  // 镜头标记：各玩家「当前屏幕」的视野框（约 22×14 tiles），取 ≤t 的最后一次镜头事件
  if (hudOpts.cam) {
    for (const pid of [1, 2]) {
      const arr = model.cams?.[pid];
      if (!arr || !arr.length || arr[0].t > t) continue;
      let lo = 0, hi = arr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid; }
      const cp = arr[lo];
      const col = pid === 1 ? COL.a : pid === 2 ? COL.b : "#8792a5";
      const corners = [[cp.x - 44, cp.y - 30], [cp.x + 44, cp.y - 30], [cp.x + 44, cp.y + 30], [cp.x - 44, cp.y + 30]];
      c.beginPath();
      corners.forEach(([wx, wy], k) => { const px = projX(wx, wy), py = projY(wx, wy); if (k) c.lineTo(px, py); else c.moveTo(px, py); });
      c.closePath();
      c.globalAlpha = 0.08; c.fillStyle = col; c.fill();
      c.globalAlpha = 0.55; c.strokeStyle = col; c.lineWidth = 1.4; c.stroke();
      c.globalAlpha = 1;
    }
  }

  // 阵亡闪光：最后 1.5 秒内的死亡，在精确死亡坐标上画外扩淡出的圈
  const flash = 1.5;
  for (let i = model.deaths.length - 1; i >= 0; i--) {
    const u = model.deaths[i];
    if (u.d > t) continue;
    if (u.d < t - flash) break; // deaths 按 d 升序，从尾部往回扫出窗
    const age = (t - u.d) / flash;
    const col = u.p === 1 ? COL.a : u.p === 2 ? COL.b : "#8792a5";
    c.strokeStyle = col;
    c.globalAlpha = 0.65 * (1 - age);
    c.lineWidth = 1.4;
    c.beginPath();
    c.ellipse(X(u.dx ?? u.x), Y(u.dy ?? u.y), 2 + age * 9, (2 + age * 9) * (iso ? 0.55 : 1), 0, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 1;
  }

  // 右上角的进度水印（帮助定位当前时刻）
  c.fillStyle = "rgba(200,212,230,.5)";
  c.font = "600 13px ui-monospace,Menlo,monospace";
  c.textAlign = "right";
  c.fillText(mmss(t), w - 14, 24);
}

/* ---------- HUD（左上/右上面板 + 底部资源条，对标原站 overview 播放器） ---------- */

function idxAt(arr, t) {
  let lo = 0, hi = arr.length - 1;
  if (t <= arr[0]) return 0;
  if (t >= arr[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; }
  return lo;
}

const pidColor = (p) => (p === 1 ? COL.a : p === 2 ? COL.b : "#8792a5");
const fmtInt = (v) => Math.round(v ?? 0).toLocaleString("en-US");

/**
 * 汇总 t 时刻双方的可视状态：单位/农民/建筑计数、编成（活体军队按类型计数）、
 * 生产条内容（建造中建筑带进度 + 最近 12s 出生单位）。
 * 数据上限的如实说明：tracker 没有「生产开始」事件，训练单位的出生即完成——
 * 「生产中」只能用「最近出生」近似；建筑的建造区间（born→done）是精确的。
 */
function computeHud(t) {
  const out = {
    1: { units: 0, workers: 0, structures: 0, underCon: [], recent: [], comp: new Map() },
    2: { units: 0, workers: 0, structures: 0, underCon: [], recent: [], comp: new Map() },
  };
  if (!model) return out;
  for (const u of model.units) {
    const pid = u.p === 2 ? 2 : 1;
    if (u.b > t || (u.d != null && u.d <= t)) continue;
    const n = nameAt(u, t);
    const slot = out[pid];
    if (isBuildingName(n)) {
      slot.structures++;
      if (u.done != null && t < u.done) {
        slot.underCon.push({ n, k: (t - u.b) / Math.max(1e-6, u.done - u.b) });
      }
      continue;
    }
    const isW = WORKER_NAMES.test(n);
    if (isW) slot.workers++;
    else {
      slot.units++;
      slot.comp.set(n, (slot.comp.get(n) ?? 0) + 1);
    }
    if (t - u.b <= 12) slot.recent.push({ n, w: isW, k: 1 - (t - u.b) / 12 });
  }
  return out;
}

function chipRow(map, max = 10) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, max)
    .map(([n, cnt]) => `<span class="chip" title="${esc(n)}">${hasIcon(n) ? `<img src="${ICON_DIR}/${iconKey(n)}.webp" alt="">` : ""}${cnt}</span>`)
    .join("");
}

function renderHud() {
  const r = replays[labState.ri];
  if (!r || !els.panelA || !model) return;
  const t = labState.t;

  // HUD 是 8Hz 的 DOM 重排，别跟着画布跑满 60fps；游标没动也不必重建
  if (t === hudCacheT && hudAt > 0 && performance.now() - hudAt < 400) return;
  if (performance.now() - hudAt < 120) return;
  hudAt = performance.now();
  hudCacheT = t;

  const H = computeHud(t);
  [els.panelA, els.panelB].forEach((el, i) => {
    const pid = i === 0 ? 1 : 2;
    const p = r.players[i];
    const h = H[pid];
    if (!p) { el.style.display = "none"; return; }
    el.style.display = "";
    const prod = h.underCon.filter((it) => hasIcon(it.n)).slice(0, 8).map((it) =>
      `<span class="chip prod" title="建造中 ${Math.round(it.k * 100)}%"><img src="${ICON_DIR}/${iconKey(it.n)}.webp" alt=""><i style="width:${Math.round(clamp(it.k, 0, 1) * 100)}%"></i></span>`
    ).join("");
    const fresh = h.recent.filter((it) => hasIcon(it.n)).slice(0, 10).map((it) =>
      `<span class="chip" style="opacity:${(0.45 + 0.55 * it.k).toFixed(2)}"><img src="${ICON_DIR}/${iconKey(it.n)}.webp" alt=""></span>`
    ).join("");
    const tech = techAt(t)[pid];
    const upsAll = (r.upgrades ?? []).filter((u) => (u.p === 2 ? 2 : 1) === pid && !NOISE_UPGRADE.test(u.n));
    // 研究中的科技：完成时刻 T、时长 D ⇒ 进行中区间 [T−D, T)。原始事件只有完成点，
    // 进度条是从 data.json 的研究时长**回推**的近似（时长表按 LotV 口径）。
    const inProg = upsAll
      .filter((u) => u.t > t && u.dur != null && t > u.t - u.dur)
      .map((u) => ({ u, k: clamp((t - (u.t - u.dur)) / u.dur, 0, 1) }))
      .sort((a, b) => a.u.t - b.u.t);
    const show = [
      ...inProg.map((it) => ({ u: it.u, k: it.k, prog: true })),
      ...tech.slice(-12).map((u) => ({ u, k: 1, prog: false })),
    ].slice(0, 14);
    const techChips = show.map(({ u, k, prog }) =>
      `<span class="chip${prog ? " prod" : ""}" title="${esc(u.zh)} · 完成 @ ${mmss(u.t)}">${hasUpgradeIcon(u.n) ? `<img src="${ICON_DIR}/${upgradeIconKey(u.n)}.webp" alt="">` : `<i class="chip-txt">${esc(shortZh(u.zh))}</i>`}${prog ? `<i class="bar" style="width:${Math.round(k * 100)}%"></i>` : ""}</span>`
    ).join("");
    const techMore = upsAll.length > show.length ? `<span class="chip chip-more">+${upsAll.length - show.length}</span>` : "";
    lastTech[pid] = tech.length;

    // 战损：累计损失数 + 最近 10 秒的损失图标
    const lossArr = model.lossByPid[pid];
    let lossIdx = -1, lo0 = 0, hi0 = lossArr.length - 1;
    if (lossArr.length && lossArr[0].d <= t) {
      while (hi0 - lo0 > 1) { const mid = (lo0 + hi0) >> 1; if (lossArr[mid].d <= t) lo0 = mid; else hi0 = mid; }
      lossIdx = lo0;
    }
    const recentLoss = [];
    for (let i = lossIdx; i >= 0 && lossArr[i].d > t - 10 && recentLoss.length < 8; i--) recentLoss.push(lossArr[i]);
    const lossRow = hudOpts.losses && lossIdx >= 0
      ? `<div class="sp-row sp-prod">损失 <b style="color:${pidColor(pid)}">${fmtInt(lossIdx + 1)}</b>${recentLoss.map((u) => hasUpgradeIcon(nameAt(u, u.d)) ? `<span class="chip"><img src="${ICON_DIR}/${upgradeIconKey(nameAt(u, u.d))}.webp" alt=""></span>` : "").join("")}</div>`
      : "";

    const compRow = hudOpts.comp && h.comp.size ? `<div class="sp-row">${chipRow(h.comp, 10)}</div>` : "";
    const techRow = hudOpts.tech && tech.length ? `<div class="sp-label">科技 ${tech.length}${inProg.length ? ` · 研 ${inProg.length}` : ""}</div><div class="sp-row">${techChips}${techMore}</div>` : "";
    const prodRow = hudOpts.prod && (prod || fresh) ? `<div class="sp-row sp-prod">${prod}${fresh}</div>` : "";
    const apmTxt = hudOpts.apm ? ` · APM ${fmtInt(apmAt(pid, t))} · EPM ${fmtInt(epmAt(pid, t))}` : "";
    el.innerHTML = `
      <div class="sp-name"><b style="color:${pidColor(pid)}">${esc(p.name)}</b><span>${esc(p.raceFull)}</span></div>
      <div class="sp-counts">单位 ${fmtInt(h.units)} · 农民 ${fmtInt(h.workers)} · 建筑 ${fmtInt(h.structures)}</div>
      ${compRow}
      ${techRow}
      ${prodRow}
      ${lossRow}
      <div class="sp-stats">人口 <b>${fmtInt(p.series.supUsed[idxAt(p.t, t)])}/${fmtInt(p.series.supMade[idxAt(p.t, t)])}</b>
        · 军队 <b>${fmtInt((p.series.mUsedArmy[idxAt(p.t, t)] ?? 0) + (p.series.vUsedArmy[idxAt(p.t, t)] ?? 0))}</b>${apmTxt}</div>`;
  });

  // 底部资源条：矿/气 + 采集率 + 人口（与图表同一份 stats_series，口径一致）
  if (els.res && hudOpts.res) {
    const cell = (i) => {
      const p = r.players[i];
      if (!p) return "";
      const k = idxAt(p.t, t);
      return `<b style="color:${i === 0 ? COL.a : COL.b}">${esc(p.name)}</b>`
        + `<span class="r-min">${fmtInt(p.series.mCur[k])}</span><em>${fmtInt(p.series.mRate[k])}</em>`
        + `<span class="r-gas">${fmtInt(p.series.vCur[k])}</span><em>${fmtInt(p.series.vRate[k])}</em>`
        + `<span class="r-sup">${fmtInt(p.series.supUsed[k])}/${fmtInt(p.series.supMade[k])}</span>`;
    };
    els.res.innerHTML = cell(0) + `<span class="r-vs">VS</span>` + cell(1);
    els.res.style.display = "";
  } else if (els.res) {
    els.res.style.display = "none";
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 双方截至 t 已完成的科技（噪声行已滤除）。 */
function techAt(t) {
  const res = { 1: [], 2: [] };
  for (const u of replays[labState.ri]?.upgrades ?? []) {
    if (u.t > t || NOISE_UPGRADE.test(u.n)) continue;
    res[u.p === 2 ? 2 : 1].push(u);
  }
  return res;
}

/** APM(t) = 近 60 秒指令数；EPM 同窗口取去重桶。 */
function bucketSum(arr, from, to) {
  let sum = 0;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) sum += arr[i] || 0;
  return sum;
}
const apmAt = (pid, t) => {
  const s2 = replays[labState.ri]?.tracks?.commands?.[String(pid)];
  return s2 ? bucketSum(s2.apm, Math.floor(t) - 59, Math.floor(t)) : 0;
};
const epmAt = (pid, t) => {
  const s2 = replays[labState.ri]?.tracks?.commands?.[String(pid)];
  return s2 ? bucketSum(s2.epm, Math.floor(t) - 59, Math.floor(t)) : 0;
};

/** 无图标科技的名字兜底：中文超过 4 字取前 4 字。 */
const shortZh = (zh) => (zh.length > 4 ? zh.slice(0, 4) : zh);
let lastTech = { 1: 0, 2: 0 };

/* ---------- 工具条：地图信息 / 切录像 ---------- */

function renderMapInfo() {
  const r = replays[labState.ri];
  if (!r || !els.mapInfo) return;
  els.mapInfo.textContent =
    `${r.map} · ${mmss(r.duration)} · build ${r.build} · ${r.players.map((p) => p.raceFull).join(" vs ")}`;
}

function fillReplaySelect() {
  const sel = els.replay;
  if (!sel) return;
  sel.innerHTML = "";
  replays.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${i + 1}. ${r.map} · ${r.players.map((p) => p.race).join("v")} · ${mmss(r.duration)}`;
    sel.appendChild(o);
  });
  sel.value = String(labState.ri);
}

/* ---------- 主循环 ---------- */

function tick() {
  requestAnimationFrame(tick);
  const visible = document.body.classList.contains("sandboxview");
  if (!visible) { lastT = labState.t; return; }

  // 切样本：重建模型与底图，同步工具条
  if (labState.ri !== modelRi) {
    modelRi = labState.ri;
    model = replays[modelRi] ? buildModel(replays[modelRi]) : null;
    staticLayer = null;
    lastW = -1; lastH = -1;
    lastT = -1;
    hudCacheT = -1;
    renderMapInfo();
    if (els.replay && els.replay.value !== String(modelRi)) els.replay.value = String(modelRi);
  }

  if (playing && model?.sb) {
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastWall) / 1000);
    lastWall = now;
    const D = replays[labState.ri]?.duration ?? 0;
    const nt = labState.t + dt * speed;
    if (nt >= D) { sandboxSeek(D); stop(); }
    else sandboxSeek(nt);
  } else {
    lastWall = performance.now();
  }

  const t = labState.t;
  const w = els.stage?.clientWidth ?? -1, h = els.stage?.clientHeight ?? -1;
  if (!playing && t === lastT && w === lastW && h === lastH) return; // 无变化不重绘
  lastT = t;
  render();
  renderHud();
}
let lastWall = performance.now();

/* ---------- 播放控制 ---------- */

function stop() {
  playing = false;
  if (els.play) els.play.textContent = "▶ 播放";
}

function togglePlay() {
  if (!model?.sb) return;
  const D = replays[labState.ri]?.duration ?? 0;
  if (playing) { stop(); return; }
  if (labState.t >= D - 0.05) sandboxSeek(0);
  playing = true;
  if (els.play) els.play.textContent = "⏸ 暂停";
}

/* ---------- 挂载 ---------- */

function bindOnce() {
  if (els.bound) return;
  els.bound = true;
  COL = playerColors();

  els.stage = $("#sbStage");
  els.canvas = $("#sbCanvas");
  els.play = $("#sbPlay");
  els.panelA = $("#sbPanelA");
  els.panelB = $("#sbPanelB");
  els.res = $("#sbRes");
  els.mapInfo = $("#sbMapInfo");
  els.replay = $("#sbReplay");
  els.full = $("#sbFull");
  els.iso = $("#sbIso");

  // 视图切换：views.js 的 #viewSeg 处理器照常跑（v=sandbox 落到它的 else 分支，
  // 只是多渲染一次隐藏的建造顺序，无害）；这里负责 body 类与首次进入的重绘。
  $("#viewSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const on = btn.dataset.view === "sandbox";
    document.body.classList.toggle("sandboxview", on);
    if (on) { lastW = -1; lastH = -1; } // 强制下一帧重建底图（容器刚从 display:none 里出来）
  });

  els.play?.addEventListener("click", togglePlay);
  $("#sbSpeed")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    speed = parseFloat(btn.dataset.s);
    [...$("#sbSpeed").children].forEach((b) => b.classList.toggle("on", b === btn));
  });
  $("#sbWorkers")?.addEventListener("change", (e) => { showWorkers = e.target.checked; lastT = -1; hudCacheT = -1; });
  els.replay?.addEventListener("change", (e) => focusReplay(parseInt(e.target.value, 10) || 0));
  els.iso?.addEventListener("click", () => {
    iso = !iso;
    els.iso.classList.toggle("on", iso);
    staticLayer = null; // 底图（网格/平台/矿线）跟视角走，必须重建
    lastW = -1; lastH = -1;
    hudCacheT = -1;
  });

  // 全屏：对 .wrap 申请（时间轴 + 工具条 + 画布一起放大，:fullscreen 规则接管高度）
  els.full?.addEventListener("click", () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.querySelector(".wrap")?.requestFullscreen();
    } catch (_) { /* 不支持就保持窗口模式 */ }
  });
  document.addEventListener("fullscreenchange", () => {
    lastW = -1; lastH = -1;
    if (els.full) els.full.textContent = document.fullscreenElement ? "⛶ 退出全屏" : "⛶ 全屏";
  });

  // HUD 显示开关（最下面一排，用户决定 HUD 显示什么；localStorage 记忆）
  const optHost = $("#sbHudOpts");
  if (optHost) {
    optHost.innerHTML = `<span class="lab">HUD 显示</span>`;
    HUD_KEYS.forEach(([k, label]) => {
      const ck = document.createElement("label");
      ck.className = "sbopt";
      ck.innerHTML = `<input type="checkbox" data-k="${k}" ${hudOpts[k] ? "checked" : ""}>${label}`;
      optHost.appendChild(ck);
    });
    optHost.addEventListener("change", (e) => {
      const k = e.target?.dataset?.k;
      if (!k) return;
      hudOpts[k] = e.target.checked;
      saveHudOpts();
      lastT = -1; hudCacheT = -1;
    });
  }

  window.addEventListener("resize", () => { lastW = -1; lastH = -1; });
  requestAnimationFrame(tick);
}

/**
 * 注入解析结果（与 views.js 的 DATA.replays 同一数组引用），并复位播放状态。
 * @param {object[]} rs lab 适配层产物；`r.sandbox` 形如 ReplayDataSandbox（时间已换算为秒）
 */
export function mountSandbox(rs) {
  replays = rs ?? [];
  model = null;
  modelRi = -1;
  stop();
  lastT = -1;
  hudCacheT = -1;
  fillReplaySelect();
}

/** boot 时调用一次：绑控件 + 起主循环。 */
export function initSandbox() {
  bindOnce();
  // 验收 / 调试句柄（只读），与 main.js 的 window.__lab 同一模式：
  // 沙盘内部状态在模块作用域里，验收脚本需要断言「真的画了东西」。
  window.__sandbox = {
    get stats() {
      return model
        ? {
            ri: modelRi,
            t: labState.t,
            units: model.units.length,
            statics: model.statics.length,
            deaths: model.deaths.length,
            startLocs: model.startLocs.length,
            bases: model.bases.length,
            playing,
            speed,
            icons: iconsLoaded,
            tech: { ...lastTech },
            apm: { 1: apmAt(1, labState.t), 2: apmAt(2, labState.t) },
            losses: {
              1: model.lossByPid[1].filter((u) => u.d <= labState.t).length,
              2: model.lossByPid[2].filter((u) => u.d <= labState.t).length,
            },
            hud: { ...hudOpts },
            iso,
          }
        : null;
    },
  };
}
