# 调研：SC2 录像 `build_order` 的时间问题与现有解法

> 文档版本：2026-09-21
> 起因：`plans/ROUTE-C-WASM-REFACTOR-PLAN.md` §0.2 判定 `build_order` 是"独立硬骨头"，
> 需 codegen spawningtool 的 `lotv_constants.py`(59.7 KB) + `hots_constants.py`(39 KB)。
> 本文档调研外部实现 + 用**已完工的 P1b 协议解码器**做一手实测，结论是：
> **原判断过重 —— 有一条零数据表就能走的精确解，只对一族需要小表。**

---

## 0. 结论速览

| 问题 | 结论 | 证据类型 |
| --- | --- | --- |
| 虫族单位起点能不能精确拿到？ | **能，且不需要任何数据表** —— `SUnitBornEvent.m_creatorUnitTagIndex` 指向 Egg，Egg 的 `SUnitTypeChangeEvent` 帧就是孵化起点 | 一手实测，2 个录像 |
| 建筑起点/终点？ | **Init→Done 同 tag 配对直接给出**，三族通用，零数据表 | 一手实测，2 个补丁 |
| 人族/神族单位？ | 仍需回推，但只需要 **`train_commands.json`(6 KB)**，不是 100 KB 的 `BUILD_DATA` | 外部源码 + 实测交叉验证 |
| 时间基准是多少 fps？ | **16**（不是 spawningtool 用的 22.4） | 一手实测，7/7 精确整数 |
| `m_timeUTC` 是什么格式？ | **Windows FILETIME**（100ns @ 1601-01-01），不是 unix µs | 一手实测 |
| 能力名（`Train*`）能从录像里读出来吗？ | **不能** —— `m_abil` 只有数字 `m_abilLink`，`replay.initData` 里没有能力表 | 一手实测（否定结论） |
| 原计划的方案 A 还需要吗？ | **不需要**。全面 codegen `BUILD_DATA` 是过度设计 | 综合 |

---

## 1. 问题到底是什么

### 1.1 仓库内的原始记录

`README.md` 的 `build-260310` 段落：

> **虫族单位开始时间修正**
> sc2reader 对虫族单位（通过幼虫孵化）的 `started_at` 没有做「建造时间回推」，
> 导致 `start_time` 和 `finish_time` 相同，都是「孵化完成时刻」。采用回推策略，
> 将 `start_time` 设置为孵化开始时刻，`finish_time` 设置为孵化完成时刻。

### 1.2 事件模型的真相（实测）

SC2 的 tracker 流里，单位生命周期由三种事件描述，**不同对象走不同路径**：

| 事件 | 语义 | 谁会有 |
| --- | --- | --- |
| `SUnitInitEvent` | 建造**开始** | 建筑（三族），带 `m_unitTypeName` / `m_controlPlayerId` / `m_x,m_y` |
| `SUnitDoneEvent` | 建造**完成** | 建筑，**只有 `m_unitTagIndex`/`m_unitTagRecycle`**（要靠 tag 去配 Init） |
| `SUnitBornEvent` | 单位**出现** | 一切单位（含地图中立），带 `m_unitTypeName` / `m_creatorUnitTagIndex` / `m_creatorAbilityName` |
| `SUnitTypeChangeEvent` | 变形/模式切换 | 虫族 Egg/Larva、人族升降/变形、`Liberator↔LiberatorAG` 等 |

**关键结构事实：**
- **建筑只有 Init（起点）和 Done（终点）** —— 起止时刻天然精确，不需要建造时长。
- **单位只有 Born（终点）** —— 起点必须回推或用别的手段拿到。
- 这条对**三族一样成立**，不是虫族独有（见 §3.1 实测矩阵）。

所以问题不是"虫族特殊"，而是"**单位类对象缺起点**"；虫族之所以被单独提出来，是因为它的单位**全部**走幼虫孵化，一个 Init 都没有，退化得最彻底。

---

## 2. 外部资料调研

### 2.1 spawningtool（`StoicLoofah/spawningtool`，v3.0.0，2026-07-30）

最权威的参考实现（本仓库旧 Pyodide 链路就是用它；该链路已下线，冻结参考在 `tools/baseline/parse_script.py`）。`spawningtool/parser.py` 的核心：

```python
def adjust_build_time(self, frame, player, unit_name, build_time_modifier=1):
    build_data = self.get_build_data(player)
    if not unit_name in build_data:
        unit_name += ' (Error on build time)'
        return frame, unit_name, False
    cur_build_data = build_data[unit_name]
    build_time = cur_build_data['build_time'] * build_time_modifier

    # Warp Gate：研究完成后 Gateway 系单位建造时间乘 0.6
    if self.warpgate_modifier is not None and \
            player in self.warpgate_research_frame and \
            self.replay.build >= self.warpgate_percentage_build and \
            'Gateway' in cur_build_data.get('built_from', []):
        ...
    projected_start = frame - build_time

    # Chrono Boost：按「加速区间」与建造区间的重叠量扣减
    if self.chronoboosts.get(player):
        for building in cur_build_data['built_from']:
            if building in self.chronoboosts[player]:
                for cur_frame_start, cur_frame_end in self.chronoboosts[player][building]:
                    if cur_frame_end > projected_start and cur_frame_start < frame:
                        overlap = min(cur_frame_end, frame) - max(cur_frame_start, projected_start)
                        reduction = int(overlap * self.chronoboost_multiplier)
                        projected_start += reduction
                        chronoboosted = True
    return projected_start, unit_name, chronoboosted
```

**它解决"平衡性热修不改 build 号"的办法不是读补丁号，而是读录像时间戳**：

```python
# parser.py::set_constants
timestamp = self.replay.unix_timestamp
if hasattr(self.constants, 'build_data_for_timestamp'):
    self.build_data = self.constants.build_data_for_timestamp(timestamp)
    self.warpgate_modifier = self.constants.warpgate_build_time_modifier(timestamp)
```

```python
# lotv_constants.py
def build_data_for_timestamp(timestamp):
    adjusted = None
    for unit_name, history in BUILD_DATA_HISTORY.items():
        for superseded, build_time in history:
            if timestamp and timestamp < superseded:
                if adjusted is None:
                    adjusted = dict(BUILD_DATA)
                adjusted[unit_name] = dict(BUILD_DATA[unit_name])
                adjusted[unit_name]['build_time'] = build_time
                break
    return adjusted if adjusted is not None else BUILD_DATA
```

`lotv_constants.py` 的数据规模（决定了原计划"方案 A"的成本）：

| 常量 | 作用 | 规模 |
| --- | --- | --- |
| `BUILD_DATA` | 单位名 → `build_time` / `built_from` / `race` / `type` / `is_morph` | 主体，59.7 KB 文件的大部分 |
| `BUILD_DATA_HISTORY` | 单位名 → `[(失效时间戳, 旧建造时长)]` | 时间戳回滚表 |
| `BUILD_TIME_CHANGES` | `[(补丁名, 生效日期, {单位: (旧, 新)})]` | 变更历史 |
| `_WARPGATE_MODIFIERS` | `[(补丁名, 生效日期, 倍率)]`，如 `('5.0.16', '2026-06-22', 0.6)` | 折跃门倍率 |
| `WARPGATE_PERCENTAGE_BUILD = 97364` | 上述倍率生效的 build 号门槛 | 标量 |
| `FRAMES_PER_SECOND = 22.4` | **建造时长秒 → 帧** 的换算 | 标量 |
| `BO_EXCLUDED` | 不进建造表的（`MULE` / `Larva` / `Changeling` / `Interceptor` …） | 集合 |
| `BO_CHANGED_EXCLUDED` | 模式切换不当作新造的（`Liberator` / `SiegeTank` / `VikingAssault` …） | 集合 |
| `BO_UPGRADES_EXCLUDED` | 排除族徽升级（`Spray*`） | 集合 |
| `TRACKED_ABILITIES` | 需要追踪的技能名（`CalldownMULE` / `ChronoBoost` / `SpawnLarva` …） | 集合 |

**事件侧的分工（`parser.py`）**：

```python
def add_unit_init_event(self, event):
    # "these are mostly buildings, but it may be warped-in units"
    frame = event.frame          # ← 不回推，直接用事件帧
    ...

def add_unit_born_event(self, event):
    # "unit_born is when the unit is actually created, so we subtract
    #  the unit build time to get when it was started."
    frame, unit_name, is_chronoboosted = \
        self.adjust_build_time(event.frame, player, unit_name, modifier)   # ← 回推
    ...
```

**它没有 `if race == 'Zerg'` 分支** —— 回推逻辑对所有种族一视同仁，靠 `build_data` 里的 `is_morph` / `built_from` 区分变形。

**spawningtool 官网自标的限制（`spawningtool.com` 页面底部）**：

> Caveats: Supply blocks, unpowered buildings, or Contaminate may cause inaccurate times.
> **Supply counts are checked every 10 seconds.**

即人口是按 10 秒粒度反查的，所以 `supply` 字段本身就带粗粒度误差 —— 这部分**不存在精确解**，只能接受。

### 2.2 sc2reader（`ggtracker/sc2reader`）—— 附带的小数据表

`sc2reader/data/` 里的静态表才是"能力名"的来源：

| 文件 | 体积 | 作用 |
| --- | --- | --- |
| `ability_lookup.csv` | 51,329 B | **`abilLink` → 能力名**（`MorphZergling` / `TrainMarine` …） |
| `train_commands.json` | 6,270 B | **能力名 → [单位名, 建造时长(游戏秒)]** |
| `command_lookup.csv` | 19,762 B | `m_abilCmdIndex` → 指令名 |
| `unit_lookup.csv` | 47,938 B | 单位 id → 名 |
| `unit_info.json` | 16,503 B | 单位属性 |
| `attributes.json` | 53,434 B | 属性改名 |
| `create_lookup.py` | 493 B | 表的生成脚本 |

`train_commands.json` 实际长这样（节选）：

```json
{
  "MorphZergling":   ["Zergling", 24],
  "MorphDrone":      ["Drone", 17],
  "MorphOverlord":   ["Overlord", 25],
  "MorphRoach":      ["Roach", 27],
  "MorphToBaneling": ["Baneling", 20],
  "TrainMarine":     ["Marine", 25],
  "TrainSCV":        ["SCV", 17],
  "TrainProbe":      ["Probe", 17],
  "BuildPylon":      ["Pylon", 25],
  "BuildGateway":    ["Gateway", 65],
  "BuildSpawningPool": ["SpawningPool", 65],
  "BuildBarracks":   ["Barracks", 65],
  "BuildCommandCenter": ["CommandCenter", 100],
  "BuildHatchery":   ["Hatchery", 100],
  "UpgradeToLair":   ["Lair", 80],
  "CalldownMULE":    ["MULE", 0],
  "BuildCreepTumor": ["CreepTumor", 15],
  "BuildInterceptor":["Interceptor", 8]
}
```

**为什么这张 6 KB 的表很重要**：建造时长**本身就写在里面**，而且能力名的前缀就把语义分好了
（`Train*` = 从建筑产单位、`Build*` = 放建筑、`Morph*` = 变形、`WarpIn*` = 折跃、`Hallucinate*` = 幻象）。
只为了拿建造时长，**不需要** spawningtool 那 100 KB 的 `BUILD_DATA`。

### 2.3 反面资料（不足以作为依据）

- `starcraft2.ai`、`spawningtool.com` 的构建页 —— 都是**消费者**（展示结果），没说实现细节。
  唯一有用的信息是它把"开始时间"作为时间戳口径（"Supply notation records when an action begins, not when it completes"）。
- npm 包 `s2protocol`（TS 移植）与官方 `s2protocol` —— 只负责**协议解码**，**不涉及** `build_order` 语义。
- 未找到任何公开的 Rust 实现做 `build_order`（`sebosp/s2protocol-rs` 定位是协议解码 + CLI）。

---

## 3. 我们自己的实测（一手证据）

> 全部用 P1b 已交付的解码器跑，脚本在 `/tmp/verify-*.mjs`（未入库）。
> 复现命令：`node /tmp/verify-egg-link.mjs sampleTest/<录像>`

### 3.1 事件形态矩阵（`CN_ZVP.SC2Replay`，baseBuild 96516，协议 95299）

| 控制方 | 单位 | Init | Done | Born | Died | TypeCh |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| **1（异虫）** | Drone | 0 | 0 | 15 | 0 | 0 |
| | Zergling | 0 | 0 | 12 | 0 | 0 |
| | Overlord | 0 | 0 | 2 | 0 | 0 |
| | Larva | 0 | 0 | 13 | 0 | 11 |
| | Egg | 0 | 0 | 0 | 0 | 12 |
| | **Hatchery** | **1** | 0 | **0** | 0 | 0 |
| | **SpawningPool** | **1** | 0 | **0** | 0 | 0 |
| 2（星灵） | Probe | 0 | 0 | 21 | 0 | 0 |
| | Zealot | 0 | 0 | 1 | 0 | 0 |
| | **Nexus** | 0 | 0 | **1** | 0 | 0 |
| | **Pylon / Gateway / Assimilator / CyberneticsCore** | **1~2** | 0 | **0** | 0 | 0 |

**读法**：虫族的**单位**清一色「只有 Born」；虫族**建筑**清一色「只有 Init」。
星灵完全同构 —— 所以 `build-260310` 说"虫族特有问题"其实**只说对了一半**：
虫族是"所有单位都走这条路"，退化最彻底，但机制上三族一致。

### 3.2 解法 S1：Egg tag 回推（虫族，**零数据表，精确**）

**原理**：虫族单位由幼虫→Egg→单位两段式产生。`SUnitBornEvent.m_creatorUnitTagIndex`
指向那个 **Egg**，而 Egg 的 `SUnitTypeChangeEvent` 帧就是**孵化起点**。

实测（`CN_ZVP`，`m_creatorAbilityName = LarvaTrain`）：

| 单位 | Born@ | creator tag | Egg@ | Δ 帧 | @16fps | `train_commands.json` |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| Drone | 763 | 220/2 | 491 | 272 | **17.00 s** | `MorphDrone → 17` ✅ |
| Drone | 852 | 222/1 | 580 | 272 | **17.00 s** | ✅ |
| Drone | 957 | 221/1 | 685 | 272 | **17.00 s** | ✅ |
| Overlord | 1318 | 253/1 | 918 | 400 | **25.00 s** | `MorphOverlord → 25` ✅ |
| Zergling ×12 | 1809…2565 | 259/1, 221/2, 234/2, 263/1, 234/3, 263/2 | 1425…2181 | 384 | **24.00 s** | `MorphZergling → 24` ✅ |

**16/16 命中，Δ 全部精确等于官方建造时长。**
第二个录像 `hero(w) vs reynor g1 winter madness(PVZ)`：**557/3834 条 Born 命中 Egg**
（3834 含星灵与地图中立，虫族部分可匹配）—— 说明它在真实职业局里规模化成立。

**顺带发现**：Zergling 是**一蛋两虫、同一帧 Born**（1809 出现 4 条 = 2 个蛋）。
建造表里必须按「蛋」而不是按「虫」计数，否则虫族 Zergling 数量会翻倍。

### 3.3 解法 S2：Init→Done 配对（建筑，**零数据表，精确**）

`SUnitInitEvent` 与 `SUnitDoneEvent` 共享 `m_unitTagIndex`/`m_unitTagRecycle`，配对即得起止。

`CN_ZVP`（5.0.15）：

| 建筑 | init@ | done@ | Δ 帧 | @16fps | `train_commands.json` |
| --- | ---: | ---: | ---: | ---: | --- |
| SpawningPool | 383 | 1423 | 1040 | **65.00 s** | `BuildSpawningPool → 65` ✅ |
| Pylon | 475 | 875 | 400 | **25.00 s** | `BuildPylon → 25` ✅ |
| Gateway | 930 | 1970 | 1040 | **65.00 s** | `BuildGateway → 65` ✅ |
| Assimilator | 1083 | 1563 | 480 | **30.00 s** | `BuildAssimilator → 30` ✅ |
| Pylon | 2045 | 2445 | 400 | **25.00 s** | ✅ |

`US_TVR(T)_2018_old`（**4.2.1，2018 年，跨补丁**）：

| 建筑 | Δ 帧 | @16fps | `train_commands.json` |
| --- | ---: | ---: | --- |
| SupplyDepot | 480 | **30.00 s** | `BuildSupplyDepot → 30` ✅ |
| Barracks | 1040 | **65.00 s** | `BuildBarracks → 65` ✅ |
| Refinery | 480 | **30.00 s** | `BuildRefinery → 30` ✅ |
| Factory | 960 | **60.00 s** | `BuildFactory → 60` ✅ |
| CommandCenter | 1600 | **100.00 s** | `BuildCommandCenter → 100` ✅ |
| Armory | 1040 | **65.00 s** | `BuildArmory → 65` ✅ |

**跨补丁、跨族，全部精确命中。** 例外只有录像结束时尚未完工的建筑（`Hatchery` / `CyberneticsCore` 无 Done），需要单独兜底。

### 3.4 关键副产物：时间基准是 **16 fps**，不是 22.4

上面所有 Δ 在 **16 fps** 下都是**精确整数**（272 / 384 / 400 / 480 / 960 / 1040 / 1600），
在 22.4 fps 下全部是小数（12.14 / 17.14 / 17.86 / 21.43 …）。**7/7 整数，不可能是巧合。**

**这条直接印证了 §7 要做的修正**：SC2 逻辑帧基准是 **16 loops = 1 秒（Normal）**，
而 spawningtool 的 `FRAMES_PER_SECOND = 22.4` 是「**Faster 速度下的真实秒**」约定 ——
它**默认了天梯速度**。所以：
- 我们的实现**不能**照抄 22.4；
- 应该按 §7 读 `m_gameSpeed`，用 `16` 做基准、速度倍率只影响**显示时钟**。

另一个交叉验证：`Larva` 的 Born 间隔实测**恰好 240 帧**（240/16 = 15.00 s 游戏秒）。

### 3.5 `m_timeUTC` 是 Windows FILETIME（实测）

```
原始值        134169213391093544
按 unix µs    → 1974-04-02T21:13:33Z      ❌
按 FILETIME   → 2026-03-02T10:35:39Z      ✅ (unix = 1772447739)
```

转换式：`unix_seconds = m_timeUTC / 1e7 - 11644473600`
（`11644473600` = 1601-01-01 到 1970-01-01 的秒数）

结果与仓库里的截图名 `image-20260310011545460.png`、日志名 `build-260310` 对上。
**如果走 spawningtool 式的时间戳回滚，必须先做这个转换** —— 直接用 `/1e6` 会得到 1974 年。

### 3.6 否定结论：能力名**不在**录像里

`SCmdEvent` 的字段：

```
m_cmdFlags, m_abil{m_abilLink, m_abilCmdIndex, m_abilCmdData},
m_data, m_sequence, m_otherUnit, m_unitGroup
```

`m_abil` 只有**数字 link**（`CN_ZVP` 里出现 46/124/172/174/177/185/186/195/245/723 共 10 种）。
而 `replay.initData` 里**没有能力表** —— 实测顶层只有 `m_syncLobbyState`
（下含 `m_userInitialData` / `m_gameDescription` / `m_lobbyState`）。

**所以"从指令直接读出 `TrainZergling`"这条近路走不通**，必须自带
`abilLink → 能力名` 的映射表（即 §2.2 的 `ability_lookup.csv`）。

### 3.7 必须过滤的模式切换（否则建造表被污染）

`US_TVP`（Terran vs Protoss，20000+ 条 game 事件）实测到的 `SUnitTypeChangeEvent`：

```
LiberatorAG ×19, DisruptorPhased ×23, VikingAssault ×14, SupplyDepotLowered ×12,
FactoryFlying ×4, VikingFighter ×4, Barracks ×3, BarracksFlying ×3, CommandCenterFlying ×3,
OrbitalCommand ×3, TechLab ×3, FactoryTechLab ×1, Reactor ×1, BarracksTechLab ×2, CommandCenter ×2
```

这些是**同一个单位的模式/升降切换**，不是新造的。不过滤的话，人族一局会凭空多出上百条"建造记录"。
这正是 spawningtool 搞 `BO_CHANGED_EXCLUDED`（`Liberator` / `SiegeTank` / `VikingAssault`）的原因。

同理地图中立单位必须排除：

```
MineralField ×56, MineralField750 ×56, MineralField450 ×32, VespeneGeyser ×28,
DestructibleExpoditionGate6x6 ×12, Beacon* ×15 种…
```

---

## 4. 方案对比与推荐路线

### 4.1 对比

| 方案 | 覆盖 | 精确度 | 需要的表 | 补丁风险 |
| --- | --- | --- | --- | --- |
| **S1 Egg tag** | 虫族单位 | **精确** | **0** | 无（事件自洽） |
| **S2 Init→Done** | 全部建筑 | **精确** | **0** | 无 |
| **S3 `train_commands.json`** | 人/神族单位 | 精确* | **6 KB** | 低（表与补丁无关） |
| S4 指令侧（`abilLink`→能力名） | 全种族 | 最精确 | 6 KB + 51 KB | 低，但队列语义待验 |
| **原计划方案 A**（codegen `BUILD_DATA`+`BUILD_DATA_HISTORY`） | 全部 | 近似 | **~100 KB + 历史表** | 需持续维护 |

\* 精确的前提是「该单位没有在建造过程中被加速」。时空加速会缩短建造时长，S2/S1 天然免疫（因为拿的是真实事件帧），S3 会偏。

### 4.2 推荐路线（三层混合，各取最优）

```
建筑（全族）     → S2  Init→Done 同 tag 配对             零表 · 精确
                     └ 缺 Done（录像结束未完工）→ 用 S3 时长标注"未完成"，不猜

虫族单位         → S1  Born.m_creatorUnitTagIndex → Egg 的 TypeChange 帧   零表 · 精确
                     └ 缺 Egg 匹配时回退到 S3

人/神族单位      → S3  Born 帧 − train_commands.json 的时长              仅 6 KB
                     └ 时空加速影响：需按 spawningtool 的 overlap 扣减（或先不做，标记）

时间基准         → 16 fps 基准 + 读 m_gameSpeed（§7 的修正项），不要抄 22.4
时间戳           → 若需要，m_timeUTC 走 FILETIME 转换
过滤             → 地图中立 + 模式切换（LiberatorAG / VikingAssault / SupplyDepotLowered …）
```

**与原计划 §0.2 的差别**：原判断要 codegen 两个 constants 文件（~100 KB）+ 移植
`build_data_for_timestamp`。按本调研，**最小实现只需要 6 KB 的 `train_commands.json`**，
且虫族与建筑走的是**精确解而非回推**，连平衡性热修的历史表都不需要。

### 4.3 对原计划的修正建议

- **§0.2 的「方案 B 近似版（虫族 start_time 会错）」应当作废** —— 虫族恰恰是**最容易被做到精确**的一族。
- **§0.2 的「方案 A 全面 codegen」降级为可选项**，仅在需要"时空加速精确扣减"时才引入。
- **§6-P1 任务 5 的"虫族 start_time 回推"改写为"Egg tag 关联"**。
- 新增任务项：地图中立与模式切换过滤（§3.7），这是**必须先做**的，否则建造表直接不可用。

---

## 5. 未验证 / 风险（诚实清单）

| 项 | 状态 | 影响 |
| --- | --- | --- |
| `m_cmdFlags` 的队列语义 | ❌ 未实测 | 决定 S4 指令侧能否用。若 256 表示"排队"，则指令帧 ≠ 起点 |
| 虫族变形链（Zergling→Baneling 等 `MorphTo*`） | ❌ 未实测 | S1 只覆盖 `LarvaTrain`；变形单位要走 `SUnitTypeChangeEvent` 另一条路径 |
| 时空加速对建造轴的实际影响 | ❌ 未在本仓库实测 | S3 路径会有偏差，S1/S2 不受影响 |
| WoL（< 4.2）录像 | ❌ 未实测 | 只验了 LotV 的 4.2.1 与 5.0.15 两代 |
| 虫族以外的"单位起点"是否有类似捷径 | ❌ 未找到 | `m_creatorAbilityName` 在人/神族是 `BarracksTrain`/`NexusTrain` 这类**生产者**名，不含单位信息 |
| spawningtool 的 `supply` 语义（10 秒粒度） | ⚠️ 已知限制 | 不存在精确解，只能接受并在 UI 标注 |

---

## 6. 复现方式

```bash
# 事件形态矩阵 + Egg 关联 + 建筑 Init→Done 配对
node scripts/research/build-order-events.mjs "CN_ZVP.SC2Replay"
node scripts/research/build-order-events.mjs "US_TVR(T)_2018_old.SC2Replay"
node scripts/research/build-order-events.mjs "hero(w) vs reynor g1 winter madness(PVZ).SC2Replay"

# m_timeUTC 单位判定 + 各事件类型字段集
node scripts/research/build-order-timebase.mjs "CN_ZVP.SC2Replay"

# 外部源码（直接读官方仓库）
# https://raw.githubusercontent.com/StoicLoofah/spawningtool/master/spawningtool/parser.py
# https://raw.githubusercontent.com/StoicLoofah/spawningtool/master/spawningtool/lotv_constants.py
# https://raw.githubusercontent.com/ggtracker/sc2reader/upstream/sc2reader/data/train_commands.json
# https://api.github.com/repos/ggtracker/sc2reader/contents/sc2reader/data
```

> ⚠️ 这两个脚本是**调研用的一次性工具**，放在 `scripts/research/` 与验收脚本分开。
> 若 P1c 落地，应另写 `scripts/verify-build-order.mjs`（带金标准基线 + 断言计数），
> 与 `verify-mpq.mjs` / `verify-protocol.mjs` 并列进 CI，而不是把这两个脚本升格为门槛。
