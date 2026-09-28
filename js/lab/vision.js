/* ============================================================================
   单位视野半径表 —— 沙盘战争迷雾用。

   SC2 的视野是纯半径制(单位周围一个圆形,无地形遮挡),所以迷雾可以还原为
   「己方所有单位/建筑位置的视野圆并集」。半径为游戏内世界单位(大多数单位
   9、建筑 11、农民 8),只对偏差明显的条目覆写 —— 迷雾是**并集**,对单体
   ±1 的半径误差视觉上不可辨,没必要逐单位精确到补丁号。
   ============================================================================ */

const SIGHT_OVERRIDES = {
  // 农民
  SCV: 8, Probe: 8, Drone: 8, MULE: 8,
  // 侦察 / 高视野单位
  Observer: 11, ObserverSiegeMode: 11, Overseer: 11, OverseerSiegeMode: 11,
  Ghost: 11, Raven: 10, Oracle: 10, Tempest: 14,
  Carrier: 11, Battlecruiser: 11, Mothership: 11, MothershipCore: 11, BroodLord: 11,
  Lurker: 10, LurkerMP: 10,
  // 防御 / 特殊建筑
  Bunker: 10, SensorTower: 13, PhotonCannon: 11, SpineCrawler: 11, SporeCrawler: 11,
  XelNagaTower: 14,
};

/** 兜底:普通单位 9、建筑 11。 */
export function sightOf(name, isBuilding) {
  const v = SIGHT_OVERRIDES[name];
  if (v != null) return v;
  return isBuilding ? 11 : 9;
}
