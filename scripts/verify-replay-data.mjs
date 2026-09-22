// ReplayData 金标准验收：与 tests/baseline/ 的旧链路快照（sc2reader 1.9.0 + spawningtool 3.0.0）
// 做**字段级 diff**，覆盖整个 `ReplayData`。比 `verify-build-order.mjs`（只管 build_order）更宽，
// 两者互补，都要跑。
//
// 用法：
//   node scripts/verify-replay-data.mjs                 # 全部样本
//   node scripts/verify-replay-data.mjs CN_ZVP          # 按子串过滤样本名
//   node scripts/verify-replay-data.mjs --show-diff 8   # 每个失败字段多打几行
//   node scripts/verify-replay-data.mjs --measure       # 实测 ±1 起点差条目数，不判成败
//
// ## 为什么基准是旧链路而不是官方 s2protocol
//
// P1b（协议解码）能用官方 s2protocol 做可复现金标准；P1c（组装）不行 —— 它的输出形状是
// sc2reader + spawningtool 两个**第三方库**叠出来的，官方没有对应的东西。所以先在
// `scripts/freeze-baseline.py` 把旧链路输出冻结成 JSON，再拿本脚本对拍。基线生成后，
// 本脚本不再依赖 Python 运行时。
//
// ## 两趟跑，缺一不可
//
// `extractReplayData` 有两个 build_order 口径（`exactZergStart`），必须分别对待：
//
// **第 1 趟 —— parity 口径（`exactZergStart: false`）对基线，要求逐条精确相等。**
// 这是「组装是否正确」的主判据。不在这一趟放宽任何数值：`unit` / `is_worker` / `supply` /
// `start_time` 全部精确比。放宽容差只会掩盖真 regression。
//
// **第 2 趟 —— 发布口径（`exactZergStart: true`）对第 1 趟，只允许起点 ±1 秒。**
// 虫族改成靠 Egg tag 回溯精确起点后，与查表口径会有秒级取整差（`hero` 的 557 条 Egg 命中
// 就是这条路径）。这趟证明「发布口径与基线口径是同一组单位、只差取整」，
// 并把 ±1 的**条数**钉死在 `START_TIME_FINGERPRINT` 里 —— 数量一变就报红。
//
// 两趟串起来 ⇒ 发布口径 == 基线（模掉那些已定量的取整差）。
//
// ## build_order 的比较方式（踩过的坑）
//
// 1. **recall 行单独按多重集比**。基线把星空加速行 `append` 在末尾
//    （旧链路 `tools/baseline/parse_script.py`，README `build-260412` 记为 bug），我们按帧有序插入 —— 位置不可比。
// 2. **非 recall 行先做 LCS 对齐，再逐对比较**。因为幻象单位只在某一侧出现，下标对齐会整体错位。
//    ⚠️ LCS 在「两侧同多重集但顺序不同」时会把最优公共子序列压短，于是把本该配上的条目报成
//    「缺 + 多」。所以**绝不能把 recall 混进待对齐序列**（首版就这么踩的：hero 两侧单位多重集
//    完全一致 666 vs 666，却报了 29 处缺/多）。复盘：LCS 只能用于「顺序基本一致、只多/少几条」
//    的场景，不能用来兜位置整体漂移。
// 3. **数值按 Number 比、对象按键集合比**。Python 的 `//` 产出 `118.0`、`json.dump(sort_keys=True)`
//    的键序，与 JS 的 `118`、插入序不同；按文本比会得到一堆假失败。
//
// ## 已知偏离（白名单，逐条计数 + 形状断言，多一条就红）
//
// | 录像 | 字段 | 偏离 | 处置 |
// | ---- | ---- | ---- | ---- |
// | `CN_PVT_T-AI` | `players[].build_order` | 该录像 `m_cooperative=true`，spawningtool 把 `coop_constants` 的时长覆盖到 LotV 表上；我们始终用 LotV 表 | 只看形状：条目数 + 单位多重集 + recall 条数；`start_time`/`supply` 不比 |
// | `US_TVP` | `players[Shameless].build_order` | 我们多 1 条**幻象 Phoenix**（spawningtool 靠 `unit.hallucinated` 过滤，该标记依赖 `SSelectionDeltaEvent` 的有状态时序） | 对齐后只允许「多出**恰好**指定条数」，且必须命中 |
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_DIR = join(REPO, "sampleTest");
const BASELINE_DIR = join(REPO, "tests", "baseline");

const argv = process.argv.slice(2);
const showDiffIdx = argv.indexOf("--show-diff");
const SHOW_DIFF = showDiffIdx === -1 ? 4 : Number(argv[showDiffIdx + 1]) || 4;
const MEASURE = argv.includes("--measure");
const filters = argv.filter((a, i) => !a.startsWith("--") && i !== showDiffIdx + 1);

// ---- 装配被测实现 ---------------------------------------------------------

const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();
const { extractReplayData } = await import(join(REPO, "js/worker/decoder/replay_data.js"));

// ---- 工具 -----------------------------------------------------------------

/** 与 `scripts/freeze-baseline.py::safe_name` 逐字一致。 */
const safeName = (name) => name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 从 `players[0](Reynor)` 取 `Reynor`。 */
const playerOf = (prefix) => prefix.match(/\((.+)\)$/)?.[1];

/**
 * 递归收集差异。返回 `{path, expected, actual}[]`。
 *
 * 数值一律走 `===`（Number 语义），所以 `118` 与 `118.0` 相等。
 * `null` / `undefined` 视为等价 —— JSON 里没有 undefined，而 JS 可选字段常是 undefined。
 */
function diff(expected, actual, path, out) {
  if (out.length >= 400) return out;

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      diff(expected[key], actual[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
      return out;
    }
    for (let i = 0; i < expected.length; i += 1) {
      diff(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return out;
  }

  const bothNullish =
    (expected === null || expected === undefined) && (actual === null || actual === undefined);
  if (bothNullish) return out;

  if (typeof expected === "number" && typeof actual === "number") {
    if (expected !== actual) out.push({ path, expected, actual });
    return out;
  }

  if (expected !== actual) out.push({ path, expected, actual });
  return out;
}

/**
 * 按 `unit` 名做 LCS 对齐。返回 `{pairs: [[ei, ai]], onlyExpected, onlyActual}`。
 *
 * ⚠️ **调用前必须剔除 recall 行**（理由见文件头注释第 2 点）。
 * 规模：最长约 1000 条，DP 表 1e6 格，可接受。
 */
function alignByUnit(expectedRows, actualRows) {
  const n = expectedRows.length;
  const m = actualRows.length;

  // dp[i][j] = expected[i..] 与 actual[j..] 的 LCS 长度
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        expectedRows[i].unit === actualRows[j].unit
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs = [];
  const onlyExpected = [];
  const onlyActual = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expectedRows[i].unit === actualRows[j].unit) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      onlyExpected.push(i);
      i += 1;
    } else {
      onlyActual.push(j);
      j += 1;
    }
  }
  while (i < n) onlyExpected.push(i++);
  while (j < m) onlyActual.push(j++);
  return { pairs, onlyExpected, onlyActual };
}

/** 多重集计数，元素用 `JSON.stringify` 规范化（键排序，免受键序影响）。 */
function tally(rows) {
  const m = new Map();
  for (const row of rows) {
    const k = JSON.stringify(row, Object.keys(row).sort());
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function tallyDiff(expected, actual) {
  const e = tally(expected);
  const a = tally(actual);
  const out = [];
  for (const k of new Set([...e.keys(), ...a.keys()])) {
    if ((e.get(k) ?? 0) !== (a.get(k) ?? 0)) {
      out.push({ key: k, expected: e.get(k) ?? 0, actual: a.get(k) ?? 0 });
    }
  }
  return out;
}

// ---- 白名单 / 指纹 --------------------------------------------------------

/**
 * `CN_PVT_T-AI` 的 `build_order` 只比形状。
 *
 * 该录像 `m_cooperative = true`，spawningtool 走 `coop_constants`；我们**始终**用 LotV 表
 * （这是要发布的行为，见 `verify-build-order.mjs`）。时长因此整体不同，
 * 但「造了哪些单位、按什么顺序」必须一致 —— 形状断言就是在守这条。
 */
const SHAPE_ONLY_BUILD_ORDER = new Set(["CN_PVT_T-AI.SC2Replay"]);

/**
 * 形状模式下基线侧的单位名改写：`录像 → [[基线名, 我们的名]]`。
 *
 * `CN_PVT` 走 `coop_constants` 时 `Adept` 查不到时长，spawningtool 把它印成
 * `"Adept (Error on build time)"`（`parser.py` 的兜底串）。我们始终用 LotV 表，
 * 永远不会产出这种串 —— 比形状前先归一化。
 */
const BASELINE_UNIT_RENAMES = {
  "CN_PVT_T-AI.SC2Replay": [["Adept (Error on build time)", "Adept"]],
};

/**
 * 幻象单位豁免：`录像 → { 玩家名: { 单位名: 允许多出的条数 } }`。
 *
 * 判据同 `verify-build-order.mjs`：只允许「多出」，且**必须恰好**命中条数
 * （少摘或多摘都报红，防止白名单过期后静默放过）。
 */
const EXTRA_UNITS = {
  "US_TVP.SC2Replay": { Shameless: { Phoenix: 1 } },
};

/**
 * 第 2 趟（发布口径 vs parity 口径）的指纹。
 *
 * `delta1` = 起点差恰为 1 秒的条目数（机制量见 `verify-build-order.mjs` 的
 * `DEFAULT_MODE_FINGERPRINT.eggLinked`：CN_ZVP 16 / hero 557 / 其余 0）。
 * `supplyChanged` = 因起点挪动而换了 supply 采样点的条目数（见比对函数注释第 2 点）。
 *
 * 两个数都是**实测出来的、可解释的**，写死在这里等于给「起点口径」上了锁：
 * 任何漂移（比如 Egg 回溯失效、时长表被换）都会让这两个数先变。
 */
const START_TIME_FINGERPRINT = {
  "CN_PVT_T-AI.SC2Replay": { delta1: 0, supplyChanged: 0 },
  "CN_ZVP.SC2Replay": { delta1: 1, supplyChanged: 0 },
  "US_TVP.SC2Replay": { delta1: 0, supplyChanged: 0 },
  "US_TVR(T)_2018_old.SC2Replay": { delta1: 0, supplyChanged: 0 },
  "hero(w) vs reynor g1 winter madness(PVZ).SC2Replay": { delta1: 140, supplyChanged: 15 },
};

// ---- 比对：build_order ----------------------------------------------------

/**
 * 第 1 趟：基线 `e` vs parity 口径 `a` 的 `build_order` 比对。
 *
 * **全程精确**，不打任何数值折扣：`unit` / `is_worker` / `supply` / `start_time` 都要相等。
 * 想放宽先想清楚 —— 这里放宽容差就等于让真 regression 溜过去。
 */
function compareBuildOrder(e, a, replayName, prefix, problems, notes) {
  const shapeOnly = SHAPE_ONLY_BUILD_ORDER.has(replayName);
  const stats = { delta1: 0, exact: 0 };

  // recall 行位置不可比（基线 append 在末尾 / 我们按帧插入）→ 一律先摘出来按多重集比。
  const eRecalls = e.filter((r) => r._kind === "recall");
  const aRecalls = a.filter((r) => r._kind === "recall");
  const eUnits = e.filter((r) => r._kind !== "recall");
  const aUnits = a.filter((r) => r._kind !== "recall");

  if (shapeOnly) {
    if (e.length !== a.length) {
      problems.push(`${prefix}.build_order.length 期望 ${e.length}，实得 ${a.length}`);
      return stats;
    }
    const renames = new Map(BASELINE_UNIT_RENAMES[replayName] ?? []);
    const ms = tallyDiff(
      eUnits.map((r) => ({ u: renames.get(r.unit) ?? r.unit, w: r.is_worker })),
      aUnits.map((r) => ({ u: r.unit, w: r.is_worker })),
    );
    for (const m of ms.slice(0, SHOW_DIFF)) {
      problems.push(`${prefix}.build_order 形状不一致 ${m.key} 期望 ${m.expected} 条，实得 ${m.actual} 条`);
    }
    if (eRecalls.length !== aRecalls.length) {
      problems.push(`${prefix}.build_order recall 条数期望 ${eRecalls.length}，实得 ${aRecalls.length}`);
    }
    if (ms.length === 0 && eRecalls.length === aRecalls.length) TOTALS.shapeOnlyBuildOrder += 1;
    return stats;
  }

  // ---- recall 行：多重集 ----
  for (const m of tallyDiff(eRecalls, aRecalls)) {
    problems.push(`${prefix}.build_order(recall) ${m.key} 期望 ${m.expected} 条，实得 ${m.actual} 条`);
  }
  if (eRecalls.length > 0 || aRecalls.length > 0) {
    TOTALS.recallRowsCompared += 1;
    TOTALS.recallRowsMatched += Math.min(eRecalls.length, aRecalls.length);
  }

  // ---- 非 recall 行：LCS 对齐后逐对比较 ----
  const allowances = { ...(EXTRA_UNITS[replayName]?.[playerOf(prefix)] ?? {}) };
  const { pairs, onlyExpected, onlyActual } = alignByUnit(eUnits, aUnits);

  for (const idx of onlyExpected) {
    problems.push(`${prefix}.build_order 缺条目：${JSON.stringify(eUnits[idx])}`);
  }

  const spare = { ...allowances };
  for (const idx of onlyActual) {
    const row = aUnits[idx];
    const left = spare[row.unit] ?? 0;
    if (left === 0) {
      problems.push(`${prefix}.build_order 多条目：${JSON.stringify(row)}`);
      continue;
    }
    spare[row.unit] = left - 1;
  }
  for (const [unit, left] of Object.entries(spare)) {
    if (left !== 0) {
      problems.push(
        `${prefix}.build_order 幻象豁免期望摘掉 ${allowances[unit]} 条 ${unit}，实得 ${allowances[unit] - left} 条 —— 白名单过期了`,
      );
    } else {
      TOTALS.extraUnitsRemoved += allowances[unit];
      notes.push(`${prefix} 豁免幻象 ${unit} x${allowances[unit]}`);
    }
  }

  for (const [ei, ai] of pairs) {
    const er = eUnits[ei];
    const ar = aUnits[ai];
    if (er.is_worker !== ar.is_worker) {
      problems.push(`${prefix}.build_order[${ei}](${er.unit}) is_worker 期望 ${er.is_worker}，实得 ${ar.is_worker}`);
      continue;
    }
    if (er.supply !== ar.supply) {
      problems.push(
        `${prefix}.build_order[${ei}](${er.unit}) supply 期望 ${JSON.stringify(er.supply)}，实得 ${JSON.stringify(ar.supply)}`,
      );
      TOTALS.supplyDiff += 1;
    }
    if (er.start_time === ar.start_time) {
      stats.exact += 1;
    } else {
      problems.push(
        `${prefix}.build_order[${ei}](${er.unit}) start_time 期望 ${er.start_time}，实得 ${ar.start_time}`,
      );
    }
  }

  // 有序插入断言：我们整体按 start_time 非递减；基线不是（recall 是 append 的）。
  for (let k = 1; k < a.length; k += 1) {
    if (a[k].start_time < a[k - 1].start_time) {
      problems.push(`${prefix}.build_order[${k}] 未按 start_time 非递减 —— 有序插入被破坏`);
      break;
    }
  }
  if (!e.every((r, k) => k === 0 || r.start_time >= e[k - 1].start_time)) TOTALS.recallReordered += 1;

  notes.push(
    `${prefix} build_order ${a.length} 条（单位 ${aUnits.length}：精确 ${stats.exact} / ±1 秒 ${stats.delta1}；recall ${aRecalls.length}）`,
  );
  return stats;
}

// ---- 比对：整份 ReplayData -------------------------------------------------

const TOTALS = {
  replays: 0,
  leafAssertions: 0,
  problems: 0,
  shapeOnlyBuildOrder: 0,
  extraUnitsRemoved: 0,
  recallRowsCompared: 0,
  recallRowsMatched: 0,
  recallReordered: 0,
  supplyDiff: 0,
  shippingDelta1: 0,
  shippingSupplyChanged: 0,
};

const MEASURED = new Map();

function countLeafFields(value) {
  if (Array.isArray(value)) return value.reduce((n, v) => n + countLeafFields(v), 0);
  if (isPlainObject(value)) return Object.values(value).reduce((n, v) => n + countLeafFields(v), 0);
  return 1;
}

/**
 * 第 2 趟专用：发布口径（`exactZergStart: true`）对 parity 口径的 `build_order` 比对。
 *
 * ## 两趟之间到底什么会变（实测结论，别看直觉）
 *
 * `exactZergStart` 改的是**虫族单位的起点帧**（Egg `SUnitInitEvent` vs `出生帧 − 数据表时长`）。
 * 连带影响有两处，都**不是** bug：
 *
 * 1. `start_time`：会变，且差值不限于 1 秒（查表时长本身是四舍五入过的）。
 * 2. `supply`：**会变**。`build_order.ts` 里 supply 是在条目**自己的起点帧**上采样的
 *    （Egg 路径 `supply.at(pid, eggFrame)`，其余路径 `supply.at(pid, adjusted.startFrame)`），
 *    起点一挪，采样点就挪。所以「同一条目」在这两趟里 supply 可能不同，且**不能**按
 *    `unit|supply` 分桶 —— 一分桶就会出现「桶数量不同」的假象（首版实测：hero 报出
 *    9 个桶数量不同，其实只是 supply 重分布）。
 *
 * ## 因此判据只保留真正不变的东西
 *
 * - **条目数相同**、**逐单位名（含 `is_worker`）的条数相同** ← 这就是「同一组单位」这句话的定式化。
 * - 同单位内**按起点排序后逐位配对**，`|Δ| ≤ 1` 秒（`verify-build-order.mjs` 说的「秒级取整差」）。
 * - 两趟各自都整体按起点非递减。
 *
 * 逐位配对而不是最近邻匹配：同单位的起点在两侧都是单调的，按序配对上号即可，
 * 不需要猜「哪条对哪条」。数量不等时直接报，不做任何兜底。
 */
function compareShippingBuildOrder(parityRows, shippingRows, prefix, problems) {
  const stats = { matched: 0, delta1: 0, supplyChanged: 0, maxAbs: 0, supplySamples: [] };
  if (parityRows.length !== shippingRows.length) {
    problems.push(`${prefix}.build_order.length parity ${parityRows.length} vs 发布口径 ${shippingRows.length}`);
    return stats;
  }

  // recall 行不受 `exactZergStart` 影响，理应逐字相同（合并规则也相同，位置一致）。
  const pRecalls = parityRows.filter((r) => r._kind === "recall");
  const sRecalls = shippingRows.filter((r) => r._kind === "recall");
  for (const m of tallyDiff(pRecalls, sRecalls)) {
    problems.push(`${prefix}.build_order(recall) ${m.key} parity ${m.expected} 条 vs 发布口径 ${m.actual} 条`);
  }

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (r._kind === "recall") continue;
      const key = `${r.unit}\u0000${r.is_worker}`;
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    for (const arr of m.values()) arr.sort((x, y) => x.start_time - y.start_time);
    return m;
  };
  const pg = group(parityRows);
  const sg = group(shippingRows);

  for (const key of new Set([...pg.keys(), ...sg.keys()])) {
    const label = key.split("\u0000").join("|");
    const xs = pg.get(key) ?? [];
    const ys = sg.get(key) ?? [];
    if (xs.length !== ys.length) {
      problems.push(`${prefix}.build_order 单位条数不同 ${label}：parity ${xs.length} 条 vs 发布口径 ${ys.length} 条`);
      continue;
    }
    for (let i = 0; i < xs.length; i += 1) {
      const d = Math.abs(ys[i].start_time - xs[i].start_time);
      if (d === 0) {
        stats.matched += 1;
      } else if (d === 1) {
        stats.matched += 1;
        stats.delta1 += 1;
      } else {
        problems.push(
          `${prefix}.build_order ${label}[${i}] 起点差 ${d} 秒（parity ${xs[i].start_time} / 发布口径 ${ys[i].start_time}）—— 超过 1 秒`,
        );
      }
      if (d > stats.maxAbs) stats.maxAbs = d;
      if (xs[i].supply !== ys[i].supply) {
        // 起点挪动 → supply 采样点跟着挪，这是**预期行为**（见函数注释第 2 点），不是失败。
        // 只计数、交给指纹核对；顺带留一份明细方便人看。
        stats.supplyChanged += 1;
        stats.supplySamples.push(`${label}[${i}] @${xs[i].start_time}→${ys[i].start_time}: supply ${xs[i].supply}→${ys[i].supply}`);
      }
    }
  }

  // 两趟都必须整体按 start_time 非递减。
  for (const [tag, rows] of [
    ["parity", parityRows],
    ["发布口径", shippingRows],
  ]) {
    for (let k = 1; k < rows.length; k += 1) {
      if (rows[k].start_time < rows[k - 1].start_time) {
        problems.push(`${prefix}.build_order ${tag}[${k}] 未按 start_time 非递减`);
        break;
      }
    }
  }

  return stats;
}
/**
 * 第 1 趟：`expected`（基线）vs `actual`（parity 口径）。
 * 返回 `{problems, notes, perPlayer: Map<玩家名, 该玩家的 build_order 单位行>}`。
 */
function comparePlayers(expected, actual, replayName, problems, notes, perPlayer) {
  if (expected.length !== actual.length) {
    problems.push(`players.length 期望 ${expected.length}，实得 ${actual.length}`);
    return;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (e.name !== a.name) {
      problems.push(`players[${i}].name 期望 ${JSON.stringify(e.name)}，实得 ${JSON.stringify(a.name)}`);
      continue;
    }
    const prefix = `players[${i}](${e.name})`;
    compareBuildOrder(e.build_order, a.build_order, replayName, prefix, problems, notes);
    perPlayer?.set(e.name, a.build_order);

    for (const field of ["name", "race", "stats", "worker_deaths", "workers_curve"]) {
      for (const item of diff(e[field], a[field], `${prefix}.${field}`, [])) {
        problems.push(`${item.path} 期望 ${JSON.stringify(item.expected)}，实得 ${JSON.stringify(item.actual)}`);
      }
    }
  }
}

function compareReplay(replayName, actual) {
  const baselinePath = join(BASELINE_DIR, `${safeName(replayName)}.json`);
  let expected;
  try {
    expected = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return { skipped: true, reason: `缺少基线 ${baselinePath}` };
  }

  const problems = [];
  const notes = [];
  const perPlayer = new Map();

  for (const field of ["map_name", "game_length", "client_version", "region", "start_time", "winner", "chat"]) {
    for (const item of diff(expected[field], actual[field], field, [])) {
      problems.push(`${item.path} 期望 ${JSON.stringify(item.expected)}，实得 ${JSON.stringify(item.actual)}`);
    }
  }

  if (expected.teams.length !== actual.teams.length) {
    problems.push(`teams.length 期望 ${expected.teams.length}，实得 ${actual.teams.length}`);
  } else {
    for (let i = 0; i < expected.teams.length; i += 1) {
      comparePlayers(expected.teams[i].players, actual.teams[i].players, replayName, problems, notes, perPlayer);
    }
  }

  TOTALS.leafAssertions +=
    Object.entries(expected)
      .filter(([k]) => k !== "teams")
      .reduce((n, [, v]) => n + countLeafFields(v), 0) +
    expected.teams.reduce((n, t) => n + t.players.reduce((m, p) => m + countLeafFields(p), 0), 0);

  return { problems, notes, perPlayer };
}

/**
 * 第 2 趟：发布口径（`exactZergStart: true`）对 parity 口径，只允许 `start_time` ±1。
 *
 * 因为 baseline 在 parity 口径下已逐条对上，这趟等于把发布口径也接上了基线。
 * 返回 `{problems, delta1}`。
 */
function compareShippingVsParity(replayName, parity, shipping) {
  const problems = [];
  const supplySamples = [];
  let delta1 = 0;
  let supplyChanged = 0;

  for (const field of ["map_name", "game_length", "client_version", "region", "start_time", "winner", "chat"]) {
    for (const item of diff(parity[field], shipping[field], field, [])) {
      problems.push(`[发布口径] ${item.path} 与 parity 口径不一致：${JSON.stringify(item.expected)} vs ${JSON.stringify(item.actual)}`);
    }
  }

  if (parity.teams.length !== shipping.teams.length) {
    problems.push(`[发布口径] teams.length ${parity.teams.length} vs ${shipping.teams.length}`);
    return { problems, delta1, supplyChanged, supplySamples };
  }

  for (let t = 0; t < parity.teams.length; t += 1) {
    const ep = parity.teams[t].players;
    const es = shipping.teams[t].players;
    if (ep.length !== es.length) {
      problems.push(`[发布口径] team${t}.players.length ${ep.length} vs ${es.length}`);
      continue;
    }
    for (let p = 0; p < ep.length; p += 1) {
      const prefix = `[发布口径] players[${p}](${ep[p].name})`;
      // 只有 build_order 会受 `exactZergStart` 影响，其余字段必须逐字相同。
      for (const field of ["name", "race", "stats", "worker_deaths", "workers_curve"]) {
        for (const item of diff(ep[p][field], es[p][field], `${prefix}.${field}`, [])) {
          problems.push(`${item.path} parity vs 发布口径不一致：${JSON.stringify(item.expected)} vs ${JSON.stringify(item.actual)}`);
        }
      }
      // build_order：两侧都是我们自己的输出，所以不放任何业务白名单，
      // 只按「同单位分组 → 起点差 ≤1 秒」比对（见该函数注释）。
      const stats = compareShippingBuildOrder(ep[p].build_order, es[p].build_order, prefix, problems);
      delta1 += stats.delta1;
      supplyChanged += stats.supplyChanged;
      for (const s of stats.supplySamples) supplySamples.push(`${ep[p].name} ${s}`);
    }
  }

  // 指纹：±1 与 supply 变化数都必须恰好等于登记值（measure 模式只报不判）。
  const fp = START_TIME_FINGERPRINT[replayName];
  if (fp && !MEASURE) {
    if (fp.delta1 !== delta1) {
      problems.push(
        `[发布口径] 起点差 1 秒的条目数期望 ${fp.delta1}，实得 ${delta1} —— Egg 精确起点口径变了`,
      );
    }
    if (fp.supplyChanged !== supplyChanged) {
      problems.push(
        `[发布口径] 因起点挪动而改变 supply 的条目数期望 ${fp.supplyChanged}，实得 ${supplyChanged}`,
      );
    }
  }
  return { problems, delta1, supplyChanged, supplySamples };
}

// ---- 主流程 ---------------------------------------------------------------

const replays = readdirSync(SAMPLE_DIR)
  .filter((f) => f.toLowerCase().endsWith(".sc2replay"))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort();

if (replays.length === 0) {
  console.error(`❌ 没有匹配的录像（sampleTest/，过滤 ${JSON.stringify(filters)}）`);
  process.exit(1);
}

const decompressor = createWasmDecompressor();
console.log(
  `ReplayData 字段级对拍　样本 ${replays.length} 个　基线 tests/baseline/*.json` +
    (MEASURE ? "\n[measure 模式：只跑第 2 趟数 ±1 条数，不判成败]" : "") +
    "\n",
);

const rows = [];
for (const name of replays) {
  const buffer = new Uint8Array(readFileSync(join(SAMPLE_DIR, name)));
  const started = Date.now();

  let parity;
  let shipping = null;
  try {
    parity = await extractReplayData(buffer, { decompressor, exactZergStart: false });
    shipping = await extractReplayData(buffer, { decompressor, exactZergStart: true });
  } catch (error) {
    TOTALS.problems += 1;
    rows.push({ name, status: "ERROR" });
    console.log(`❌ ${name}\n   运行失败：${error?.message ?? error}`);
    continue;
  }
  const ms = Date.now() - started;

  const compared = compareReplay(name, parity);
  if (compared.skipped) {
    rows.push({ name, status: "SKIP" });
    console.log(`⏭️  ${name}  ${compared.reason}`);
    continue;
  }

  const ship = compareShippingVsParity(name, parity, shipping);
  TOTALS.shippingDelta1 += ship.delta1;
  TOTALS.shippingSupplyChanged += ship.supplyChanged;
  MEASURED.set(name, { delta1: ship.delta1, supplyChanged: ship.supplyChanged });

  const problems = [...compared.problems, ...ship.problems];
  TOTALS.replays += 1;
  if (!MEASURE) for (const n of compared.notes) console.log(`     ℹ ${n}`);
  console.log(
    `     ↳ 发布口径：起点差 1 秒 ${ship.delta1} 条 / supply 随起点变化 ${ship.supplyChanged} 条　${fingerprintText(name, ship)}`,
  );
  if (!MEASURE && ship.supplySamples.length > 0) {
    console.log(`     ↳ supply 明细（起点挪动的连带效应，${ship.supplySamples.length} 条）：`);
    for (const s of ship.supplySamples) console.log(`         ${s}`);
  }

  if (problems.length === 0) {
    rows.push({ name, status: "PASS" });
    console.log(`✅ ${name}  (${ms}ms，两趟都过)`);
  } else {
    TOTALS.problems += problems.length;
    rows.push({ name, status: "FAIL", count: problems.length });
    console.log(`❌ ${name}  ${problems.length} 处差异  (${ms}ms)`);
    for (const p of problems.slice(0, SHOW_DIFF)) console.log(`     · ${p}`);
    if (problems.length > SHOW_DIFF) {
      console.log(`     … 另有 ${problems.length - SHOW_DIFF} 处（--show-diff N 看更多）`);
    }
  }
}

function fingerprintText(name, stats) {
  const fp = START_TIME_FINGERPRINT[name];
  if (!fp) return "（未登记指纹）";
  if (MEASURE) return "（measure）";
  const ok = fp.delta1 === stats.delta1 && fp.supplyChanged === stats.supplyChanged;
  return ok ? `指纹 ${fp.delta1}/${fp.supplyChanged} ✓` : `指纹期望 ${fp.delta1}/${fp.supplyChanged} ✗`;
}

// ---- 汇总 -----------------------------------------------------------------

console.log("\n" + "─".repeat(84));
console.log(`  样本              ${TOTALS.replays} 个（跳过 ${rows.filter((r) => r.status === "SKIP").length}）`);
console.log(`  字段级断言        ~${TOTALS.leafAssertions} 个叶值（第 1 趟，parity 口径 vs 基线）`);
console.log(`  失败               ${TOTALS.problems}`);
console.log(`  形状白名单        CN_PVT build_order 形状比对通过 ${TOTALS.shapeOnlyBuildOrder} 次 / 期望 2`);
console.log(`  幻象豁免          摘除 ${TOTALS.extraUnitsRemoved} 条`);
console.log(`  supply 差异       ${TOTALS.supplyDiff} 条（第 1 趟要求 0）`);
console.log(
  `  recall 行         ${TOTALS.recallRowsCompared} 个玩家比对过（共 ${TOTALS.recallRowsMatched} 行）；基线乱序的 ${TOTALS.recallReordered} 个已改为有序插入`,
);
console.log(`  发布口径 ±1 秒    ${TOTALS.shippingDelta1} 条；supply 随起点变化 ${TOTALS.shippingSupplyChanged} 条（逐录像指纹见上）`);
console.log("─".repeat(84));

if (MEASURE) {
  console.log("\n实测值（用于更新 START_TIME_FINGERPRINT）：");
  for (const name of replays) {
    const got = MEASURED.get(name);
    if (got) console.log(`  ${JSON.stringify(name)}: { delta1: ${got.delta1}, supplyChanged: ${got.supplyChanged} },`);
  }
  console.log("\n（measure 模式不判成败）");
  process.exit(0);
}

if (TOTALS.problems > 0) {
  console.log("\n❌ ReplayData 与旧链路基线不一致");
  process.exit(1);
}
console.log("\n✅ ReplayData 与旧链路基线一致（白名单内偏离已逐条计数，发布口径已二次复核）");
