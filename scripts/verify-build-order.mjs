// build_order 金标准验收：与 tests/baseline/ 的旧链路快照（sc2reader 1.9.0 + spawningtool 3.0.0）
// 逐条对拍。
//
// 用法：node scripts/verify-build-order.mjs [录像名...]
//
// ## 判据
//
// 旧链路是**参照物**，不是真理。以下两类差异**已知且有意**，不判失败，但会逐条报数，
// 并断言「偏差恰好就是这些」—— 多一条都要报红，防止静默劣化：
//
//   1. `CN_PVT_T-AI.SC2Replay`（scope=replay）：该录像 `m_gameOptions.m_cooperative` 真的是
//      `true`，spawningtool 因此把 `coop_constants.py` 里的 BO_EXCLUDED / BUILD_TIMES 覆盖到
//      `lotv_constants` 之上（Marine 18s vs 25s，SCV 12s vs 17s，Adept 直接查不到 →
//      `(Error on build time)`）。我们**始终**用 LotV 表 —— 有意的偏离。
//      形状断言：条目数不变 + 单位名多重集不变（仅允许 `Adept (Error on build time)` ↔ `Adept`）。
//      通过即证明这是**纯时长偏差**，没有增删单位。
//   2. `US_TVP.SC2Replay / Shameless`（scope=player）：我们多 1 条**幻象 Phoenix**。
//      spawningtool 靠 sc2reader 的 `unit.hallucinated` 过滤幻象，而该标记来自
//      `SSelectionDeltaEvent` 的 subgroup flags（`context.py:139`）—— 依赖选择事件时序的
//      有状态量。我们的协议表把 `m_unitTypeName` 折成字符串，幻象与真单位同名，无法区分。
//      形状断言：缺条目为 0，多出条目**恰好**是允许列表里的单位。
//
// 其余玩家必须**逐条完全一致**（`unit` + `start_time` + `is_worker` 三重集相等，且顺序一致）。
//
// ## 跑两种模式
//
// 逐条对拍跑的是 **parity 模式**（`exactZergStart: false`，虫族也一律查表），口径迁就旧链路，
// 便于对齐。要发布的是 **默认模式**（`exactZergStart: true`，虫族靠 Egg tag 回溯取精确起点）。
// 两者必须产出同一组单位，只允许起点有秒级取整差；Egg 命中数另用指纹钉住。
//
// ## baseBuild 取值的坑
//
// baseBuild 在 **`header.m_version.m_baseBuild`**，不在 `header` 顶层。取错会得 `NaN`，
// 而 `expansionFromBaseBuild(NaN)` 静默回落到 `"WoL"`，让 `chronoModel` 的两个 LotV 窗口判定
// 全部失效 —— **且样本录像全在窗口外，跑样本永远测不出来**。故这里用 `probeBaseBuild()` 作为
// 唯一取值来源，并断言与 `header.m_version.m_baseBuild` 一致；模型选择矩阵另做独立自测。
//
// ## 排除表的正确语义（易踩）
//
// `lotv_constants.BO_EXCLUDED`（含 `Overseer`）只作用于 `add_unit_born_event` /
// `add_unit_init_event`（`parser.py:605,643`）；`add_change_event`（UnitTypeChangeEvent，
// 变形）走的是**另一张** `BO_CHANGED_EXCLUDED`（`parser.py:702`）。所以 `Overseer` 由
// `Overlord→Overseer` 变形产出时**必须保留**，而 `WarpPrism` / `SiegeTank` 等
// BO_CHANGED_EXCLUDED 成员若从 born/init 路径产出也**必须保留**。断言据此写成双向。
//
// ## recall 行（星空加速）已纳入比对
//
// 此前整段排除（`TOTALS.recallSkipped`），现在纳入。要点：
//
// 1. **能力 link 必须按 datapack 区间取**。`m_abilLink` 随补丁漂移，跨版本并集会让
//    US_TVP 那 3 条 `NexusMassRecall`（link 724）被判成时空加速。这里既跑 `abilityLinksForBuild`
//    的边界矩阵自测，也对每张录像断言解析出的集合（`ABILITY_LINKS_FINGERPRINT`）。
// 2. **查询键是 `header.m_version.m_build`**，不是 `m_baseBuild`（sc2reader 的
//    `replay.build = versions[4]`）。样本里两者相等，但语义不同。
// 3. **位置是已声明偏差**：基线把 recall 行 `append` 在 `build_order` 末尾
//    （旧链路 `tools/baseline/parse_script.py` 的 recall 追加段，README `build-260412` 已记为 bug），
//    我们按帧有序插入。
//    所以比对用多重集，**位置检查只看非 recall 行**；另加一条「整体按帧非递减」的断言
//    来钉住「有序插入」这个改进本身。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_DIR = join(REPO, "sampleTest");
const BASELINE_DIR = join(REPO, "tests", "baseline");

const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();
const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { probeBaseBuild, selectProtocolTables } = await import(
  join(REPO, "js/worker/decoder/protocols/index.js")
);
const {
  decodeReplayHeader,
  decodeReplayDetails,
  decodeReplayInitData,
  decodeReplayGameEvents,
  decodeReplayTrackerEvents,
} = await import(join(REPO, "js/worker/decoder/events.js"));
const { extractBuildOrder, collectTagToUnitName } = await import(
  join(REPO, "js/worker/decoder/build_order.js")
);
const {
  chronoModel,
  expansionFromBaseBuild,
  expansionFromDetails,
  userIdToPlayerId,
  unixTimestampFromDetails,
  isCooperative,
  collectChronoBoosts,
} = await import(join(REPO, "js/worker/decoder/chrono.js"));
const { abilityLinksForBuild } = await import(
  join(REPO, "js/worker/decoder/data/ability_links.generated.js")
);
const { collectRecalls, mergeRecalls, isRecallRow } = await import(
  join(REPO, "js/worker/decoder/recall.js")
);
const { EXCLUDED_UNITS, CHANGED_EXCLUDED_UNITS } = await import(
  join(REPO, "js/worker/decoder/data/build_times.generated.js")
);

const dec = new TextDecoder();
const txt = (v) => (v instanceof Uint8Array ? dec.decode(v) : String(v ?? ""));
const safe = (n) => n.replace(/[^A-Za-z0-9_.-]+/g, "_");
/** sc2reader 会剥掉 `<战队><sp/>原名` 前缀，基线是它产的，必须同样归一化。 */
const normalizeName = (raw) => {
  const i = raw.lastIndexOf("<sp/>");
  return i >= 0 ? raw.slice(i + 5) : raw;
};

/**
 * 已登记的偏差。故意写成白名单 + 精确形状断言：偏差**必须**恰好是这个样子，多一条就报红。
 *   scope="replay" → 该录像所有玩家；
 *   scope="player" → 只有 `players` 里列出的玩家，其余玩家仍走严格判据。
 */
const DEVIATIONS = {
  "CN_PVT_T-AI.SC2Replay": {
    kind: "coop-constants",
    scope: "replay",
    /** 该录像的 `m_gameOptions.m_cooperative`；用来证明偏差前提仍然成立。 */
    expectCooperative: true,
    /** 基线侧名字改写（coop 表查不到时长 → spawningtool 印 error 串）。 */
    renameBaselineUnits: [["Adept (Error on build time)", "Adept"]],
  },
  "US_TVP.SC2Replay": {
    kind: "hallucinated-unit",
    scope: "player",
    /** 玩家名 → 允许「只在我们的结果里」出现的单位名列表。 */
    players: { Shameless: { allowExtra: ["Phoenix"] } },
  },
};

/**
 * 环境指纹。防止「悄悄换了时间基准 / 加速模型 / 区间收集」这类静默劣化。
 * `unixTs` 与 sc2reader 的 `replay.unix_timestamp` 对齐；`chronoRanges` 与
 * `spawningtool.GameParser.chronoboosts` 的区间总数对齐；`expansion` 来自**依赖 hash**
 * （`expansionFromDetails`，与 sc2reader 同源），不是 build 号启发式。
 *
 * 注：基线 JSON 不记录 `is_chronoboosted`（条目键只有 `_kind/is_worker/start_time/supply/
 * unit/target`），所以时空加速的正确性**不靠标志位比对**，而是靠 `start_time` 逐秒相等
 * 间接证明 —— 加速会直接改变秒数，改错必然对不上。这比对标志位更强。
 */
const FINGERPRINT = {
  "CN_PVT_T-AI.SC2Replay": { unixTs: 1771572696, model: "lotv", chronoRanges: 5, expansion: "LotV" },
  "CN_ZVP.SC2Replay": { unixTs: 1772447739, model: "hots", chronoRanges: 1, expansion: "LotV" },
  "US_TVP.SC2Replay": { unixTs: 1772480423, model: "hots", chronoRanges: 23, expansion: "LotV" },
  "US_TVR(T)_2018_old.SC2Replay": { unixTs: 1521165386, model: "hots", chronoRanges: 0, expansion: "LotV" },
  "hero(w) vs reynor g1 winter madness(PVZ).SC2Replay": {
    unixTs: 1768723972,
    model: "hots",
    chronoRanges: 25,
    expansion: "LotV",
  },
};

/**
 * 每张录像解析出的**能力 link 集合**指纹。
 *
 * 这是防「查询键用错」的哨兵：若有人把 `m_baseBuild` 当 `m_build` 传、或资料片传成
 * `null`，集合会立刻变成空或错位，这里就报红。样本里 `m_build == m_baseBuild`，
 * 所以这条断言**不是**在验证「两者相等」这个样本事实，而是在钉住「查表结果正确」。
 */
const ABILITY_LINKS_FINGERPRINT = {
  "CN_PVT_T-AI.SC2Replay": { chrono: "723", recall: "78,357,724" },
  "CN_ZVP.SC2Replay": { chrono: "723", recall: "78,357,724" },
  "US_TVP.SC2Replay": { chrono: "723", recall: "78,357,724" },
  "US_TVR(T)_2018_old.SC2Replay": { chrono: "706", recall: "76,344,707" },
  "hero(w) vs reynor g1 winter madness(PVZ).SC2Replay": { chrono: "723", recall: "78,357,724" },
};

/**
 * 星空加速行的**玩家级**指纹（`start_time` 升序）。
 *
 * 玩家为空数组 = 「该玩家不该有任何 recall 行」。这条同时钉住**玩家归属**：
 * US_TVP 必须落在 `Shameless` 而不是 `Percival`，hero 必须落在 `herO` 而不是 `Reynor`
 * （用 `userId + 1` 就会错位到后者）。
 */
const RECALL_FINGERPRINT = {
  "CN_PVT_T-AI.SC2Replay": {},
  "CN_ZVP.SC2Replay": {},
  "US_TVP.SC2Replay": { Shameless: [427, 739, 937] },
  "US_TVR(T)_2018_old.SC2Replay": {},
  "hero(w) vs reynor g1 winter madness(PVZ).SC2Replay": { herO: [1129] },
};

/** 允许经 morph 路径出现的 BO_EXCLUDED 成员（`Overlord→Overseer` 等）。 */
const MORPH_ALLOWED_EXCLUDED = ["Overseer"];

/**
 * 默认模式（`exactZergStart: true`）指纹。
 *
 * 上面所有逐条对拍跑的都是 **parity 模式**（虫族也一律查表），那是为了迁就旧链路的对拍口径，
 * **不是要发布的模式**。要发布的是默认模式：虫族单位靠 `SUnitBornEvent.m_creatorUnitTagIndex`
 * 回溯到 Egg 的 `SUnitInitEvent` 帧 —— 精确起点、零数据表。两者必须产出**同一组单位**
 * （只允许起点有秒级取整差），这里把 Egg 命中数钉住防止静默退化。
 */
const DEFAULT_MODE_FINGERPRINT = {
  "CN_PVT_T-AI.SC2Replay": { eggLinked: 0, fallbackTiming: 0 },
  "CN_ZVP.SC2Replay": { eggLinked: 16, fallbackTiming: 0 },
  "US_TVP.SC2Replay": { eggLinked: 0, fallbackTiming: 8 },
  "US_TVR(T)_2018_old.SC2Replay": { eggLinked: 0, fallbackTiming: 0 },
  "hero(w) vs reynor g1 winter madness(PVZ).SC2Replay": { eggLinked: 557, fallbackTiming: 0 },
};

let pass = 0;
let fail = 0;
const problems = [];
function check(ok, label, detail = "") {
  if (ok) pass += 1;
  else {
    fail += 1;
    problems.push(`${label}${detail ? " :: " + detail : ""}`);
  }
}

const want = process.argv.slice(2);
const replays = readdirSync(SAMPLE_DIR)
  .filter((f) => f.endsWith(".SC2Replay"))
  .filter((f) => want.length === 0 || want.includes(f))
  .sort();
if (replays.length === 0) throw new Error("没有匹配的样本录像");

const TOTALS = {
  baselineEntries: 0,
  strictMatch: 0,
  strictMismatch: 0,
  deviationEntries: 0,
  supplyDiff: 0,
  chronoboosted: 0,
  baselineRecallRows: 0,
  ourRecallRows: 0,
  fallbackRows: 0,
  buildingWithFinish: 0,
  buildingTotal: 0,
  eggLinked: 0,
  fallbackTiming: 0,
};

/**
 * 多重集差（按 `unit|start_time|is_worker`）。
 * 返回 `onlyOurs` = 只在我们结果里的键，`onlyBase` = 只在基线里的键。
 */
function multisetDiff(oursKeys, baseKeys) {
  const pool = new Map();
  for (const k of baseKeys) pool.set(k, (pool.get(k) ?? 0) + 1);
  const onlyOurs = [];
  for (const k of oursKeys) {
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else onlyOurs.push(k);
  }
  const onlyBase = [];
  for (const [k, n] of pool) for (let i = 0; i < n; i += 1) onlyBase.push(k);
  return { onlyOurs, onlyBase };
}

/** 多重集相等（顺序无关）。 */
function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map();
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1);
  for (const x of b) {
    const n = m.get(x) ?? 0;
    if (n === 0) return false;
    m.set(x, n - 1);
  }
  return true;
}

/** 按 `details.m_playerList` 顺序取该录像的偏差登记（scope=replay 时对所有人生效）。 */
function deviationFor(replayName, playerName) {
  const d = DEVIATIONS[replayName];
  if (!d) return null;
  if (d.scope === "replay") return d;
  return d.players?.[playerName] ? { ...d, spec: d.players[playerName] } : null;
}

// ---- 加速模型选择矩阵自测（逐条对照 spawningtool/parser.py:469-490） ----
//
// 这段单独存在的原因：`chronoModel` 的分支由「录像时间戳落在哪个窗口」决定，而
// 窗口只覆盖 2015-09 ~ 2017-12。样本录像全在窗口外，所以**跑样本永远测不到 lotv40 分支**。
// 这里把每一支（含上下界、含 cooperative 短路）都钉死。
{
  const cases = [
    [1512000000, "LotV", false, "lotv40", 1], // 4.0 过渡期中段
    [1513641600, "LotV", false, "hots", 0.5], // 上界：严格 `<`，不含 → 两支都不中
    [1510617600, "LotV", false, "hots", 0.5], // 下界：严格 `>`，不含
    [1500000000, "LotV", false, "lotv", 0.15], // LotV 连续加速期中段
    [1441238400, "LotV", false, "hots", 0.5], // 下界：严格 `>`，不含
    [1772480423, "LotV", false, "hots", 0.5], // 现代 LotV → 掉 else（spawningtool 的已知缺陷）
    [1772480423, "LotV", true, "lotv", 0.15], // cooperative 靠 `or` 短路单独命中
    [1521165386, "WoL", false, "hots", 0.5],
  ];
  for (const [ts, exp, coop, kind, mult] of cases) {
    const m = chronoModel(ts, exp, coop);
    check(
      m.kind === kind && m.multiplier === mult,
      `模型矩阵 ts=${ts} ${exp} coop=${coop}`,
      `期望 ${kind}×${mult}，实得 ${m.kind}×${m.multiplier}`,
    );
  }
  check(chronoModel(1512000000, "LotV", false).durationLoops === 224, "lotv40 时长", "期望 224 帧（22.4×10）");
  check(chronoModel(1772480423, "LotV", false).durationLoops === 320, "hots 时长", "期望 320 帧（16×20）");
  check(chronoModel(1500000000, "LotV", false).durationLoops === 0, "lotv 时长", "连续模型不用时长，期望 0");
  check(expansionFromBaseBuild(95299) === "LotV", "资料片推断 95299", "期望 LotV");
  check(expansionFromBaseBuild(62848) === "LotV", "资料片推断 62848", "期望 LotV");
  check(expansionFromBaseBuild(38215) === "HotS", "资料片推断 38215", "期望 HotS");
}

// ---- 能力 link 区间查询矩阵自测 ----
//
// 这段存在的理由与上面的模型矩阵一样：区间是**按 datapack 边界**切的，而边界不等于文件名
// （`89720` 那份表的窗口是 `[89634, 95122)`），且不同资料片的窗口在数值上重叠
// （`HotS/38215` 与 `LotV/base`）。样本只落在两个区间里，**光跑样本测不出边界**。
// 这里把上下界、资料片隔离、以及「区间化必须把并集冲突解开」都钉死。
{
  const linksOf = (build, expansion) => {
    const got = abilityLinksForBuild(build, expansion);
    return {
      chrono: [...got.chrono].sort((a, b) => a - b).join(","),
      recall: [...got.recall].sort((a, b) => a - b).join(","),
    };
  };
  const expect = (build, expansion, chrono, recall, label) => {
    const got = linksOf(build, expansion);
    check(
      got.chrono === chrono && got.recall === recall,
      `link 区间 ${label} build=${build} ${expansion}`,
      `期望 chrono[${chrono}] recall[${recall}]，实得 chrono[${got.chrono}] recall[${got.recall}]`,
    );
  };

  // 样本落点
  for (const b of [95841, 96163, 96314, 96516]) expect(b, "LotV", "723", "78,357,724", "LotV/96883");
  expect(62848, "LotV", "706", "76,344,707", "LotV/59587");

  // 边界：95122 / 97364 是 datapack 边界，不是文件名
  expect(95121, "LotV", "722", "78,357,723", "89720 上界-1");
  expect(95122, "LotV", "723", "78,357,724", "96883 下界");
  expect(97363, "LotV", "723", "78,357,724", "96883 上界-1");
  expect(97364, "LotV", "724", "78,357,725", "97364 下界");
  expect(89633, "LotV", "722", "78,357,723", "80949 上界-1");
  expect(89634, "LotV", "722", "78,357,723", "89720 下界（两表同值）");

  // LotV/base：框选条件是 `34784 <= build`（无上界），有效窗口被更高优先级的兄弟裁到 44401
  expect(34783, "LotV", "", "", "LotV/base 下界-1（无匹配）");
  expect(34784, "LotV", "108", "68,334,494", "LotV/base 下界");
  expect(44000, "LotV", "108", "68,334,494", "LotV/base 有效窗口内");
  expect(44400, "LotV", "108", "68,334,494", "LotV/base 有效上界-1");
  expect(44401, "LotV", "111", "339,519", "44401 下界（优先级压过 base）");

  // 资料片隔离：同一个 build 在不同资料片下取的是**不同**表
  expect(20000, "WoL", "102", "62", "WoL/19458");
  expect(20000, "HotS", "108", "68,331", "HotS/base");
  expect(20000, "LotV", "", "", "LotV 下界以下（无匹配）");
  expect(30000, "HotS", "108", "68,332,435", "HotS/24764");
  expect(30000, "LotV", "", "", "LotV 下界以下（无匹配）");
  expect(40000, "HotS", "108", "68,334,494", "HotS/38215（开放上界）");
  expect(40000, "LotV", "108", "68,334,494", "LotV/base");
  expect(20000, null, "", "", "未提供资料片 → 空");

  // 区间化 vs 并集：并集冲突恰好是 [717, 723, 724]，区间化必须把它们分到两族里去
  const l = abilityLinksForBuild(95841, "LotV");
  check(
    l.chrono.has(723) && !l.chrono.has(724),
    "724 在 96883 区间内不是时空加速",
    `chrono=[${[...l.chrono]}]`,
  );
  check(
    l.recall.has(724) && !l.recall.has(723),
    "724 在 96883 区间内是星空加速、723 不是",
    `recall=[${[...l.recall]}]`,
  );
  const hero = abilityLinksForBuild(96163, "LotV");
  check(
    !hero.chrono.has(108) && !hero.chrono.has(706) && !hero.chrono.has(717),
    "108/706/717 在该区间内不是时空加速（并集会误收）",
    `chrono=[${[...hero.chrono]}]`,
  );
}

for (const name of replays) {
  const archive = await openMpqArchive(new Uint8Array(readFileSync(join(SAMPLE_DIR, name))), {
    decompressor: createWasmDecompressor(),
  });
  const probed = probeBaseBuild(archive.readHeaderContent());
  const selection = selectProtocolTables(probed.baseBuild);
  const header = decodeReplayHeader(selection, archive.readHeaderContent());
  // baseBuild 在 `header.m_version.m_baseBuild`，**不在顶层** —— 取顶层会得 NaN，
  // 而 `expansionFromBaseBuild(NaN)` 静默回落到 `"WoL"`，让 LotV 窗口判定失效。
  const headerBaseBuild = Number(header.m_version?.m_baseBuild);
  check(
    headerBaseBuild === probed.baseBuild,
    `${name} header baseBuild`,
    `探测 ${probed.baseBuild}，header.m_version 实得 ${headerBaseBuild}`,
  );
  const details = decodeReplayDetails(selection, await archive.readFile("replay.details"));
  const initData = decodeReplayInitData(selection, await archive.readFile("replay.initData"));
  const tracker = decodeReplayTrackerEvents(selection, await archive.readFile("replay.tracker.events"));
  const game = decodeReplayGameEvents(selection, await archive.readFile("replay.game.events"));

  const unixTs = unixTimestampFromDetails(details);
  // 资料片：优先用**依赖 hash**（`expansionFromDetails`，与 sc2reader 同源），
  // 只有在依赖列表里找不到标准资料片依赖时才退回 build 号启发式。
  const depsExpansion = expansionFromDetails(details);
  const expansion = depsExpansion ?? expansionFromBaseBuild(probed.baseBuild);
  const cooperative = isCooperative(initData);
  const model = chronoModel(unixTs, expansion, cooperative);
  // 能力 link：查询键是 `m_build`（sc2reader 的 `replay.build = versions[4]`），
  // **不是** `m_baseBuild`。样本里两者相等，但语义不同 —— 别拿 baseBuild 顶替。
  const build = Number(header.m_version?.m_build);
  const links = abilityLinksForBuild(build, expansion);
  const userToPlayer = userIdToPlayerId(initData, details);
  const boosts = collectChronoBoosts({
    gameEvents: game,
    userToPlayer,
    tagToUnitName: collectTagToUnitName(tracker),
    links,
    model,
    totalFrames: Number(header.m_elapsedGameLoops),
  });
  const chronoRanges = [...boosts.values()].reduce(
    (total, ranges) => total + Object.values(ranges).reduce((n, list) => n + list.length, 0),
    0,
  );
  // 星空加速（recall）行：来自 game events（指令），按帧有序并入建造表。
  const recallRowsByPlayer = collectRecalls({ gameEvents: game, userToPlayer, links });

  const result = extractBuildOrder(tracker, {
    // parity 模式：虫族也一律查表，方便与旧链路逐条对齐。
    exactZergStart: false,
    replayTimestamp: unixTs,
    chrono: { boosts, multiplier: model.multiplier },
  });
  // 默认模式：虫族走 Egg 精确起点。这才是要发布的口径，必须与 parity 产出同一组单位。
  const dflt = extractBuildOrder(tracker, {
    exactZergStart: true,
    replayTimestamp: unixTs,
    chrono: { boosts, multiplier: model.multiplier },
  });
  const merged = mergeRecalls(result.byPlayer, recallRowsByPlayer);
  const mergedDefault = mergeRecalls(dflt.byPlayer, recallRowsByPlayer);
  TOTALS.chronoboosted += result.stats.chronoboosted;
  TOTALS.eggLinked += dflt.stats.eggLinked;
  TOTALS.fallbackTiming += dflt.stats.fallbackTiming;
  TOTALS.recallRows += [...recallRowsByPlayer.values()].reduce((n, list) => n + list.length, 0);

  // 玩家 id：按 `details.m_playerList` 顺序（sc2reader 就是这么分配的）。
  const pidToName = new Map();
  (details.m_playerList ?? []).forEach((p, index) => pidToName.set(index + 1, normalizeName(txt(p.m_name))));

  const baseline = JSON.parse(readFileSync(join(BASELINE_DIR, `${safe(name)}.json`), "utf8"));
  const baseByName = new Map();
  for (const team of baseline.teams ?? []) {
    for (const p of team.players ?? []) baseByName.set(p.name, p.build_order ?? []);
  }

  const fingerprint = FINGERPRINT[name];
  const defaultFp = DEFAULT_MODE_FINGERPRINT[name];
  const linkFp = ABILITY_LINKS_FINGERPRINT[name];
  console.log(`\n################ ${name}`);
  console.log(
    `  baseBuild ${probed.baseBuild}（协议 ${selection.protocolBuild}${selection.degraded ? "·降级" : ""}）` +
      `  m_build ${build}  ${expansion}${depsExpansion ? "（依赖 hash）" : "（build 号兜底）"}` +
      `  unixTs ${unixTs}  coop=${cooperative}`,
  );
  console.log(
    `  加速模型 ${model.kind}(×${model.multiplier})  区间 ${chronoRanges}  命中加速 ${result.stats.chronoboosted} 条` +
      `  ｜ 能力 link chrono[${[...links.chrono].sort((a, b) => a - b)}] recall[${[...links.recall].sort((a, b) => a - b)}]`,
  );

  if (linkFp) {
    check(
      [...links.chrono].sort((a, b) => a - b).join(",") === linkFp.chrono,
      `${name} chrono link 集合`,
      `期望 [${linkFp.chrono}]，实得 [${[...links.chrono].sort((a, b) => a - b)}]`,
    );
    check(
      [...links.recall].sort((a, b) => a - b).join(",") === linkFp.recall,
      `${name} recall link 集合`,
      `期望 [${linkFp.recall}]，实得 [${[...links.recall].sort((a, b) => a - b)}]`,
    );
  }

  if (defaultFp) {
    check(
      dflt.stats.eggLinked === defaultFp.eggLinked,
      `${name} Egg 精确起点条数`,
      `期望 ${defaultFp.eggLinked}，实得 ${dflt.stats.eggLinked}`,
    );
    check(
      dflt.stats.fallbackTiming === defaultFp.fallbackTiming,
      `${name} 表缺单位回退条数`,
      `期望 ${defaultFp.fallbackTiming}，实得 ${dflt.stats.fallbackTiming}`,
    );
  }

  if (fingerprint) {
    check(unixTs === fingerprint.unixTs, `${name} 时间戳`, `期望 ${fingerprint.unixTs}，实得 ${unixTs}`);
    check(model.kind === fingerprint.model, `${name} 加速模型`, `期望 ${fingerprint.model}，实得 ${model.kind}`);
    check(
      chronoRanges === fingerprint.chronoRanges,
      `${name} 加速区间数`,
      `期望 ${fingerprint.chronoRanges}，实得 ${chronoRanges}`,
    );
    // 资料片走的是**依赖 hash**（与 sc2reader 同源），不是 build 号启发式。
    check(
      depsExpansion === fingerprint.expansion,
      `${name} 依赖 hash 判资料片`,
      `期望 ${fingerprint.expansion}，实得 ${depsExpansion}`,
    );
  }

  for (const [pid, pname] of pidToName) {
    const baseAll = baseByName.get(pname);
    if (!baseAll) {
      check(false, `${name}/${pname}`, "基线里找不到该玩家");
      continue;
    }
    // recall 行**纳入**比对（此前整段排除）。基线的 recall 行 `unit: "" / target: null /
    // supply: null / is_worker: false`，我们的 `RecallRow` 同形，所以按
    // `unit|start_time|is_worker` 直接可比。
    const base = baseAll;
    const baseRecalls = baseAll.filter((e) => e._kind === "recall");
    TOTALS.baselineEntries += base.length;
    TOTALS.baselineRecallRows += baseRecalls.length;

    const ours = merged.get(pid) ?? [];
    const spec = deviationFor(name, pname);

    // 基线侧单位名归一化（仅 coop 偏差需要：spawningtool 把查不到的时长印成 error 串）。
    const baseUnits = base.map((e) => e.unit);
    if (spec?.renameBaselineUnits) {
      for (const [from, to] of spec.renameBaselineUnits) {
        for (let i = 0; i < baseUnits.length; i += 1) if (baseUnits[i] === from) baseUnits[i] = to;
      }
    }
    const key = (e) => `${e.unit}|${e.start_time}|${e.is_worker}`;
    const oursKeys = ours.map(key);
    const baseKeys = base.map(key);
    const { onlyOurs, onlyBase } = multisetDiff(oursKeys, baseKeys);
    const oursUnits = ours.map((e) => e.unit);

    // ---- 判据 ----
    if (!spec) {
      const diffs = onlyOurs.length + onlyBase.length;
      TOTALS.strictMatch += Math.max(0, base.length - diffs);
      TOTALS.strictMismatch += diffs;
      check(
        onlyOurs.length === 0 && onlyBase.length === 0,
        `${name}/${pname} 逐条一致`,
        `共 ${base.length} 条，多 ${onlyOurs.length} 缺 ${onlyBase.length}` +
          (onlyOurs.length ? ` | 多出: ${onlyOurs.slice(0, 3).join(" ")}` : "") +
          (onlyBase.length ? ` | 缺失: ${onlyBase.slice(0, 3).join(" ")}` : ""),
      );
      // 顺序一致（多重集相等仍可能顺序不同，这里补一刀）。
      //
      // ⚠️ **只看非 recall 行**：基线把 recall 行 `append` 在末尾
      // （`tools/baseline/parse_script.py` 的 recall 追加段），我们按帧有序插入 —— 位置必然不同，
      // 这是**已声明偏差**（README `build-260412` 把旧行为记为 bug）。
      // 「有序插入」这个改进本身由下面「建造表按帧有序」那条断言独立钉住。
      let posMis = 0;
      const oursSeq = ours.filter((e) => !isRecallRow(e));
      const baseSeq = base.filter((e) => e._kind !== "recall");
      for (let i = 0; i < Math.max(oursSeq.length, baseSeq.length); i += 1) {
        const a = oursSeq[i];
        const b = baseSeq[i];
        if (!a || !b || a.unit !== b.unit || a.start_time !== b.start_time) posMis += 1;
      }
      check(posMis === 0, `${name}/${pname} 顺序一致（不含 recall）`, `错位 ${posMis} 处`);
      if (base.length !== ours.length) {
        check(false, `${name}/${pname} 条目数`, `基线 ${base.length}，我们 ${ours.length}`);
      }
    } else {
      TOTALS.deviationEntries += base.length;
      if (spec.kind === "hallucinated-unit") {
        const allow = spec.spec.allowExtra;
        check(onlyBase.length === 0, `${name}/${pname} 不应缺条目`, `缺失 ${onlyBase.length} 条: ${onlyBase.slice(0, 5).join(" ")}`);
        check(
          onlyOurs.length === allow.length && onlyOurs.every((k) => allow.some((p) => k.startsWith(`${p}|`))),
          `${name}/${pname} 多出的条目恰好是幻象单位`,
          `多出 ${onlyOurs.length} 条（允许 ${allow.join("/")}）: ${onlyOurs.join(" ")}`,
        );
      } else if (spec.kind === "coop-constants") {
        check(cooperative === spec.expectCooperative, `${name} 偏差前提（coop 标记）`, `期望 ${spec.expectCooperative}，实得 ${cooperative}`);
        check(ours.length === base.length, `${name}/${pname} 条目数不变`, `基线 ${base.length}，我们 ${ours.length}`);
        check(
          sameMultiset(oursUnits, baseUnits),
          `${name}/${pname} 单位集合不变（纯时长偏差）`,
          `差异: ${[...new Set([...oursUnits, ...baseUnits])].filter((u) => {
            const c = (arr) => arr.filter((x) => x === u).length;
            return c(oursUnits) !== c(baseUnits);
          }).join(" ")}`,
        );
      }
    }

    // ---- 排除表双向断言（见文件头「排除表的正确语义」） ----
    const exclViolations = [];
    const morphViolations = [];
    for (const e of ours) {
      // recall 行不是 tracker 派生条目，这些字段它根本没有 —— 直接跳过。
      if (isRecallRow(e)) continue;
      if (EXCLUDED_UNITS.includes(e.unit)) {
        if (e.startSource !== "morph" || !MORPH_ALLOWED_EXCLUDED.includes(e.unit)) {
          exclViolations.push(`${e.unit}@${e.start_time}(${e.startSource})`);
        }
      }
      if (CHANGED_EXCLUDED_UNITS.includes(e.unit) && e.startSource === "morph") {
        morphViolations.push(`${e.unit}@${e.start_time}`);
      }
      if (e.type === "Building") {
        TOTALS.buildingTotal += 1;
        if (e.finishFrame !== null) TOTALS.buildingWithFinish += 1;
      }
      if (e.startSource === "fallback") TOTALS.fallbackRows += 1;
      if (e.supply !== undefined && e.supply !== null) {
        const b = base.find((x) => x.unit === e.unit && x.start_time === e.start_time);
        if (b && b.supply !== e.supply) TOTALS.supplyDiff += 1;
      }
    }
    check(exclViolations.length === 0, `${name}/${pname} BO_EXCLUDED 越界`, exclViolations.slice(0, 5).join(" "));
    check(morphViolations.length === 0, `${name}/${pname} BO_CHANGED_EXCLUDED 越界（morph 路径）`, morphViolations.slice(0, 5).join(" "));

    // ---- 星空加速（recall）行 ----
    const oursRecalls = ours.filter(isRecallRow);
    TOTALS.ourRecallRows += oursRecalls.length;
    check(
      oursRecalls.every(
        (e) =>
          e._kind === "recall" &&
          e.unit === "" &&
          e.target === null &&
          e.supply === null &&
          e.is_worker === false,
      ),
      `${name}/${pname} recall 行字段形状`,
      `实得 ${JSON.stringify(oursRecalls.slice(0, 2))}`,
    );
    check(
      oursRecalls.length === baseRecalls.length,
      `${name}/${pname} recall 行条数`,
      `基线 ${baseRecalls.length}，我们 ${oursRecalls.length}`,
    );
    const recallFp = RECALL_FINGERPRINT[name]?.[pname] ?? [];
    check(
      oursRecalls.map((e) => e.start_time).join(",") === recallFp.join(","),
      `${name}/${pname} recall 指纹（含玩家归属）`,
      `期望 [${recallFp}]，实得 [${oursRecalls.map((e) => e.start_time)}]`,
    );
    // 有序插入（有意不同于旧链路的 append-to-end）：整体按 `startFrame` 非递减。
    let outOfOrder = 0;
    for (let i = 1; i < ours.length; i += 1) {
      if (ours[i].startFrame < ours[i - 1].startFrame) outOfOrder += 1;
    }
    check(outOfOrder === 0, `${name}/${pname} 建造表按帧有序（含 recall 插入）`, `逆序 ${outOfOrder} 处`);

    // ---- 默认模式 vs parity：必须同一组单位（只允许起点秒级取整差） ----
    const dfltOurs = mergedDefault.get(pid) ?? [];
    const dfltUnits = dfltOurs.map((e) => e.unit);
    check(
      sameMultiset(dfltUnits, oursUnits),
      `${name}/${pname} 默认模式单位集与 parity 一致`,
      `默认 ${dfltOurs.length} 条 / parity ${ours.length} 条` +
        (sameMultiset(dfltUnits, oursUnits)
          ? ""
          : ` | 差异: ${[...new Set([...dfltUnits, ...oursUnits])]
              .filter((u) => dfltUnits.filter((x) => x === u).length !== oursUnits.filter((x) => x === u).length)
              .join(" ")}`),
    );
    const eggCount = dfltOurs.filter((e) => e.startSource === "egg").length;
    const fallbackCount = dfltOurs.filter((e) => e.startSource === "fallback").length;
    console.log(
      `    ${pname.padEnd(16)} 基线 ${String(base.length).padStart(4)} 条  我们 ${String(ours.length).padStart(4)} 条` +
        `  多 ${String(onlyOurs.length).padStart(3)}  缺 ${String(onlyBase.length).padStart(3)}` +
        (eggCount ? `  Egg精确 ${eggCount}` : "") +
        (fallbackCount ? `  表缺 ${fallbackCount}` : "") +
        (spec ? `  [已声明偏差: ${spec.kind}]` : ""),
    );
    if (spec && (onlyOurs.length || onlyBase.length)) {
      console.log(
        `        偏差明细: 多出 ${onlyOurs.length}${onlyOurs.length ? " → " + onlyOurs.slice(0, 4).join(" ") : ""}` +
          `  缺失 ${onlyBase.length}${onlyBase.length ? " → " + onlyBase.slice(0, 4).join(" ") : ""}`,
      );
    }
  }
}

console.log("\n================ 汇总 ================");
console.log(`基线条目（含 recall）        ${TOTALS.baselineEntries}`);
console.log(`严格逐条一致                  ${TOTALS.strictMatch}`);
console.log(`严格不一致（应为 0）          ${TOTALS.strictMismatch}`);
console.log(`已声明偏差覆盖                ${TOTALS.deviationEntries}`);
console.log(`未解释条目（应为 0）          ${TOTALS.baselineEntries - TOTALS.strictMatch - TOTALS.deviationEntries}`);
console.log(`supply 与基线不同             ${TOTALS.supplyDiff}（spawningtool 的 get_supply 有已知索引 bug，不判失败）`);
console.log(`命中时空加速                  ${TOTALS.chronoboosted}`);
console.log(`星空加速行 recall 基线/我们   ${TOTALS.baselineRecallRows} / ${TOTALS.ourRecallRows}`);
console.log(`表缺单位 → 回退出生帧（parity） ${TOTALS.fallbackRows}`);
console.log(`建筑终点补齐                  ${TOTALS.buildingWithFinish}/${TOTALS.buildingTotal}`);
console.log(`Egg 精确起点（默认模式）      ${TOTALS.eggLinked}`);
console.log(`表缺单位 → 回退出生帧（默认） ${TOTALS.fallbackTiming}`);

const strictPct = (TOTALS.strictMatch / TOTALS.baselineEntries) * 100;
const explainedPct =
  ((TOTALS.strictMatch + TOTALS.deviationEntries) / TOTALS.baselineEntries) * 100;
console.log(
  `\n严格一致 ${strictPct.toFixed(2)}% ｜ 在解释范围内（严格一致 + 已声明偏差）${explainedPct.toFixed(2)}%`,
);

console.log(`\n断言：${pass} 通过 / ${fail} 失败`);
if (problems.length) {
  console.log("\n失败明细（最多 20 条）：");
  for (const p of problems.slice(0, 20)) console.log("  ❌ " + p);
}
process.exit(fail === 0 ? 0 : 1);
