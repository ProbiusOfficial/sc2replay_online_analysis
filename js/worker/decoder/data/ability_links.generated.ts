/**
 * 能力 link 集合（时空加速 / 星空加速）—— **自动生成，请勿手改**。
 *
 * 由 `scripts/gen-ability-links.py` 从 sc2reader 的 datapack 元数据产出。
 * 来源：sc2reader 1.9.0；`resources.py` sha256 `72fba469efc15aaa97d5f33dd311df57904561606255b14bd6668a486368b9f4`。
 *
 * ## 为什么不能只存一份集合（这是本模块存在的唯一理由）
 *
 * `ability_id = (m_abilLink << 5) | m_abilCmdIndex`，而 **`m_abilLink` 不是全局唯一的** ——
 * 同一个 link 在不同补丁里是不同能力。实测三连移（LotV）：
 *
 * | datapack | 有效区间            | link 723                | link 724                | link 725            |
 * | -------- | ------------------- | ----------------------- | ----------------------- | ------------------- |
 * | `89720`  | `89634 ≤ b < 95122` | `NexusMassRecall`       | —                       | —                   |
 * | `96883`  | `95122 ≤ b < 97364` | `ChronoBoostEnergyCost` | `NexusMassRecall`       | —                   |
 * | `97364`  | `97364 ≤ b`         | `RavenShredderMissile`  | `ChronoBoostEnergyCost` | `NexusMassRecall`   |
 *
 * 跨版本取并集会同时命中两族 → 必然误判（实测 US_TVP 的 3 条 `NexusMassRecall` 在并集下
 * 被判成「时空加速」）。**每个区间内部两族集合都不相交**，这正是按区间取集合能成立的前提。
 *
 * ## ⚠️ 区间语义是「优先级 + 首个匹配」，不是「按 lo 排序的窗口」
 *
 * `sc2reader/resources.py::register_datapack()` 做的是 `registered_datapacks.insert(0, ...)`，
 * 其文档写明按 **reverse registration order** 检查（**后注册者优先**）。
 *
 * 于是 `LotV/base` 虽然框选条件是 `34784 <= build`（无上界），但它注册在 `LotV/44401` 之前，
 * 优先级更低 —— **有效窗口被更高优先级的兄弟裁成 `[34784, 44401)`**。
 *
 * 所以本数组**按优先级从高到低排列**，`abilityLinksForBuild()` 取**首个匹配**。
 * 不要按 `lo` 重排、也不要把 `base` 的 `hi: null` 「修」成 `44401`：
 * 前者会改变结果，后者会丢掉「优先级」这个唯一正确语义。
 *
 * 各条目的**有效窗口**（生成时模拟优先级算出，仅供人读，不参与运行）：
 *
 *   WoL   16117    16117 ≤ build < 17326
 *   WoL   17326    17326 ≤ build < 18092
 *   WoL   18092    18092 ≤ build < 19458
 *   WoL   19458    19458 ≤ build < 22612
 *   WoL   22612    22612 ≤ build < 24944
 *   WoL   24944    24944 ≤ build
 *   HotS  base     0 ≤ build < 23925
 *   HotS  23925    23925 ≤ build < 24247
 *   HotS  24247    24247 ≤ build < 24764
 *   HotS  24764    24764 ≤ build < 38215
 *   HotS  38215    38215 ≤ build
 *   LotV  base     34784 ≤ build < 44401
 *   LotV  44401    44401 ≤ build < 47185
 *   LotV  47185    47185 ≤ build < 48258
 *   LotV  48258    48258 ≤ build < 53644
 *   LotV  53644    53644 ≤ build < 54724
 *   LotV  54724    54724 ≤ build < 59587
 *   LotV  59587    59587 ≤ build < 70154
 *   LotV  70154    70154 ≤ build < 76114
 *   LotV  76114    76114 ≤ build < 77379
 *   LotV  77379    77379 ≤ build < 80949
 *   LotV  80949    80949 ≤ build < 89634
 *   LotV  89720    89634 ≤ build < 95122
 *   LotV  96883    95122 ≤ build < 97364
 *   LotV  97364    97364 ≤ build
 *
 * ## 区间从哪来
 *
 * 逐字复刻 `sc2reader/resources.py::register_default_datapacks()` 的 filter 条件，
 * 上下界**不等于文件名**（`89720` 那份表的条件区间是 `89634 ≤ b < 95122`）。
 * 特例：`HotS/38215` 实际读 `LotV/base`（`sc2reader/data/__init__.py:462`）。
 *
 * ## 查询键 —— 别用错 build
 *
 * 应当传 `header.m_version.m_build`（对应 sc2reader 的 `replay.build = versions[4]`）。
 * **不是 `m_baseBuild`**（那是 `versions[5]`；本仓库的 `probeBaseBuild()` 取的是它，
 * 两者用途不同）。样本录像里两者恰好相等（95841 / 96163 / 96314 / 96516 / 62848），
 * 但协议上不保证。
 *
 * ## 已做的静态校验（生成时断言，失败即报错，绝不静默产出）
 *
 * 1. filter 的 `r.expansion` 与注册键一致；
 * 2. 每个区间内 `chrono ∩ recall == ∅`；
 * 3. 所有命中的 `m_abilCmdIndex` 都是 `0`（否则报错 —— 「只认 cmd 0」的前提被打破）；
 * 4. 覆盖完整性：`(资料片, build)` 在已声明边界内的每一种组合都能命中某一条。
 */

/** 资料片。判定见 `chrono.ts::expansionFromDetails()`（依赖 hash，权威）或 `expansionFromBaseBuild()`。 */
export type Expansion = "WoL" | "HotS" | "LotV";

export interface AbilityLinkRange {
  expansion: Expansion;
  /** datapack 键（`<expansion>/<key>_abilities.csv` 的文件名去后缀）。 */
  table: string;
  /** 框选下界（`lo <= build`）。 */
  lo: number;
  /** 框选上界（`build < hi`）；`null` 表示无上界，**不代表有效窗口无上界** —— 见文件头「优先级」。 */
  hi: number | null;
  /** 时空加速（Chrono Boost）家族的 `m_abilLink`，升序。 */
  chrono: readonly number[];
  /** 星空加速（Mass Recall）家族的 `m_abilLink`，升序。 */
  recall: readonly number[];
}

/**
 * 全部区间，**按优先级从高到低**（= sc2reader 的注册顺序取反）。
 * 查询必须取**首个匹配**，且必须同时带资料片（不同资料片的框选范围在数值上重叠）。
 */
export const ABILITY_LINK_RANGES: readonly AbilityLinkRange[] = [
  { expansion: "LotV", table: "97364", lo: 97364, hi: null, chrono: [724], recall: [78, 357, 725] },
  { expansion: "LotV", table: "96883", lo: 95122, hi: 97364, chrono: [723], recall: [78, 357, 724] },
  { expansion: "LotV", table: "89720", lo: 89634, hi: 95122, chrono: [722], recall: [78, 357, 723] },
  { expansion: "LotV", table: "80949", lo: 80949, hi: 89634, chrono: [722], recall: [78, 357, 723] },
  { expansion: "LotV", table: "77379", lo: 77379, hi: 80949, chrono: [717], recall: [76, 355, 718] },
  { expansion: "LotV", table: "76114", lo: 76114, hi: 77379, chrono: [716], recall: [76, 355, 717] },
  { expansion: "LotV", table: "70154", lo: 70154, hi: 76114, chrono: [709], recall: [76, 345, 710] },
  { expansion: "LotV", table: "59587", lo: 59587, hi: 70154, chrono: [706], recall: [76, 344, 707] },
  { expansion: "LotV", table: "54724", lo: 54724, hi: 59587, chrono: [116], recall: [344, 532] },
  { expansion: "LotV", table: "53644", lo: 53644, hi: 54724, chrono: [116], recall: [344, 532] },
  { expansion: "LotV", table: "48258", lo: 48258, hi: 53644, chrono: [115], recall: [343, 531] },
  { expansion: "LotV", table: "47185", lo: 47185, hi: 48258, chrono: [115], recall: [343, 523] },
  { expansion: "LotV", table: "44401", lo: 44401, hi: 47185, chrono: [111], recall: [339, 519] },
  { expansion: "LotV", table: "base", lo: 34784, hi: null, chrono: [108], recall: [68, 334, 494] },
  { expansion: "HotS", table: "38215", lo: 38215, hi: null, chrono: [108], recall: [68, 334, 494] },
  { expansion: "HotS", table: "24764", lo: 24764, hi: 38215, chrono: [108], recall: [68, 332, 435] },
  { expansion: "HotS", table: "24247", lo: 24247, hi: 24764, chrono: [108], recall: [68, 332, 435] },
  { expansion: "HotS", table: "23925", lo: 23925, hi: 24247, chrono: [108], recall: [68, 331] },
  { expansion: "HotS", table: "base", lo: 0, hi: 23925, chrono: [108], recall: [68, 331] },
  { expansion: "WoL", table: "24944", lo: 24944, hi: null, chrono: [108], recall: [68] },
  { expansion: "WoL", table: "22612", lo: 22612, hi: 24944, chrono: [108], recall: [68] },
  { expansion: "WoL", table: "19458", lo: 19458, hi: 22612, chrono: [102], recall: [62] },
  { expansion: "WoL", table: "18092", lo: 18092, hi: 19458, chrono: [101], recall: [61] },
  { expansion: "WoL", table: "17326", lo: 17326, hi: 18092, chrono: [101], recall: [61] },
  { expansion: "WoL", table: "16117", lo: 16117, hi: 17326, chrono: [100], recall: [60] },
];

export interface AbilityLinks {
  chrono: ReadonlySet<number>;
  recall: ReadonlySet<number>;
}

/** 未知 build / 未知资料片时的返回值。两组都空，调用方据此静默跳过（旧链路也是查不到就跳过）。 */
export const NO_ABILITY_LINKS: AbilityLinks = { chrono: new Set(), recall: new Set() };

/** 取**首个匹配**的区间 —— 顺序即优先级，不能改。 */
export function abilityLinksForBuild(
  build: number,
  expansion: Expansion | null | undefined,
): AbilityLinks {
  if (!expansion) return NO_ABILITY_LINKS;
  for (const range of ABILITY_LINK_RANGES) {
    if (range.expansion !== expansion) continue;
    if (build < range.lo) continue;
    if (range.hi !== null && build >= range.hi) continue;
    return { chrono: new Set(range.chrono), recall: new Set(range.recall) };
  }
  return NO_ABILITY_LINKS;
}
