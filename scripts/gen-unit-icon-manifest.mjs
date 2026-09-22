// 从 assets/units/ 的实际文件清单生成 js/lab/unit_icons.generated.js。
// 沙盘渲染（canvas + HUD DOM）先查这份名单再决定要不要请求图标 ——
// 缺图的名字（如 TemplarArchive / Locust 系）走矢量点阵兜底，永不发 404。
//
//   node scripts/gen-unit-icon-manifest.mjs
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const DIR = join(REPO, "assets", "units");
const DEST = join(REPO, "js", "lab", "unit_icons.generated.js");

const names = readdirSync(DIR)
  .filter((f) => f.endsWith(".webp"))
  .map((f) => f.replace(/\.webp$/, ""))
  .sort();

const body = `/* ============================================================================
   ⚠️ 生成文件：由 scripts/gen-unit-icon-manifest.mjs 从 assets/units/ 生成，不要手改。
   沙盘渲染先查 UNIT_ICONS 再请求图标；缺图名字走矢量点阵兜底，永不发 404。
   图标素材版权归 Blizzard Entertainment、粉丝非商用（见 README）。
   ========================================================================== */

/** assets/units/ 里实际存在的图标名（不含扩展名），共 ${names.length} 个。 */
export const UNIT_ICONS = new Set(${JSON.stringify(names)});
`;

writeFileSync(DEST, body);
console.log(`✓ ${names.length} 个图标名 → js/lab/unit_icons.generated.js`);
