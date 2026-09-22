# 星空加速（`_kind: "recall"`）修复调研

> 状态：**已实现（方案 B）**。落地清单与验收证据见 §10。
> 关联：`plans/ROUTE-C-WASM-REFACTOR-PLAN.md` §0.2；`plans/RESEARCH-BUILD-ORDER-TIMING.md`
> 复现脚本：`scripts/research/recall-ability-ids.py`、`scripts/research/ability-id-sets-by-range.py`
> codegen：`scripts/gen-ability-links.py`（`--check` 可校验生成物是否最新）

---

## 0. 先澄清术语（这是本次最先要纠正的一处混淆）

| 名字 | 是什么 | 在代码里的位置 | 与建造时长的关系 |
| ---- | ------ | -------------- | ---------------- |
| **星空加速** | 旧站点给 **Mass Recall 家族**（星灵传送）起的显示名 | `js/display_helpers.js:4-7`；`_kind: "recall"` 行 | **无关** |
| **时空加速** | **Chrono Boost** | `js/worker/decoder/chrono.ts` | **有关**（会缩短建造时长，必须回推修正） |

`plans/ROUTE-C-WASM-REFACTOR-PLAN.md` 原文把两者混写（「星空加速会缩短建造时间」），已更正。
本报告只谈**星空加速 = Mass Recall**。

旧的 `_kind: "recall"` 行在界面上长这样：`星空加速`（无目标时）或 `星空加速 → <单位名>`；
语音读作「加速」（`js/voice_reader.js:97`）。

---

## 1. 结论摘要

| 问题 | 结论 |
| ---- | ---- |
| 旧链路怎么产的？ | 旧 `js/parse_script.js`（现已迁至 `tools/baseline/parse_script.py`，原 56-95 / 256-266 行附近），用 sc2reader 匹配 4 个能力名，`start_time = frame >> 4` |
| 目标名拿得到吗？ | **拿不到**。这 4 个能力全是**点目标**（`m_data.TargetPoint`），指令里没有目标单位 |
| 新解码器缺什么？ | 只有两样：能力数值 id 集合、以及把 `_userid` 桥接到玩家的映射（**后者已实现**，`chrono.ts` 里） |
| 最大坑是什么？ | **`m_abilLink` 跨版本不稳定** —— 同一个 link 在不同补丁里是不同能力。跨版本取并集必然误判 |
| 推荐方案 | **按 datapack 区间取 id 集合**（codegen），并顺手把 recall 行**按时间插入**而不是追加到末尾 |
| 修复风险 | **零**。实测：把现有 `chrono.ts` 的并集换成区间集合，5 个样本的加速区间结果**逐字节完全一致** |
| 预期产出 | US_TVP 3 条（427 / 739 / 937 s，Shameless）、hero 1 条（1129 s，herO），与基线一致 |

---

## 2. 旧链路的确切行为（逐字复刻得到的证据）

把旧链路的 Python 片段（原 `js/parse_script.js`，现 `tools/baseline/parse_script.py`）在托管 venv 里逐字重跑，结果与冻结基线**完全一致**：

```
#### US_TVP.SC2Replay  build=95841
   recall 行 3 条: sec=427 pid(sc2reader)=1 NexusMassRecall target=None
                   sec=739  …                              target=None
                   sec=937  …                              target=None
#### hero(w) vs reynor g1 winter madness(PVZ).SC2Replay  build=96163
   recall 行 1 条: sec=1129 pid(sc2reader)=3 NexusMassRecall target=None
```

对齐到我们解码的原始事件（帧号逐条吻合）：

| 字段 | 值 |
| ---- | -- |
| 协议事件 | `NNet.Game.SCmdEvent` |
| `m_abil` | `{ m_abilLink: 724, m_abilCmdIndex: 0 }` → `ability_id = 23168` |
| `m_cmdFlags` | `256` |
| `m_data` | `{ TargetPoint: { x, y, z } }` ← **点目标，没有 `TargetUnit`** |
| `_userid.m_userId` | US_TVP = `1`；hero = `3` |
| 帧号 | 6835 / 11830 / 15004 / 18065 → `frame >> 4` = 427 / 739 / 937 / 1129 |

**产出行的形状（必须逐字复刻）**：

```json
{ "start_time": 427, "supply": null, "unit": "", "_kind": "recall", "target": null, "is_worker": false }
```

`display_helpers.js` / `voice_reader.js` 都已经对 `target = null` 做了降级处理，所以**不需要**
发明一个目标名 —— 强行填反而会和旧站点表现不一致。

> 顺带否证一条早期假设：协议里的 `SCmdUpdateTargetPointEvent`（US_TVP 有 2064 条）**不携带 `m_abil`**
> （实测 0 条）。命令与目标更新是两类事件，别找错地方。

---

## 3. 核心发现：`m_abilLink` 不是全局唯一的

`ability_id = (m_abilLink << 5) | m_abilCmdIndex`，能力名不在录像里（早期已证实），
所以必须自带 `int_id → 名字` 的表 —— 即 sc2reader 的 `<expansion>/<version>_abilities.csv`。

**问题**：`int_id` 会随补丁变动。实测三连移：

| datapack | 区间 | link 723 | link 724 | link 725 |
| -------- | ---- | -------- | -------- | -------- |
| `LotV/89720` | `89634 ≤ b < 95122` | `NexusMassRecall` | — | — |
| `LotV/96883` | `95122 ≤ b < 97364` | `ChronoBoostEnergyCost` | `NexusMassRecall` | — |
| `LotV/97364` | `97364 ≤ b` | `RavenShredderMissile` | `ChronoBoostEnergyCost` | `NexusMassRecall` |

而 `js/worker/decoder/chrono.ts` 现在的 `CHRONO_ABILITY_LINKS` 是**跨版本并集**。
把两族并集摆一起：

```
并集 chrono links: [100,101,102,108,111,115,116,706,709,716,717,722,723,724]
并集 recall links: [60,61,62,68,76,78,331,332,334,339,343,344,345,355,357,435,494,
                    519,523,531,532,707,710,717,718,723,724,725]
并集冲突（同一 link 既 chrono 又 recall）: [717, 723, 724]
```

**实测到的真实影响（样本里就存在）**：

```
#### US_TVP.SC2Replay  baseBuild=95841 → LotV/96883 区间
    link  723 ×  24  → 区间化 CHRONO  / 并集 CHRONO
    link  724 ×   3  → 区间化 RECALL  / 并集 CHRONO   ⚠️ 两者判定不同
#### hero(w) vs reynor …  baseBuild=96163 → LotV/96883 区间
    link  108 ×   2  → 区间化 —       / 并集 CHRONO   ⚠️
    link  706 ×   1  → 区间化 —       / 并集 CHRONO   ⚠️
    link  717 ×   4  → 区间化 —       / 并集 CHRONO   ⚠️
    link  724 ×   1  → 区间化 RECALL  / 并集 CHRONO   ⚠️
```

**为什么现在没炸？** 纯属下游检查挡住：`collectChronoBoosts` 额外要求
`m_data.TargetUnit.m_tag` 能解析成单位名，而这几类指令要么是点目标、要么是变形指令（无目标），
于是被 `continue` 掉。**这是「碰巧正确」，不是「设计正确」** —— 一旦出现一条
unit 目标的误判 link，且被瞄准的单位名恰好出现在某个单位的 `built_from` 里，就会静默算错起点。

**对 chrono 现有产物是否有影响？实测：没有。** 把集合从并集换成区间集合后：

| 录像 | 并集 → 区间数 | 区间集合 → 区间数 | 结果 |
| ---- | ------------- | ---------------- | ---- |
| CN_PVT_T-AI (96314) | 5 | 5 | 完全一致 ✅ |
| CN_ZVP (96516) | 1 | 1 | 完全一致 ✅ |
| US_TVP (95841) | 23 | 23 | 完全一致 ✅ |
| US_TVR (62848) | 0 | 0 | 完全一致 ✅ |
| hero (96163) | 25 | 25 | 完全一致 ✅ |

所以**区间化是零回归的**，可以放心改。

---

## 4. 完整的区间表（codegen 的依据）

区间来源不是文件名，而是 `sc2reader/resources.py::register_default_datapacks()` 的 filter 上下界
——**两者不同**：例如 `89720` 那份表的区间是 `89634 ≤ build < 95122`。
`HotS/38215` 是特例，实际读 `LotV/base`（`sc2reader/data/__init__.py:462`）。

> **⚠️ 实现后才补上的一处语义修正（很重要）**
>
> 上表列的是**有效窗口**，但 sc2reader 的实际机制是「**优先级 + 首个匹配**」，不是
> 「一组互斥的显式窗口」：`register_datapack()` 做的是 `registered_datapacks.insert(0, ...)`，
> 其 docstring 明确写着按 **reverse registration order** 检查（**后注册者优先**）。
>
> 所以 `LotV/base` 的框选条件其实是 `34784 <= build`（**无上界**），只是它注册在
> `LotV/44401` 之前、优先级更低，**有效窗口才被裁成 `[34784, 44401)`**。
> 同理 `HotS/38215` 的框选是 `38215 <= build`（无上界）。
>
> 后果：`ABILITY_LINK_RANGES` 必须**按优先级排列**、查询取**首个匹配**，不能按 `lo` 重排。
> codegen 会在生成物注释里写出每条的有效窗口（模拟优先级算出），并对「覆盖无缝隙」做断言。

| expansion | datapack | 区间 | chrono links | recall links |
| --------- | -------- | ---- | ------------ | ------------ |
| WoL | 16117 | `16117 ≤ b < 17326` | 100 | 60 |
| WoL | 17326 | `17326 ≤ b < 18092` | 101 | 61 |
| WoL | 18092 | `18092 ≤ b < 19458` | 101 | 61 |
| WoL | 19458 | `19458 ≤ b < 22612` | 102 | 62 |
| WoL | 22612 | `22612 ≤ b < 24944` | 108 | 68 |
| WoL | 24944 | `24944 ≤ b` | 108 | 68 |
| HotS | base | `0 ≤ b < 23925` | 108 | 68, 331 |
| HotS | 23925 | `23925 ≤ b < 24247` | 108 | 68, 331 |
| HotS | 24247 | `24247 ≤ b < 24764` | 108 | 68, 332, 435 |
| HotS | 24764 | `24764 ≤ b < 38215` | 108 | 68, 332, 435 |
| HotS | 38215 | `38215 ≤ b`（实读 `LotV/base`） | 108 | 68, 334, 494 |
| LotV | base | `34784 ≤ b < 44401` | 108 | 68, 334, 494 |
| LotV | 44401 | `44401 ≤ b < 47185` | 111 | 339, 519 |
| LotV | 47185 | `47185 ≤ b < 48258` | 115 | 343, 523 |
| LotV | 48258 | `48258 ≤ b < 53644` | 115 | 343, 531 |
| LotV | 53644 | `53644 ≤ b < 54724` | 116 | 344, 532 |
| LotV | 54724 | `54724 ≤ b < 59587` | 116 | 344, 532 |
| LotV | 59587 | `59587 ≤ b < 70154` | 706 | 76, 344, 707 |
| LotV | 70154 | `70154 ≤ b < 76114` | 709 | 76, 345, 710 |
| LotV | 76114 | `76114 ≤ b < 77379` | 716 | 76, 355, 717 |
| LotV | 77379 | `77379 ≤ b < 80949` | 717 | 76, 355, 718 |
| LotV | 80949 | `80949 ≤ b < 89634` | 722 | 78, 357, 723 |
| LotV | 89720 | `89634 ≤ b < 95122` | 722 | 78, 357, 723 |
| LotV | 96883 | `95122 ≤ b < 97364` | 723 | 78, 357, 724 |
| LotV | 97364 | `97364 ≤ b` | 724 | 78, 357, 725 |

**每个区间内部，两族集合都是不相交的**（无一行标 ⚠️）—— 这正是「按区间取集合」能用的前提。
`m_abilCmdIndex` 在全部命中里**恒为 0**。

样本落点：

| 录像 | build | 区间 | chrono | recall |
| ---- | ----- | ---- | ------ | ------ |
| US_TVP | 95841 | LotV/96883 | 723 | 78, 357, **724** |
| hero | 96163 | LotV/96883 | 723 | 78, 357, **724** |
| CN_PVT_T-AI | 96314 | LotV/96883 | 723 | 78, 357, 724 |
| CN_ZVP | 96516 | LotV/96883 | 723 | 78, 357, 724 |
| US_TVR(T) | 62848 | LotV/59587 | 706 | 76, 344, 707 |

---

## 5. 修复方案

### 推荐：B —— 区间化 + 时间插入

1. **codegen 出区间表** → `js/worker/decoder/data/ability_links.generated.ts`
   ```ts
   export interface AbilityLinkRange { lo: number; hi: number; chrono: number[]; recall: number[] }
   export const ABILITY_LINK_RANGES: readonly AbilityLinkRange[] = [ ... ];
   export function abilityLinksForBuild(build: number): { chrono: ReadonlySet<number>; recall: ReadonlySet<number> };
   ```
   生成器：把 `scripts/research/ability-id-sets-by-range.py` 提升为 `scripts/gen-ability-links.py`
   （和 `gen-protocol-tables.py` / `gen-build-times.py` 同一套做法）。产物很小（25 行区间）。

2. **新增 `js/worker/decoder/recall.ts`**（与 `chrono.ts` 对称）：
   ```ts
   export function collectRecalls({ gameEvents, userToPlayer, links, totalFrames }): RecallRow[]
   ```
   逻辑：遍历 `SCmdEvent` → `m_abil.m_abilLink ∈ links.recall` 且 `m_abilCmdIndex === 0`
   → `_userid.m_userId` 经**已有的两跳桥** `userIdToPlayerId` 得 pid
   → `start_time = _gameloop >> 4` → `{ _kind: "recall", unit: "", target: null, supply: null, is_worker: false }`。

3. **`chrono.ts` 改用区间集合**，删掉跨版本并集（并在文件头写明「link 不全局唯一」这条）。
   —— 已验证零回归。

4. **排序**：把 recall 行**按 `start_time` 插进** build_order，而不是 append 到末尾。
   旧链路的 append 行为已被 README 记为 bug（`README.md:129`：语音播报顺序与界面不一致）。
   这属于**有意改进**，需在验收脚本里声明。

### 备选 A —— 最小复刻（不推荐单独用）

只做「并按集取数 + append 到末尾」，与旧链路逐字节一致（含 bug）。实现更少，
但会把这个已知 bug 一起带进新引擎，且并入 `ReplayData` 时还得再改一次排序。

### 备选 C —— 解析加速目的地（可选增强，建议后置）

点目标里有 `x/y/z`（如 `245520, 495530, 49127`）。理论上可用 tracker 的
`SUnitPositionsEvent` 找最近的己方 Nexus，把行渲染成 `星空加速 → Nexus`。
**不建议现在做**：旧站点本来就没有这个信息，属于新增功能；且位置匹配有误差、需要新数据源。
先把 A/B 做完，C 单独立项。

---

## 6. 验收策略

`scripts/verify-build-order.mjs` 目前把 baseline 的 recall 行**整体排除**（`TOTALS.recallSkipped`）。
修复后改为纳入，规则：

| 检查 | 判据 |
| ---- | ---- |
| 条数 | 每玩家 recall 行数 = 基线 |
| 帧号 | `unit + start_time` 多重集相等（**不按位置对齐** —— 我们按时间插入、基线追加末尾，位置必然不同） |
| 字段 | `_kind === "recall"`、`unit === ""`、`target === null`、`supply === null`、`is_worker === false` |
| 玩家归属 | 必须落到 `Shameless` / `herO`，**不能落到 `Percival` / `Reynor`**（这是最容易错的一步） |
| 指纹 | 新增 `RECALL_FINGERPRINT`：US_TVP = `[427, 739, 937]`、hero = `[1129]`，其余为 `[]` |
| 排序改进 | 显式断言「recall 行已按 `start_time` 归位」，并把与基线的**位置差异记为已声明偏差** |

---

## 7. 玩家归属：为什么必须用两跳桥

基线把 US_TVP 的 3 条记在 **Shameless** 名下，而 sc2reader 报的是 `pid=1`。
我们的 `details.m_playerList` 顺序是 `1=Percival(wss=0) 2=Shameless(wss=1)` ——
**编号口径根本不同**。正确路径是复用 `chrono.ts` 里已验证的两跳桥：

```
SCmdEvent._userid.m_userId = 1
  → initData slots[1] = { uid1, wss1 }
  → details.m_playerList 里 wss=1 → 第 2 个 → pid = 2 → Shameless   ✅
（hero 同理：userId 3 → wss14 → herO ✅）
```

如果贪快用「`userId + 1` = pid」，US_TVP 会落到 Percival、hero 会落到 Reynor —— 与基线完全错位。

---

## 8. 未验证 / 风险清单（诚实版）

- **WoL / HotS 分支未实测** —— 样本全是 LotV。区间表覆盖了 WoL/HotS，但只有 LotV 这两段被真实数据验证过。
- **`flags = 256` 的含义未查** —— 未确认它是否需要参与判据（当前不用它）。
- **`MassRecallMothership` / `MothershipMassRecall` / `MassRecallMothershipCore` 三个能力在样本里没出现过**
  —— 只验证了 `NexusMassRecall`。另外三个的 id 来自静态枚举，未做动态验证。
  它们的 datapack 区间实测已过期（HotS 时代），现代录像里理论上不会出现。
- **单份 `abilities.csv` 内存在重复 `int_id`**（如 `LotV/48258` 里 `int_id 68` 同时对应
  `CarrierLaunchSpeedUpgrade` / `PhoenixRangeUpgrade`）。这不影响两族的判定结果
  （那两族名字不重名），但说明该表不能当成严格的 `int_id ↔ 名字` 双射。
- **`m_abilLink` 随补丁漂移是普遍现象，不止这三对** —— 本次只枚举了 chrono / recall 两族。
  将来若再加别的能力族（如 `TRACKED_ABILITIES` 里的技能），**必须同样走区间化**，不要用并集。
- **`SCmdUpdateTargetPointEvent` 为何不带 `m_abil`** 未深究（实测 2064 条、0 条带能力）。

---

## 9. 影响面

| 文件 | 动作 |
| ---- | ---- |
| `scripts/gen-ability-links.py` | 新增（由 research 脚本提升，支持 `--check`） |
| `js/worker/decoder/data/ability_links.generated.ts` | 新增（codegen，25 条区间） |
| `js/worker/decoder/recall.ts` | 新增（`collectRecalls` + `mergeRecalls`） |
| `js/worker/decoder/chrono.ts` | 改：删并集常量 → 接 `links` 参数；新增 `expansionFromDetails()` |
| `scripts/verify-build-order.mjs` | 改：纳入 recall 行 + 区间矩阵自测 + 3 组指纹 + 排序断言 |
| `js/worker/decoder/build_order.ts` | **代码不改**，仅更新头部注释（指向 `recall.ts`） |
| `ReplayData` 组装 | **不属于本次** —— 与 `chat` / `stats` 等一起在下一里程碑做 |

---

## 10. 实现记录（2026-09-21）

方案 B 已按 §5 全部落地。**验收：`verify-build-order` 178 项断言全绿，退出码 0。**

### 10.1 与调研结论的两处偏差（都是实现时才发现，已写回文档）

1. **区间语义是「优先级 + 首个匹配」，不是「按 lo 排序的显式窗口」** —— 见 §4 的修正框。
   codegen 按 sc2reader 的注册顺序取反排列，查询取首个匹配；有效窗口仅作为注释。
2. **资料片改用依赖 hash 判定（新增 `expansionFromDetails`）**。原计划里资料片只由
   `expansionFromBaseBuild(build)` 这种 build 号启发式给，但 sc2reader 实际用的是
   `details.cache_handles` 里 `Standard Data: Void/Swarm/Liberty.SC2Mod` 的 sha256
   （`resources.py:394-410`，`if/elif` 顺序，Void 优先）。而 `HotS/38215`（`38215 ≤ b`）
   与 `LotV/base`（`34784 ≤ b`）在数值上重叠，**build 号根本无法唯一确定资料片**。
   实测：一份 LotV 录像的 9 条 cacheHandles 里，Void / Swarm / Liberty 三份依赖**同时存在**
   （句柄格式 `fourcc(4) + uint32(4) + sha256(32)`，hash 在偏移 8..40）。
   5 个样本两种判法结果都是 `LotV`，所以是**零回归**的加固，不是行为变更。

### 10.2 验收证据

```
基线条目（含 recall）        2370        ← 2366 + 4 条 recall
严格逐条一致                  1955
严格不一致（应为 0）          0
未解释条目（应为 0）          0
命中时空加速                  65          ← 与区间化改造前**完全一致**（零回归）
星空加速行 recall 基线/我们   4 / 4
严格一致 82.49% ｜ 在解释范围内 100.00%
断言：178 通过 / 0 失败
```

区间化零回归的独立证据：`命中时空加速 65`、各录像 `区间数 5/1/23/0/25` 与改造前逐条相同。

### 10.3 玩家归属与排序（实测输出）

| 录像 | 玩家 | 原始指令 | 归位后位置 | 基线位置 |
| ---- | ---- | -------- | ---------- | -------- |
| US_TVP | Shameless (pid 2) | `link 724 / cmd 0 / userId 1`，帧 6835 / 11830 / 15004 → 427 / 739 / 937 | **70 / 142 / 190**（共 339） | 335 / 336 / 337（共 338）**追加末尾** |
| hero | herO (pid 2) | `link 724 / cmd 0 / userId 3`，帧 18065 → 1129 | **273**（共 329） | 328（共 329）**追加末尾** |

- **玩家归属**：`userId 1 → pid 2 = Shameless`（不是 Percival）、`userId 3 → pid 2 = herO`
  （不是 Reynor），两跳桥验证通过。用 `userId + 1` 会分别错落到 Percival / Reynor。
- **排序改进**：我们按帧归位（如 427s 落在 `Nexus@419` 与 `Stalker@428` 之间），
  基线全部堆在末尾 —— 与 README `build-260412` 记录的旧 bug 完全吻合。
  验收脚本把这个**位置差**登记为已声明偏差，另用「整体按帧非递减」断言钉住改进本身。

### 10.4 本次新增/更新的防回归断言

| 断言 | 作用 |
| ---- | ---- |
| 区间查询矩阵自测（27 例） | 上下界（95121/95122、97363/97364、89633/89634、34783/34784、44400/44401）、资料片隔离（同一 build 在 WoL/HotS/LotV 下取不同表）、`expansion=null` → 空集 |
| `ABILITY_LINKS_FINGERPRINT` | 每张录像解析出的 chrono/recall 集合 —— 防「查询键用错」（传 `m_baseBuild`、传错资料片） |
| `RECALL_FINGERPRINT`（玩家级） | 同时钉住**玩家归属**与帧号；未列出的玩家必须为 `[]` |
| recall 行字段形状 | `_kind/unit/target/supply/is_worker` 五项全判 |
| 建造表按帧非递减 | 钉住「有序插入」这个改进本身 |
| `FINGERPRINT.expansion` | 资料片必须由**依赖 hash** 判出（不是 build 号兜底） |
| `collectChronoBoosts` 缺 `links` 抛错 | JS 调用方误传并集/漏传时立刻炸，不再静默用错集合 |

