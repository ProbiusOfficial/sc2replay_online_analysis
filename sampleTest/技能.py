import sys
import sc2reader
from sc2reader.events.game import CommandEvent, TargetPointCommandEvent, TargetUnitCommandEvent

def main(path: str):
    replay = sc2reader.load_replay(path, load_level=4)

    print(f"Map: {replay.map_name}")
    print(f"Players: {[p.name for p in replay.players]}")
    print(f"Game length: {replay.game_length} (frames={replay.frames})")
    print("-" * 80)

    for ev in replay.events:
        # 只关心“带技能”的命令事件
        if not isinstance(ev, CommandEvent):
            continue
        if not getattr(ev, "has_ability", False):
            continue

        # 时间
        frame = getattr(ev, "frame", None)
        sec = getattr(ev, "second", None)
        if sec is None and frame is not None:
            sec = frame >> 4

        # 玩家
        player = getattr(ev, "player", None)
        player_name = getattr(player, "name", None)

        # 技能名字（两路：ability_name 和 ability.name）
        ability_name = getattr(ev, "ability_name", None)
        ability_obj = getattr(ev, "ability", None)
        ability_name2 = getattr(ability_obj, "name", None)

        # 目标信息
        target_info = ""
        if isinstance(ev, TargetUnitCommandEvent):
            target = getattr(ev, "target", None) or getattr(ev, "target_unit", None)
            target_name = getattr(target, "name", None)
            target_info = f" target_unit={target_name!r}"
        elif isinstance(ev, TargetPointCommandEvent):
            loc = getattr(ev, "location", None)
            target_info = f" target_point={loc}"

        print(
            f"[t={sec:>4} s, frame={frame:>6}] "
            f"player={player_name!r} "
            f"ability_name={ability_name!r} "
            f"ability.name={ability_name2!r} "
            f"type={ev.ability_type} "
            f"id={getattr(ev, 'ability_id', None)}"
            f"{target_info}"
        )

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python list_abilities.py path/to/replay.SC2Replay")
        sys.exit(1)
    main(sys.argv[1])