import { appState } from "./state.js";

export const ABILITY_FALLBACK_ZH = {
  NexusMassRecall: "星空加速",
  MassRecallMothership: "星空加速",
  MothershipMassRecall: "星空加速",
  MassRecallMothershipCore: "星空加速",
};

export function itemIsTechUpgrade(it) {
  if (!it || it._kind === "upgrade") return it && it._kind === "upgrade";
  const u = it.unit || "";
  const translationData = appState.translationData;
  if (!u || !translationData?.upgrade) return false;
  return !!lookupTranslationEntry(translationData.upgrade, u);
}

export function lookupTranslationEntry(table, name) {
  if (!table || name == null) return null;
  name = String(name).trim();
  if (!name) return null;
  if (table[name]) return table[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(table)) {
    if (k.toLowerCase() === lower) return table[k];
  }
  const stripped = name.replace(/^(Research|Upgrade|研究)\s+/i, "").trim();
  if (stripped && stripped !== name) {
    if (table[stripped]) return table[stripped];
    const sl = stripped.toLowerCase();
    for (const k of Object.keys(table)) {
      if (k.toLowerCase() === sl) return table[k];
    }
  }
  return null;
}

export function getDisplayUnitText(item) {
  const name = item.unit || "";
  const kind = item._kind || "";
  const translationData = appState.translationData;
  const showOriginal = appState.showOriginal;

  if (kind === "worker_death") return name;

  if (showOriginal) {
    if (kind === "recall") {
      const t = item.target || "";
      return t ? `${name} → ${t}` : name;
    }
    return name;
  }
  if (!translationData) {
    if (kind === "recall") {
      const t = item.target || "";
      return t ? `星空加速 → ${t}` : (ABILITY_FALLBACK_ZH[name] || "星空加速");
    }
    return name;
  }

  if (kind === "recall") {
    const tn = item.target || "";
    if (tn) {
      let zh = translationData.unit?.[tn]?.zh || translationData.build?.[tn]?.zh;
      if (!zh && translationData.change) {
        for (const g of Object.values(translationData.change)) { if (g?.[tn]) { zh = g[tn].zh; break; } }
      }
      return `星空加速 → ${zh || tn}`;
    }
    return ABILITY_FALLBACK_ZH[name] || "星空加速";
  }

  let zh = lookupTranslationEntry(translationData.upgrade, name)?.zh
    || lookupTranslationEntry(translationData.unit, name)?.zh
    || lookupTranslationEntry(translationData.build, name)?.zh;
  if (!zh && translationData.change) {
    for (const g of Object.values(translationData.change)) { if (g?.[name]) { zh = g[name].zh; break; } }
  }
  return zh || name;
}

/** 与建造列表渲染一致：后端把 recall 追加在 build_order 末尾，必须按时间排序后再播语音 */
export function compareBuildOrderItems(a, b) {
  const ta = a.start_time ?? a.time ?? 0;
  const tb = b.start_time ?? b.time ?? 0;
  if (ta !== tb) return ta - tb;
  if (a.supply != null && b.supply != null && a.supply !== b.supply) return a.supply - b.supply;
  return (a.unit || "").localeCompare(b.unit || "", "en");
}
