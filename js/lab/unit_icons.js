/* ============================================================================
   单位/科技图标名解析 —— 沙盘视图与建造顺序视图共用的唯一实现。

   图标文件在 `assets/units/<Name>.webp`（256×256，222 张，命名与 tracker 单位名
   基本一致，来自 starcraft2.ai 的图标集，素材版权归 Blizzard Entertainment、
   粉丝非商用）。可用名单见 `unit_icons.generated.js`（由脚本从磁盘清单生成）。

   tracker/升级的内部名与图标文件名有出入的，集中在 `iconKey` / `upgradeIconKey`
   两张映射表里归一；名单里没有的名字一律返回 false（调用方走文字/点阵兜底，
   **不要发起图片请求** —— canvas 的 onerror 是静默的，DOM 的 <img> 会真打 404）。
   ============================================================================ */

import { UNIT_ICONS } from "./unit_icons.generated.js";

export const ICON_DIR = "assets/units";

/** 单位名 → 图标文件名（不含扩展名）。变体在链尾归一。 */
export function iconKey(name) {
  return String(name)
    .replace(/Flying$/, "")
    .replace(/Burrowed$/, "")                                  // 钻地态 → 本体
    .replace(/^(Barracks|Factory|Starport)TechLab$/, "TechLab")
    .replace(/^(Barracks|Factory|Starport)Reactor$/, "Reactor")
    .replace(/LiberatorAG$/, "Liberator")
    .replace(/Viking(Assault|Fighter)$/, "Viking")
    .replace(/ThorAP$/, "Thor")
    .replace(/LurkerMP(Egg)?$/, "Lurker")                      // 图标集没有 LurkerMP 系
    .replace(/GhostAlternate$/, "Ghost")
    .replace(/AdeptPhaseShift$/, "Adept")
    .replace(/BattleHellion$/, "Hellion")
    .replace(/CreepTumorQueen$/, "CreepTumor")
    .replace(/ObserverSiegeMode$/, "Observer")
    .replace(/OverseerSiegeMode$/, "Overseer")
    .replace(/OverlordTransport$/, "Overlord")
    .replace(/OracleStasisTrap$/, "Oracle")
    .replace(/RavagerCocoon$/, "Ravager")
    .replace(/TemplarArchive$/, "TemplarArchives")     // 图标集带 s，tracker 不带
    .replace(/DisruptorPhased$/, "Disruptor")
    .replace(/LurkerDenMP$/, "LurkerDen")
    .replace(/^Nuke$/, "Ghost");                        // 核弹无独立图标 → 幽灵（行名仍是核弹）
}

/** 科技升级名 → 图标名（`SUpgradeEvent` 的内部名与图标集差异较大，集中在此映射）。 */
const UPGRADE_ICON_MAP = [
  [/^TerranInfantryArmorsLevel/, "TerranInfantryArmorLevel"],           // tracker 复数 → 图标单数（LevelN 保留）
  [/^ProtossGroundArmorsLevel/, "ProtossGroundArmorLevel"],
  [/^TerranVehicleAndShipArmorsLevel/, "TerranVehicleAndShipPlatingLevel"],
  [/^ProtossAirArmorsLevel/, "ProtossAirArmorLevel"],
  [/^ZergFlyerArmorsLevel/, "ZergFlyerArmorLevel"],
  [/^ZergGroundArmorsLevel/, "ZergGroundArmorLevel"],
  [/^EvolveGroundCarapace/, "ZergGroundArmor"],
  [/^EvolveFlyerAttack/, "ZergFlyerWeapons"],
  [/^EvolveFlyerCarapace/, "ZergFlyerArmor"],
  [/^Evolve/, ""],                                             // 其余 zerg 剥前缀（GroovedSpines 等）
  [/^NeosteelFrame$/, "NeosteelArmor"],
  [/^zerglingattackspeed$/i, "AdrenalGlands"],
  [/^zerglingmovementspeed$/i, "MetabolicBoost"],
  [/^BlinkTech$/, "Blink"],
  [/^PsiStormTech$/, "PsionicStorm"],
  [/^CentrificalHooks$/, "CentrifugalHooks"],                  // tracker 拼写少个 u
  [/^PunisherGrenades$/, "ConcussiveShells"],                  // 光头的震慑弹内部名
  [/^(LurkerRange|DiggingClaws)$/, "SeismicSpines"],
  [/^BattlecruiserEnableSpecializations$/, "WeaponRefit"],
  [/^LiberatorAGRangeUpgrade$/, "LiberatorAG"],
  [/^AdeptResonatingGlaives$/, "ResonatingGlaives"],
  [/^DarkTemplarShadowStride$/, "ShadowStride"],
  [/^HellionPreIgniter$/, "InfernalPreIgniter"],
  [/^NeuralParasiteTech$/, "NeuralParasite"],
  [/^PathogenGlandsTech$/, "PathogenGlands"],
  // 具名升级 → 所属单位的图标（图标集没有独立升级图标，借单位图 + 中文名 tooltip 表达）
  [/^Banshee(Cloak|Speed)$/, "Banshee"],
  [/^CycloneRapidFireLaunchers$/, "Cyclone"],
  [/^HighCapacityBarrels$/, "Cyclone"],
  [/^HurricaneThrusters$/, "Cyclone"],
  [/^DarkTemplarBlinkUpgrade$/, "ShadowStride"],
  [/^DrillClaws$/, "WidowMine"],
  [/^Frenzy$/, "Hydralisk"],
  [/^InterferenceMatrix$/, "Raven"],
  [/^RavenCorvidReactor$/, "Raven"],
  [/^MedivacCaduceusReactor$/, "Medivac"],
  [/^ObserverGraviticBooster$/, "Observer"],
  [/^PhoenixRangeUpgrade$/, "Phoenix"],
  [/^ShieldWall$/, "Bunker"],
  [/^TempestGroundAttackUpgrade$/, "Tempest"],
  [/^TerranBuildingArmor$/, "EngineeringBay"],
  [/^VoidRaySpeedUpgrade$/, "VoidRay"],
  [/^overlordspeed$/i, "Overlord"],
];

/** 升级名走专属映射，再回退单位名规则。 */
export function upgradeIconKey(name) {
  const n = String(name);
  for (const [re, rep] of UPGRADE_ICON_MAP) {
    if (re.test(n)) return n.replace(re, rep);
  }
  return iconKey(n);
}

/** 单位名是否命中可用图标。 */
export const hasIcon = (name) => UNIT_ICONS.has(iconKey(name));
/** 升级名是否命中可用图标。 */
export const hasUpgradeIcon = (name) => UNIT_ICONS.has(upgradeIconKey(name));
/** 已归一化 key 直查名单（懒加载缓存层用）。 */
export const hasIconKey = (key) => UNIT_ICONS.has(key);
