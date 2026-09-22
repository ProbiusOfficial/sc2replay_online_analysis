/**
 * 建造时长数据表 —— **自动生成，请勿手改**。
 *
 * 由 `scripts/gen-build-times.py` 从 spawningtool 的 `lotv_constants.py` 产出。
 * 来源：spawningtool 3.0.0（PyPI），源码 sha256 `c90af85de717f7a1d6581bd453d32372838668c7eb181a6e4f061b7249c06f33`。
 *
 * ## 单位约定（关键，先读这段再用）
 *
 * 本文件所有 `loops` 都是 **16 fps 游戏帧**（game loops），不是秒，也不是"暴雪显示秒"。
 * spawningtool 源码里写的是显示秒，它在该模块**导入时**统一做了 `build_time *= 22.4`
 * （`FRAMES_PER_SECOND`），换算完就是游戏帧。这正是 `frame = born_frame - build_time`
 * 量纲自洽的原因 —— 也是本项目实测确认的「时间基准是 16 fps」那条结论的落地点。
 *
 * 所以上层取值时：
 * ```
 * startFrame = bornFrame - BUILD_TIMES[unit].loops;   // 都是 game loop
 * startTime  = Math.trunc(startFrame / 16);           // 与旧链路 `tools/baseline/parse_script.py` 的 `>> 4` 一致
 * ```
 *
 * ## 来源选择依据
 *
 * 备选来源 `sc2reader/data/train_commands.json` 的数值虽精确（16 fps 游戏秒），
 * 但停在 WoL/HotS 时代：Oracle 记 60s 而 LotV 实为 37s，且缺 Cyclone / Liberator /
 * Adept 等 LotV 单位。要与旧链路（已下线的 Pyodide 路径）对齐、且对 LotV 录像正确，只能用本表。
 */

/** 游戏逻辑帧率。SC2 录像的 `_gameloop` 就是这个基准。 */
export const GAME_LOOPS_PER_SECOND = 16;

/** spawningtool 的换算常数；`源码显示秒 × 22.4 = 本表 loops`。 */
export const SPAWNINGTOOL_FRAMES_PER_SECOND = 22.4;

/** 折跃门提速生效的最低 build（`WARPGATE_PERCENTAGE_BUILD`）。低于它的录像不受影响。 */
export const WARPGATE_PERCENTAGE_BUILD = 97364;

/** 单位 / 建筑 / 升级的建造时长。 */
export interface BuildTimeEntry {
  /** 建造耗时，单位 **16 fps 游戏帧**。 */
  loops: number;
  /** 所属种族；升级没有种族时为 null。 */
  race: "T" | "P" | "Z" | null;
  type: "Unit" | "Building" | "Upgrade";
  /** 是否为变形单位（如 Baneling / BroodLord），spawningtool 用它对建筑形态变速。 */
  morph: boolean;
  /** 出兵建筑（spawningtool 的 `built_from`），时空加速 / 折跃门判定要用。 */
  from: string[];
}

export const BUILD_TIMES: Record<string, BuildTimeEntry> = {
  "Adept": { loops: 739.1999999999999, race: "P", type: "Unit", morph: false, from: ["Gateway", "WarpGate"] },
  "AdeptPiercingAttack": { loops: 2240, race: "P", type: "Upgrade", morph: false, from: ["TwilightCouncil"] },
  "AdeptShieldUpgrade": { loops: 1276.8, race: "P", type: "Upgrade", morph: false, from: ["TwilightCouncil"] },
  "AnabolicSynthesis": { loops: 963.1999999999999, race: "Z", type: "Upgrade", morph: false, from: ["UltraliskCavern"] },
  "Archon": { loops: 201.6, race: "P", type: "Unit", morph: false, from: [] },
  "Baneling": { loops: 313.59999999999997, race: "Z", type: "Unit", morph: true, from: [] },
  "Banshee": { loops: 963.1999999999999, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "BansheeCloak": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "BansheeSpeed": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "BattleHellion": { loops: 470.4, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "Battlecruiser": { loops: 1433.6, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "BattlecruiserBehemothReactor": { loops: 1276.8, race: "T", type: "Upgrade", morph: false, from: ["FusionCore"] },
  "BattlecruiserEnableSpecializations": { loops: 2240, race: "T", type: "Upgrade", morph: false, from: ["FusionCore"] },
  "BlinkTech": { loops: 2710.3999999999996, race: "P", type: "Upgrade", morph: false, from: ["TwilightCouncil"] },
  "BroodLord": { loops: 537.5999999999999, race: "Z", type: "Unit", morph: true, from: [] },
  "Burrow": { loops: 1590.3999999999999, race: "Z", type: "Upgrade", morph: false, from: ["Hatchery", "Lair", "Hive"] },
  "Carrier": { loops: 1433.6, race: "P", type: "Unit", morph: false, from: ["Stargate"] },
  "CarrierLaunchSpeedUpgrade": { loops: 1276.8, race: "P", type: "Upgrade", morph: false, from: ["FleetBeacon"] },
  "CentrificalHooks": { loops: 1590.3999999999999, race: "Z", type: "Upgrade", morph: false, from: ["BanelingNest"] },
  "Charge": { loops: 2240, race: "P", type: "Upgrade", morph: false, from: ["TwilightCouncil"] },
  "ChitinousPlating": { loops: 1769.6, race: "Z", type: "Upgrade", morph: false, from: ["UltraliskCavern"] },
  "Colossus": { loops: 1209.6, race: "P", type: "Unit", morph: false, from: ["RoboticsFacility"] },
  "Corruptor": { loops: 649.5999999999999, race: "Z", type: "Unit", morph: false, from: [] },
  "Cyclone": { loops: 716.8, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "CycloneAirUpgrade": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "CycloneLockOnDamageUpgrade": { loops: 2240, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "CycloneLockOnRangeUpgrade": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "CycloneRapidFireLaunchers": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "DarkTemplar": { loops: 896, race: "P", type: "Unit", morph: false, from: ["Gateway", "WarpGate"] },
  "DarkTemplarBlinkUpgrade": { loops: 2240, race: "P", type: "Upgrade", morph: false, from: ["DarkShrine"] },
  "DiggingClaws": { loops: 1276.8, race: "Z", type: "Upgrade", morph: false, from: ["LurkerDenMP"] },
  "Disruptor": { loops: 806.4, race: "P", type: "Unit", morph: false, from: ["RoboticsFacility"] },
  "DrillClaws": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Drone": { loops: 268.79999999999995, race: "Z", type: "Unit", morph: false, from: [] },
  "DurableMaterials": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "EnhancedShockwaves": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["GhostAcademy"] },
  "EvolveGroovedSpines": { loops: 1120, race: "Z", type: "Upgrade", morph: false, from: ["HydraliskDen"] },
  "EvolveMuscularAugments": { loops: 1433.6, race: "Z", type: "Upgrade", morph: false, from: ["HydraliskDen"] },
  "ExtendedThermalLance": { loops: 2240, race: "P", type: "Upgrade", morph: false, from: ["RoboticsBay"] },
  "FlyingLocusts": { loops: 1948.8, race: "Z", type: "Upgrade", morph: false, from: ["InfestationPit"] },
  "Ghost": { loops: 649.5999999999999, race: "T", type: "Unit", morph: false, from: ["Barracks"] },
  "GhostMoebiusReactor": { loops: 1276.8, race: "T", type: "Upgrade", morph: false, from: ["GhostAcademy"] },
  "GlialReconstitution": { loops: 1769.6, race: "Z", type: "Upgrade", morph: false, from: ["RoachWarren"] },
  "GraviticDrive": { loops: 1276.8, race: "P", type: "Upgrade", morph: false, from: ["RoboticsBay"] },
  "GreaterSpire": { loops: 1590.3999999999999, race: "Z", type: "Building", morph: true, from: ["Spire"] },
  "Hellbat": { loops: 470.4, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "Hellion": { loops: 470.4, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "HiSecAutoTracking": { loops: 1276.8, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "HighCapacityBarrels": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "HighTemplar": { loops: 896, race: "P", type: "Unit", morph: false, from: ["Gateway", "WarpGate"] },
  "Hive": { loops: 1590.3999999999999, race: "Z", type: "Building", morph: true, from: ["Lair"] },
  "HurricaneThrusters": { loops: 2240, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Hydralisk": { loops: 537.5999999999999, race: "Z", type: "Unit", morph: false, from: [] },
  "HydraliskSpeedUpgrade": { loops: 1590.3999999999999, race: "Z", type: "Upgrade", morph: false, from: ["HydraliskDen"] },
  "HyperflightRotors": { loops: 2083.2, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Immortal": { loops: 873.5999999999999, race: "P", type: "Unit", morph: false, from: ["RoboticsFacility"] },
  "Infestor": { loops: 806.4, race: "Z", type: "Unit", morph: false, from: [] },
  "InfestorEnergyUpgrade": { loops: 1276.8, race: "Z", type: "Upgrade", morph: false, from: ["InfestationPit"] },
  "InterferenceMatrix": { loops: 1276.8, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Lair": { loops: 1276.8, race: "Z", type: "Building", morph: true, from: ["Hatchery"] },
  "Liberator": { loops: 963.1999999999999, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "LiberatorAGRangeUpgrade": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["FusionCore"] },
  "LocustLifetimeIncrease": { loops: 1948.8, race: "Z", type: "Upgrade", morph: false, from: ["InfestationPit"] },
  "LurkerDenMP": { loops: 1276.8, race: "Z", type: "Building", morph: true, from: ["HydraliskDen"] },
  "LurkerMPEgg": { loops: 0, race: "Z", type: "Building", morph: true, from: ["Hydralisk"] },
  "LurkerRange": { loops: 1276.8, race: "Z", type: "Upgrade", morph: false, from: ["LurkerDenMP"] },
  "MagFieldLaunchers": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Marauder": { loops: 470.4, race: "T", type: "Unit", morph: false, from: ["Barracks"] },
  "Marine": { loops: 403.2, race: "T", type: "Unit", morph: false, from: ["Barracks"] },
  "Medivac": { loops: 672, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "MedivacCaduceusReactor": { loops: 1276.8, race: "T", type: "Upgrade", morph: false, from: ["FusionCore"] },
  "MedivacIncreaseSpeedBoost": { loops: 1276.8, race: "T", type: "Upgrade", morph: false, from: ["FusionCore"] },
  "MicrobialShroud": { loops: 1769.6, race: "Z", type: "Upgrade", morph: false, from: ["InfestationPit"] },
  "Mothership": { loops: 1769.6, race: "P", type: "Unit", morph: false, from: ["Nexus"] },
  "MothershipCore": { loops: 470.4, race: "P", type: "Unit", morph: false, from: ["Nexus"] },
  "Mutalisk": { loops: 537.5999999999999, race: "Z", type: "Unit", morph: false, from: [] },
  "NeosteelFrame": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "NeuralParasite": { loops: 1769.6, race: "Z", type: "Upgrade", morph: false, from: ["InfestationPit"] },
  "Nuke": { loops: 963.1999999999999, race: "T", type: "Unit", morph: false, from: ["Ghost Academy"] },
  "NydusCanal": { loops: 313.59999999999997, race: "Z", type: "Building", morph: false, from: ["NydusNetwork"] },
  "NydusWorm": { loops: 313.59999999999997, race: "Z", type: "Building", morph: false, from: ["NydusCanal"] },
  "Observer": { loops: 403.2, race: "P", type: "Unit", morph: false, from: ["RoboticsFacility"] },
  "ObserverGraviticBooster": { loops: 1276.8, race: "P", type: "Upgrade", morph: false, from: ["RoboticsBay"] },
  "Oracle": { loops: 828.8, race: "P", type: "Unit", morph: false, from: ["Stargate"] },
  "OrbitalCommand": { loops: 560, race: "T", type: "Building", morph: true, from: ["CommandCenter"] },
  "Overlord": { loops: 403.2, race: "Z", type: "Unit", morph: false, from: [] },
  "Overseer": { loops: 268.79999999999995, race: "Z", type: "Building", morph: true, from: ["Overlord"] },
  "PersonalCloaking": { loops: 1926.3999999999999, race: "T", type: "Upgrade", morph: false, from: ["GhostAcademy"] },
  "Phoenix": { loops: 560, race: "P", type: "Unit", morph: false, from: ["Stargate"] },
  "PhoenixRangeUpgrade": { loops: 1433.6, race: "P", type: "Upgrade", morph: false, from: ["FleetBeacon"] },
  "PlanetaryFortress": { loops: 806.4, race: "T", type: "Building", morph: true, from: ["CommandCenter"] },
  "Probe": { loops: 268.79999999999995, race: "P", type: "Unit", morph: false, from: ["Nexus"] },
  "ProtossAirArmorsLevel1": { loops: 2889.6, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "ProtossAirArmorsLevel2": { loops: 3449.6, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "ProtossAirArmorsLevel3": { loops: 4009.6, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "ProtossAirWeaponsLevel1": { loops: 2889.6, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "ProtossAirWeaponsLevel2": { loops: 3449.6, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "ProtossAirWeaponsLevel3": { loops: 4009.6, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "ProtossGroundArmorsLevel1": { loops: 2732.7999999999997, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossGroundArmorsLevel2": { loops: 3248, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossGroundArmorsLevel3": { loops: 3763.2, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossGroundWeaponsLevel1": { loops: 2732.7999999999997, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossGroundWeaponsLevel2": { loops: 3248, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossGroundWeaponsLevel3": { loops: 3763.2, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossShieldsLevel1": { loops: 2732.7999999999997, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossShieldsLevel2": { loops: 3248, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "ProtossShieldsLevel3": { loops: 3763.2, race: "P", type: "Upgrade", morph: false, from: ["Forge"] },
  "PsiStormTech": { loops: 1769.6, race: "P", type: "Upgrade", morph: false, from: ["TemplarArchives"] },
  "PunisherGrenades": { loops: 963.1999999999999, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Queen": { loops: 806.4, race: "Z", type: "Unit", morph: false, from: ["Hatchery", "Lair", "Hive"] },
  "RavagerCocoon": { loops: 0, race: "Z", type: "Building", morph: true, from: ["Roach"] },
  "Raven": { loops: 761.5999999999999, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "RavenCorvidReactor": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "RavenDamageUpgrade": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "RavenEnhancedMunitions": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "RavenRecalibratedExplosives": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Reaper": { loops: 761.5999999999999, race: "T", type: "Unit", morph: false, from: ["Barracks"] },
  "Roach": { loops: 425.59999999999997, race: "Z", type: "Unit", morph: false, from: [] },
  "SCV": { loops: 268.79999999999995, race: "T", type: "Unit", morph: false, from: ["Command Center", "Orbital Command"] },
  "Sentry": { loops: 515.1999999999999, race: "P", type: "Unit", morph: false, from: ["Gateway", "WarpGate"] },
  "ShieldWall": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "SiegeTank": { loops: 716.8, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "SmartServos": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "Stalker": { loops: 604.8, race: "P", type: "Unit", morph: false, from: ["Gateway", "WarpGate"] },
  "Stimpack": { loops: 2240, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "StrikeCannons": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "SwarmHost": { loops: 649.5999999999999, race: "Z", type: "Unit", morph: false, from: [] },
  "Tempest": { loops: 963.1999999999999, race: "P", type: "Unit", morph: false, from: ["Stargate"] },
  "TerranBuildingArmor": { loops: 2240, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranInfantryArmorsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranInfantryArmorsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranInfantryArmorsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranInfantryWeaponsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranInfantryWeaponsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranInfantryWeaponsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["EngineeringBay"] },
  "TerranShipArmorsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranShipArmorsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranShipArmorsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranShipWeaponsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranShipWeaponsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranShipWeaponsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleAndShipArmorsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleAndShipArmorsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleAndShipArmorsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleAndShipWeaponsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleAndShipWeaponsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleAndShipWeaponsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleArmorsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleArmorsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleArmorsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleWeaponsLevel1": { loops: 2553.6, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleWeaponsLevel2": { loops: 3046.3999999999996, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "TerranVehicleWeaponsLevel3": { loops: 3516.7999999999997, race: "T", type: "Upgrade", morph: false, from: ["Armory"] },
  "Thor": { loops: 963.1999999999999, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "TransformationServos": { loops: 1769.6, race: "T", type: "Upgrade", morph: false, from: ["TechLab"] },
  "TunnelingClaws": { loops: 1769.6, race: "Z", type: "Upgrade", morph: false, from: ["RoachWarren"] },
  "Ultralisk": { loops: 873.5999999999999, race: "Z", type: "Unit", morph: false, from: [] },
  "Viking": { loops: 672, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "VikingAssault": { loops: 672, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "VikingFighter": { loops: 672, race: "T", type: "Unit", morph: false, from: ["Starport"] },
  "Viper": { loops: 649.5999999999999, race: "Z", type: "Unit", morph: false, from: [] },
  "VoidRay": { loops: 963.1999999999999, race: "P", type: "Unit", morph: false, from: ["Stargate"] },
  "VoidRaySpeedUpgrade": { loops: 1276.8, race: "P", type: "Upgrade", morph: false, from: ["Fleet Beacon"] },
  "WarpGateResearch": { loops: 2240, race: "P", type: "Upgrade", morph: false, from: ["CyberneticsCore"] },
  "WarpPrism": { loops: 806.4, race: "P", type: "Unit", morph: false, from: ["RoboticsFacility"] },
  "WidowMine": { loops: 470.4, race: "T", type: "Unit", morph: false, from: ["Factory"] },
  "Zealot": { loops: 604.8, race: "P", type: "Unit", morph: false, from: ["Gateway", "WarpGate"] },
  "ZergFlyerArmorsLevel1": { loops: 2553.6, race: "Z", type: "Upgrade", morph: false, from: ["Spire", "GreaterSpire"] },
  "ZergFlyerArmorsLevel2": { loops: 3046.3999999999996, race: "Z", type: "Upgrade", morph: false, from: ["Spire", "GreaterSpire"] },
  "ZergFlyerArmorsLevel3": { loops: 3516.7999999999997, race: "Z", type: "Upgrade", morph: false, from: ["Spire", "GreaterSpire"] },
  "ZergFlyerWeaponsLevel1": { loops: 2553.6, race: "Z", type: "Upgrade", morph: false, from: ["Spire", "GreaterSpire"] },
  "ZergFlyerWeaponsLevel2": { loops: 3046.3999999999996, race: "Z", type: "Upgrade", morph: false, from: ["Spire", "GreaterSpire"] },
  "ZergFlyerWeaponsLevel3": { loops: 3516.7999999999997, race: "Z", type: "Upgrade", morph: false, from: ["Spire", "GreaterSpire"] },
  "ZergGroundArmorsLevel1": { loops: 2553.6, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergGroundArmorsLevel2": { loops: 3046.3999999999996, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergGroundArmorsLevel3": { loops: 3516.7999999999997, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergMeleeWeaponsLevel1": { loops: 2553.6, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergMeleeWeaponsLevel2": { loops: 3046.3999999999996, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergMeleeWeaponsLevel3": { loops: 3516.7999999999997, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergMissileWeaponsLevel1": { loops: 2553.6, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergMissileWeaponsLevel2": { loops: 3046.3999999999996, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "ZergMissileWeaponsLevel3": { loops: 3516.7999999999997, race: "Z", type: "Upgrade", morph: false, from: ["EvolutionChamber"] },
  "Zergling": { loops: 380.79999999999995, race: "Z", type: "Unit", morph: false, from: [] },
  "hydraliskspeed": { loops: 1590.3999999999999, race: "Z", type: "Upgrade", morph: false, from: ["HydraliskDen"] },
  "overlordspeed": { loops: 963.1999999999999, race: "Z", type: "Upgrade", morph: false, from: ["Hatchery", "Lair", "Hive"] },
  "overlordtransport": { loops: 2083.2, race: "Z", type: "Upgrade", morph: false, from: ["Hatchery", "Lair", "Hive"] },
  "zerglingattackspeed": { loops: 2083.2, race: "Z", type: "Upgrade", morph: false, from: ["SpawningPool"] },
  "zerglingmovementspeed": { loops: 1769.6, race: "Z", type: "Upgrade", morph: false, from: ["SpawningPool"] },
};

/**
 * 不该出现在建造表里的单位（spawningtool `BO_EXCLUDED`，逐字照搬）。
 *
 * 里面是三类东西，都不是"玩家主动造出来的东西"：
 * - 技能/召唤产物：`MULE` / `CalldownMULE` 系、`Locust*`、`Broodling`、`Changeling*`；
 * - 地图/引擎辅助对象：`InvisibleTargetDummy`（实测 2505 条，量最大）、`ParasiticBomb*`；
 * - 模式切换的另一个形态：`DisruptorPhased`、`AdeptPhaseShift`、`OracleStasisTrap`。
 *
 * 不过滤掉会直接毁掉建造表 —— 实测 `InvisibleTargetDummy` 一个就能顶掉全部真实条目。
 */
export const EXCLUDED_UNITS: string[] = ["AdeptPhaseShift", "AutoTurret", "Broodling", "BroodlingEscort", "Changeling", "ChangelingMarine", "ChangelingMarineShield", "ChangelingZealot", "ChangelingZergling", "ChangelingZerglingWings", "CreepTumor", "CreepTumorQueen", "DisruptorPhased", "InfestedTerran", "InfestedTerransEgg", "Interceptor", "InterceptorAutoTurret", "InterceptorFree", "InvisibleTargetDummy", "KD8Charge", "Larva", "Locust", "LocustMP", "LocustMPFlyer", "LocustMPPrecursor", "MULE", "OracleStasisTrap", "Overseer", "ParasiticBombDummy", "ParasiticBombRelayDummy", "PointDefenseDrone", "RavenRepairDrone", "ReaperPlaceholder", "ReleaseInterceptorsBeacon", "SpecialNexus", "SwarmHostBurrowed"];

/** 只在"变形歧义"时排除的形态名（spawningtool `BO_CHANGED_EXCLUDED`）。 */
export const CHANGED_EXCLUDED_UNITS: string[] = ["Liberator", "SiegeTank", "Viking", "VikingAssault", "VikingFighter", "WarpPrism", "WidowMine", "Zergling"];

/** 不参与建造表的行为类升级（喷涂）。 */
export const UPGRADE_EXCLUDED: string[] = ["SprayProtoss", "SprayTerran", "SprayZerg"];

/** `is_worker` 判定集合，照搬 `parser.py` 的 `BuildEvent.is_worker()`。 */
export const WORKER_UNITS: string[] = ["SCV", "Drone", "Probe", "Infested SCV", "Primal Drone"];

/**
 * 平衡性热修的历史值，用于按录像时间戳回滚（`build_data_for_timestamp`）。
 * 形如 `unit → [[被取代的时间戳(UTC 秒), 当时的 loops], ...]`，**由旧到新**。
 * 时间戳缺失时一律用当前值。
 */
export const BUILD_DATA_HISTORY: Record<string, [number, number][]> = {
  "Adept": [[1548115200, 604.8], [1782777600, 672.0]],
  "BansheeSpeed": [[1479772800, 2083.2], [1674432000, 2710.3999999999996], [1759190400, 2240.0]],
  "BattlecruiserEnableSpecializations": [[1548115200, 963.1999999999999]],
  "Carrier": [[1542672000, 1926.3999999999999]],
  "CentrificalHooks": [[1695945600, 1769.6]],
  "CycloneLockOnDamageUpgrade": [[1548115200, 1769.6]],
  "DarkTemplar": [[1782086400, 873.5999999999999], [1782777600, 963.1999999999999]],
  "DarkTemplarBlinkUpgrade": [[1542672000, 2710.3999999999996]],
  "DiggingClaws": [[1574726400, 1209.6]],
  "EvolveGroovedSpines": [[1695945600, 1590.3999999999999]],
  "EvolveMuscularAugments": [[1695945600, 1590.3999999999999]],
  "HighTemplar": [[1782086400, 873.5999999999999], [1782777600, 963.1999999999999]],
  "LurkerDenMP": [[1574726400, 1926.3999999999999]],
  "Mothership": [[1695945600, 2553.6]],
  "Observer": [[1711411200, 470.4]],
  "Oracle": [[1513555200, 963.1999999999999]],
  "ProtossAirArmorsLevel1": [[1553472000, 2553.6]],
  "ProtossAirArmorsLevel2": [[1553472000, 3046.3999999999996]],
  "ProtossAirArmorsLevel3": [[1553472000, 3516.7999999999997]],
  "ProtossAirWeaponsLevel1": [[1553472000, 2553.6]],
  "ProtossAirWeaponsLevel2": [[1553472000, 3046.3999999999996]],
  "ProtossAirWeaponsLevel3": [[1553472000, 3516.7999999999997]],
  "ProtossGroundArmorsLevel1": [[1553472000, 2553.6], [1674432000, 2889.6]],
  "ProtossGroundArmorsLevel2": [[1553472000, 3046.3999999999996], [1674432000, 3449.6]],
  "ProtossGroundArmorsLevel3": [[1553472000, 3516.7999999999997], [1674432000, 4009.6]],
  "ProtossGroundWeaponsLevel1": [[1553472000, 2553.6], [1674432000, 2889.6]],
  "ProtossGroundWeaponsLevel2": [[1553472000, 3046.3999999999996], [1674432000, 3449.6]],
  "ProtossGroundWeaponsLevel3": [[1553472000, 3516.7999999999997], [1674432000, 4009.6]],
  "ProtossShieldsLevel1": [[1553472000, 2553.6], [1674432000, 2889.6]],
  "ProtossShieldsLevel2": [[1553472000, 3046.3999999999996], [1674432000, 3449.6]],
  "ProtossShieldsLevel3": [[1553472000, 3516.7999999999997], [1674432000, 4009.6]],
  "Raven": [[1674432000, 963.1999999999999]],
  "Reaper": [[1782777600, 716.8]],
  "Sentry": [[1674432000, 582.4]],
  "Stalker": [[1732492800, 672.0]],
  "Stimpack": [[1566345600, 2710.3999999999996]],
  "VoidRay": [[1596672000, 963.1999999999999], [1647302400, 828.8]],
  "WarpGateResearch": [[1548115200, 2553.6]],
  "WidowMine": [[1513555200, 649.5999999999999]],
};

/** spawningtool 会追踪的能力名（时空加速 / 折跃门提速判定用，尚未落地的部分）。 */
export const TRACKED_ABILITIES: string[] = ["250mmStrikeCannons", "Abduct", "AdeptPhaseShift", "BlindingCloud", "BuildAutoTurret", "BuildPointDefenseDrone", "CalldownMULE", "CausticSpray", "ChronoBoost", "ChronoBoostEnergyCost", "Contaminate", "Corruption", "Disintegration", "EMPRound", "Envision", "ExtraSupplies", "Feedback", "ForceField", "FungalGrowth", "GravitonBeam", "GuardianShield", "HallucinationArchon", "HallucinationColossus", "HallucinationHighTemplar", "HallucinationImmortal", "HallucinationPhoenix", "HallucinationProbe", "HallucinationStalker", "HallucinationVoidRay", "HallucinationWarpPrism", "HallucinationZealot", "Hyperjump", "InfestorNeuralParasite", "KD8Charge", "LockOn", "LocustMPFlyingSwoop", "MassRecallMothership", "MassRecallMothershipCore", "MothershipCorePurifyNexus", "MothershipMassRecall", "NexusMassRecall", "ObserverMorphtoObserverSiege", "OracleStasisTrap", "OverseerMorphtoOverseerSiegeMode", "PsionicStorm", "PurificationNova", "QueenTransfusion", "RavagerCorrosiveBile", "RavenRepairDrone", "RavenScramblerMissile", "RavenShredderMissile", "ReleaseInterceptors", "ScannerSweep", "SeekerMissile", "SniperRound", "SpawnLarva", "SpawnLocustsTargeted", "TemporalField", "YamatoGun"];
