export const PARSE_SCRIPT = `
import json
import sc2reader
from sc2reader.events.message import ChatEvent
import spawningtool.parser

WORKER_NAMES = {"SCV","Probe","Drone"}

def extract_replay_data(replay_path):
    def patched_get_display_name(self, unit_name, player):
        return unit_name
    spawningtool.parser.GameParser.get_display_name = patched_get_display_name

    parser = spawningtool.parser.GameParser(replay_path)
    st_data = parser.get_parsed_data()
    replay = parser.replay

    start_time_ts = None
    if hasattr(replay, "start_time"):
        try:
            start_time_ts = int(replay.start_time.timestamp())
        except Exception:
            pass

    result = {
        "map_name": st_data.get("map", "Unknown"),
        "game_length": st_data.get("frames", 0) // max(st_data.get("frames_per_second", 16), 1),
        "client_version": st_data.get("build"),
        "region": st_data.get("region"),
        "start_time": start_time_ts,
        "winner": None,
        "teams": [],
        "chat": [],
    }

    # Chat
    for ev in getattr(replay, "events", []):
        if isinstance(ev, ChatEvent):
            frame = int(getattr(ev, "frame", 0))
            result["chat"].append({
                "time": frame >> 4,
                "player": getattr(ev.player, "name", ""),
                "pid": getattr(ev, "pid", None),
                "target": getattr(ev, "target", ""),
                "text": getattr(ev, "text", ""),
            })

    # Winner
    winners = []
    for team in getattr(replay, "teams", []):
        if getattr(team, "result", None) == "Win":
            winners.append(" & ".join([p.name for p in team.players]))
    if winners:
        result["winner"] = " / ".join(winners)

    # 群体传送 / 星空加速：仅用 sc2reader（含目标单位），spawningtool abilities 无可靠目标
    RECALL_ABILITY_KEYS = frozenset({
        "NexusMassRecall",
        "MassRecallMothership",
        "MothershipMassRecall",
        "MassRecallMothershipCore",
    })
    recall_events_by_pid = {}
    try:
        from sc2reader.events.game import CommandEvent, TargetUnitCommandEvent
        for ev in getattr(replay, "events", []):
            if not isinstance(ev, CommandEvent):
                continue
            if not getattr(ev, "has_ability", False):
                continue
            aname = getattr(ev, "ability_name", None)
            aobj = getattr(ev, "ability", None)
            aname2 = getattr(aobj, "name", None)
            akey = aname or aname2
            if akey not in RECALL_ABILITY_KEYS:
                continue
            f = getattr(ev, "frame", None)
            sec = getattr(ev, "second", None)
            if sec is None and f is not None:
                sec = f >> 4
            if sec is None:
                continue
            player = getattr(ev, "player", None)
            pid = getattr(player, "pid", None) if player else None
            if pid is None:
                continue
            tname = None
            t = None
            if isinstance(ev, TargetUnitCommandEvent):
                t = getattr(ev, "target", None) or getattr(ev, "target_unit", None)
            if t is None:
                t = getattr(ev, "target", None)
            if t is not None:
                tname = getattr(t, "name", None)
            recall_events_by_pid.setdefault(pid, []).append({"time": int(sec), "target": tname})
    except Exception:
        pass

    # Worker deaths + benchmark stats from tracker events
    worker_deaths_by_pid = {}
    worker_kills_cum = {}
    worker_losses_cum = {}
    worker_kills_by_min = {}
    worker_losses_by_min = {}
    stats_raw = {}
    workers_sec_bucket = {}

    try:
        from sc2reader.events.tracker import PlayerStatsEvent, UnitDiedEvent
        for ev in getattr(replay, "tracker_events", []):
            if isinstance(ev, UnitDiedEvent):
                unit = getattr(ev, "unit", None)
                if not unit:
                    continue
                uname = getattr(unit, "name", None)
                if uname not in WORKER_NAMES:
                    continue
                owner = getattr(unit, "owner", None)
                opid = getattr(owner, "pid", None) if owner else None
                sec = getattr(ev, "second", None)
                if sec is None:
                    f = getattr(ev, "frame", None)
                    if f is None: continue
                    sec = f >> 4
                killing_pl = getattr(ev, "killing_player", None)
                kpid = getattr(killing_pl, "pid", None) if killing_pl else None
                if kpid is None:
                    kid = getattr(ev, "killing_player_id", None)
                    try:
                        if kid is not None and int(kid) > 0:
                            kpid = int(kid)
                    except (TypeError, ValueError):
                        pass
                if kpid is None:
                    killer = getattr(ev, "killer", None)
                    kowner = getattr(killer, "owner", None) if killer else None
                    kpid = getattr(kowner, "pid", None) if kowner else None
                ku = getattr(ev, "killing_unit", None)
                kname = getattr(ku, "name", None) if ku else None
                if not kname:
                    killer = getattr(ev, "killer", None)
                    kname = getattr(killer, "name", None) if killer else None
                if opid is not None:
                    worker_deaths_by_pid.setdefault(opid, []).append({"time": int(sec), "unit": uname, "killer": kname})
                    dsec = sec / 1.4
                    minute = max(1, int(dsec / 60) + 1)
                    worker_losses_cum.setdefault(opid, 0)
                    worker_losses_cum[opid] += 1
                    worker_losses_by_min.setdefault(opid, {})[minute] = worker_losses_cum[opid]
                if kpid is not None:
                    dsec = sec / 1.4
                    minute = max(1, int(dsec / 60) + 1)
                    worker_kills_cum.setdefault(kpid, 0)
                    worker_kills_cum[kpid] += 1
                    worker_kills_by_min.setdefault(kpid, {})[minute] = worker_kills_cum[kpid]

            if isinstance(ev, PlayerStatsEvent):
                pl = getattr(ev, "player", None)
                pid = getattr(pl, "pid", None) if pl else None
                if pid is None:
                    pid = getattr(ev, "pid", None)
                if pid is None:
                    continue
                frame = getattr(ev, "frame", 0)
                gsec = frame / 16.0
                dsec = gsec / 1.4
                minute = int(dsec / 60) + 1

                if pid not in stats_raw:
                    stats_raw[pid] = {}

                fu = getattr(ev, "food_used", None)
                fm = getattr(ev, "food_made", None)
                if isinstance(fu, (int, float)) and fu > 1000:
                    fu = int(round(fu / 4096))
                if isinstance(fm, (int, float)) and fm > 1000:
                    fm = int(round(fm / 4096))

                stats_raw[pid][minute] = {
                    "workers": getattr(ev, "workers_active_count", 0),
                    "army_minerals": getattr(ev, "minerals_used_current_army", 0),
                    "army_vespene": getattr(ev, "vespene_used_current_army", 0),
                    "minerals_rate": getattr(ev, "minerals_collection_rate", 0),
                    "vespene_rate": getattr(ev, "vespene_collection_rate", 0),
                    "food_used": int(fu) if fu is not None else 0,
                    "food_made": int(fm) if fm is not None else 0,
                }
                w_count = int(getattr(ev, "workers_active_count", 0) or 0)
                sec_i = int(dsec)
                workers_sec_bucket.setdefault(pid, {})[sec_i] = w_count
    except Exception as e:
        print("Stats collection error:", e)

    workers_curve_by_pid = {}
    for pid, sec_map in workers_sec_bucket.items():
        if not sec_map:
            continue
        smin = min(sec_map.keys())
        smax = max(sec_map.keys())
        last = sec_map[smin]
        curve = []
        for s in range(smin, smax + 1):
            if s in sec_map:
                last = sec_map[s]
            curve.append({"t": s / 60.0, "w": last})
        workers_curve_by_pid[pid] = curve

    # Build teams
    max_minute = 0
    for pid_s in stats_raw.values():
        for m in pid_s:
            if m > max_minute:
                max_minute = m

    for team in replay.teams:
        team_data = {"players": []}
        for player in team.players:
            st_player = st_data["players"].get(player.pid)
            if not st_player:
                continue
            build_order = []
            for item in st_player.get("buildOrder", []):
                build_order.append({
                    "start_time": int(item["frame"]) >> 4,
                    "supply": item["supply"],
                    "unit": item["name"],
                    "_kind": "upgrade" if item.get("type") == "Upgrade" else "unit",
                    "is_worker": item.get("is_worker", False),
                })
            player_stats = []
            last_wk = 0
            last_wl = 0
            last_ek = None
            empty_ek = {
                "workers": 0, "army_minerals": 0, "army_vespene": 0,
                "minerals_rate": 0, "vespene_rate": 0, "food_used": 0, "food_made": 0,
            }
            for m in range(1, max_minute + 1):
                wk = worker_kills_by_min.get(player.pid, {}).get(m, last_wk)
                wl = worker_losses_by_min.get(player.pid, {}).get(m, last_wl)
                last_wk = wk
                last_wl = wl
                raw = stats_raw.get(player.pid, {}).get(m)
                if raw is not None:
                    entry = dict(raw)
                    last_ek = entry
                elif last_ek is not None:
                    entry = dict(last_ek)
                else:
                    entry = dict(empty_ek)
                entry["minute"] = m
                entry["workers_killed"] = wk
                entry["workers_lost"] = wl
                player_stats.append(entry)

            for rc in recall_events_by_pid.get(player.pid, []):
                t = int(rc.get("time", 0))
                tgt = rc.get("target")
                build_order.append({
                    "start_time": t,
                    "supply": None,
                    "unit": tgt or "",
                    "_kind": "recall",
                    "target": tgt,
                    "is_worker": False,
                })

            team_data["players"].append({
                "name": player.name,
                "race": (player.pick_race or "?")[0],
                "build_order": build_order,
                "worker_deaths": worker_deaths_by_pid.get(player.pid, []),
                "workers_curve": workers_curve_by_pid.get(player.pid, []),
                "stats": player_stats,
            })
        result["teams"].append(team_data)
    return result
`;
