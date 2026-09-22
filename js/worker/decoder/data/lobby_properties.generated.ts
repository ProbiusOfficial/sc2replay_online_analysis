/**
 * 大厅属性表 + 速度系数（`replay.attributes.events` / `constants.py`）
 * —— **自动生成，请勿手改**。
 *
 * 由 `scripts/gen-lobby-properties.py` 从 sc2reader 产出。
 * 来源：sc2reader 1.9.0；`data/attributes.json` sha256 `63baa4c8228ae85a92367b2b8e67fcff14e2d22d8dfe6c8aaef1ec5ca35467d5`。
 *
 * ## 取值链（属性表）
 *
 * `replay.attributes.events` → `decodeReplayAttributesEvents()` → `{scope: {attrid: [原始 4 字节]}}`。
 * 取 `scope == 相关玩家`、`attrid == 表 id` 的那条，把 4 字节按 UTF-8 解成 4 字符码，在本表里查可读名。
 *
 * **查不到时 sc2reader 会置 `None`**（`objects.py::Attribute.__init__` 捕获 `KeyError` 的写法），
 * 不是回落到默认值 —— 本实现保持一致。
 *
 * 注意 `decodeReplayAttributesEvents` 输出的字节**已经是可查表的形态**：
 * 官方 s2protocol 的 `[::-1].strip(b'\x00')` 与 sc2reader 的
 * `"".join(reversed(read_string(4)))` + `[::-1]` 两次反转，净效果相同（实测 `Fasr`/`Zerg` 直接命中）。
 */

/** `Game Speed` 的属性 id。用于 `start_time` 推算（查 `GAME_SPEED_FACTOR`）。 */
export const GAME_SPEED_ATTRIBUTE_ID = 3000;

/** 4 字符码 → 可读的 `Game Speed` 名。 */
export const GAME_SPEED_LOOKUP: Readonly<Record<string, string>> = {
  "Fasr": "Faster",
  "Fast": "Fast",
  "Norm": "Normal",
  "Slor": "Slower",
  "Slow": "Slow",
};

/** `Game Speed` 的属性 id。用于 `start_time` 推算（查 `GAME_SPEED_FACTOR`）。 */
export const RACE_ATTRIBUTE_ID = 3001;

/** 4 字符码 → 可读的 `Race` 名。 */
export const RACE_LOOKUP: Readonly<Record<string, string>> = {
  "InfT": "Infested Terran",
  "PZrg": "Primal Zerg",
  "Prot": "Protoss",
  "RAND": "Random",
  "TerH": "Terran Horner",
  "TerT": "Terran Tychus",
  "Terr": "Terran",
  "Zerg": "Zerg",
};

/**
 * `sc2reader/constants.py::GAME_SPEED_FACTOR`（原文逐字照搬）。
 *
 * `start_time` 用的系数，**不是** `1.4` 那种体感倍率，是 sc2reader 自己的一套表：
 *
 * ```python
 * # resources.py:274-282（load_level 0）
 * fps = self.game_fps                      # 恒为 16.0
 * if 34784 <= self.build:  fps *= 1.4      # LotV 录像 → 22.4
 * self.length = Length(seconds=int(self.frames / fps))
 *
 * # resources.py:431-436（load_details，覆盖上面的 real_length）
 * self.real_length = Length(seconds=self.length.seconds // GAME_SPEED_FACTOR[exp].get(speed, 1.0))
 * self.start_time = fromtimestamp(self.unix_timestamp - self.real_length.seconds)
 * ```
 *
 * 注意 `WoL` / `HotS` 的 `Faster` 是 `1.4`，`LotV` 的是 `1.0` —— 对 LotV 就等于不除。
 */
export const GAME_SPEED_FACTOR: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  "HotS": {
    "Fast": 1.2,
    "Faster": 1.4,
    "Normal": 1.0,
    "Slow": 0.8,
    "Slower": 0.6,
  },
  "LotV": {
    "Fast": 0.8,
    "Faster": 1.0,
    "Normal": 0.6,
    "Slow": 0.4,
    "Slower": 0.2,
  },
  "WoL": {
    "Fast": 1.2,
    "Faster": 1.4,
    "Normal": 1.0,
    "Slow": 0.8,
    "Slower": 0.6,
  },
};
