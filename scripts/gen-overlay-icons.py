#!/usr/bin/env python3
"""生成悬浮窗（overlay/）的单位/建筑/升级图标副本与名称→图标映射表。

解决两个问题：
1. **黑底**：assets/units/ 的 webp 没有 alpha 通道（黑底烙在图里，与参考站同源）。
   悬浮窗是逐像素透明窗，黑底会显成黑色方块 —— 本脚本用「亮度→alpha」（保留
   unpremultiplied RGB）把副本转成真透明，与 js/lab/sandbox.js 的运行时做法同一算法。
2. **名称不同构**：解析器/data.json 的单位名（如 VikingFighter、LurkerMPEgg、
   SporeCrawlerUprooted）与图标文件名（Viking.webp、Lurker.webp、SporeCrawler.webp）
   不同构。按「迭代剥变体后缀 + 显式别名表」解析，生成 overlay/frontend/dist/icons.json
   （name → 图标名），网页侧 ovPush 与 exe 悬浮页都用它。

用法：
  python scripts/gen-overlay-icons.py           # 生成副本 + icons.json，打印覆盖率报告
  python scripts/gen-overlay-icons.py --check   # 校验 icons.json 与生成结果一致、映射目标文件存在

源素材与 data.json 变化后需重跑生成；产物（keyed webp 副本 + icons.json）入仓。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'assets', 'units')
DST_DIR = os.path.join(ROOT, 'overlay', 'frontend', 'dist', 'assets', 'units')
MAP_PATH = os.path.join(ROOT, 'overlay', 'frontend', 'dist', 'icons.json')
DATA_PATH = os.path.join(ROOT, 'data.json')

# 迭代剥离的变体后缀（虫族潜地/变形、星灵相位、人族模式切换等）
SUFFIXES = (
    'Burrowed', 'SiegeMode', 'Uprooted', 'Alternate', 'Flying', 'PhaseShift',
    'StasisTrap', 'Transport', 'Cocoon', 'Egg', 'AP', 'MP', 'Fighter',
    'Assault', 'Rich', 'Reactor', 'TechLab',
)
# 后缀规则覆盖不到的显式别名
EXPLICIT_ALIASES = {
    'CreepTumorQueen': 'CreepTumor',
    'StarporFlying': 'Starport',
    'BattleHellion': 'Hellion',
    'CommandCenterOrbital': 'OrbitalCommand',
    'NydusCanal': 'NydusNetwork',
    'CentrificalHooks': 'CentrifugalHooks',   # 官方拼写彩蛋
    'EvolveMuscularAugments': 'MuscularAugments',
    'EvolveGroovedSpines': 'GroovedSpines',
    'DiggingClaws': 'DrillingClaws',
    'DrillClaws': 'DrillingClaws',
    'NeosteelFrame': 'NeosteelArmor',
    'BlinkTech': 'Blink',
    'PsiStormTech': 'PsionicStorm',
}
# 已知无素材、且对建造顺序可有可无的名称 —— 不参与映射，文本-only 展示
KNOWN_MISSING_FALLBACK = True  # 未解析名称允许缺失（页面 onerror/无 img 降级）


def load_names():
    data = json.load(open(DATA_PATH, encoding='utf-8'))
    names = []
    for cat, m in data.items():
        if isinstance(m, dict):
            names.extend(m.keys())
    return names


def candidates(n, icons):
    """按优先级产出 n 的候选图标名（逐个试，第一个在 icons 里的胜出）。"""
    yield n  # 直接同名（最常见路径）
    # 显式别名
    if n in EXPLICIT_ALIASES:
        yield EXPLICIT_ALIASES[n]
    # 单复数：data.json 用 Armors，素材用 Armor
    if 'Armors' in n:
        yield n.replace('Armors', 'Armor')
    # 迭代剥变体后缀（两级以上变体：LurkerMPEgg → LurkerMP → Lurker）
    cur = n
    seen = {n}
    for _ in range(4):
        nxt = None
        for suf in SUFFIXES:
            if cur.endswith(suf) and len(cur) > len(suf):
                nxt = cur[: -len(suf)]
                break
        if nxt is None and cur.startswith('Changeling') and len(cur) > 10:
            nxt = cur[10:]  # ChangelingMarine → Marine（拟态变体用本体图标）
        if nxt is None and cur in EXPLICIT_ALIASES:
            nxt = EXPLICIT_ALIASES[cur]
        if nxt is None or nxt in seen:
            break
        seen.add(nxt)
        cur = nxt
        yield cur
    # 升级项以单位名开头：PhoenixRangeUpgrade → Phoenix（取最长前缀，≥6 字符防误伤）
    best = ''
    for i in icons:
        if len(i) >= 6 and i != n and n.startswith(i) and len(i) > len(best):
            best = i
    if best:
        yield best
    # 图标名是名称的近扩展：TemplarArchive → TemplarArchives（差 ≤4 字符）
    for i in icons:
        if len(i) - len(n) <= 4 and i.startswith(n) and i != n:
            yield i


def build_alias_table(icons):
    """返回 name→icon 解析表（只含可解析项）。"""
    table = {}
    for n in load_names():
        for cand in candidates(n, icons):
            if cand in icons:
                table[n] = cand
                break
    return table


def key_black_to_alpha(src, dst):
    """亮度→alpha（unpremultiplied RGB），与 sandbox.js 的运行时抠图同一算法。"""
    from PIL import Image
    img = Image.open(src).convert('RGBA')
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            rr, gg, bb, aa = px[x, y]
            lum = (2126 * rr + 7152 * gg + 722 * bb) // 10000
            px[x, y] = (rr, gg, bb, min(aa, lum))
    img.save(dst, 'WEBP', quality=90, method=4)


def main():
    check = '--check' in sys.argv
    icons = {f[:-5] for f in os.listdir(SRC_DIR) if f.endswith('.webp')}
    table = build_alias_table(icons)
    names = load_names()

    if check:
        committed = json.load(open(MAP_PATH, encoding='utf-8'))
        problems = []
        for n, icon in table.items():
            if committed.get(n) != icon:
                problems.append(f'mapping mismatch: {n}: {committed.get(n)!r} != {icon!r}')
            if not os.path.exists(os.path.join(DST_DIR, icon + '.webp')):
                problems.append(f'missing keyed copy: {icon}.webp')
        for n in committed:
            if n not in table:
                problems.append(f'stale mapping entry: {n}')
        if problems:
            print('\n'.join(problems))
            sys.exit(1)
        print(f'--check OK: {len(table)}/{len(names)} 名称有图标映射')
        return

    # 生成：keyed 副本（全部素材拷一份，保证 icons.json 引用的都在）
    os.makedirs(DST_DIR, exist_ok=True)
    for stem in sorted(icons):
        key_black_to_alpha(
            os.path.join(SRC_DIR, stem + '.webp'),
            os.path.join(DST_DIR, stem + '.webp'))
    mapping = json.dumps(table, ensure_ascii=False, indent=1, sort_keys=True)
    with open(MAP_PATH, 'w', encoding='utf-8', newline='\n') as f:
        f.write(mapping + '\n')
    # 站点根目录副本：分析页 ovPush 按 data.json 同样的相对路径加载
    with open(os.path.join(ROOT, 'icons.json'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(mapping + '\n')

    missing = sorted(n for n in names if n not in table)
    print(f'名称 {len(names)} 个：映射 {len(table)}，无图标（文本-only 降级）{len(missing)} 个')
    if missing:
        print('--- 无素材名称清单（后续补素材用） ---')
        for n in missing:
            print(' ', n)


if __name__ == '__main__':
    main()
