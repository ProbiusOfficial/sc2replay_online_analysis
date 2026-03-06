"""
SC2 录像建造顺序解析 API
使用 sc2reader 解析 .SC2Replay 文件，返回双方建造顺序
"""
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import sc2reader
from sc2reader.exceptions import ReadError

# 需要排除的中间形态单位（变形过程中的临时状态）
EXCLUDE_UNIT_TYPES = {
    "BanelingCocoon",
    "BroodLordCocoon",
    "Larva",  # 虫族幼虫，非玩家建造
}

app = FastAPI(title="StarCraft II Replay Analysis - Online")


def extract_build_order(replay):
    """从录像中提取双方建造顺序"""
    result = {
        "map_name": getattr(replay, "map_name", "Unknown"),
        "game_length": getattr(getattr(replay, "game_length", None), "seconds", 0),
        "teams": [],
    }

    for team in replay.teams:
        team_data = {"players": []}
        for player in team.players:
            build_order = []
            supply = 0

            units = []
            for unit in getattr(player, "units", []):
                if unit.hallucinated:
                    continue
                if unit.finished_at is None:
                    continue
                name = unit.name if hasattr(unit, "name") else (unit._type_class.name if unit._type_class else None)
                if name and name in EXCLUDE_UNIT_TYPES:
                    continue
                if name:
                    units.append((unit.finished_at, unit, name))

            units.sort(key=lambda x: (x[0], x[2]))

            for _, unit, name in units:
                unit_supply = unit.supply if unit.supply is not None else 0
                supply += unit_supply
                time_sec = unit.finished_at >> 4
                build_order.append({
                    "time": time_sec,
                    "supply": max(0, int(supply)),
                    "unit": name,
                })

            race_char = (player.pick_race or "?")[0] if player.pick_race else "?"
            team_data["players"].append({
                "name": player.name or "Unknown",
                "race": race_char,
                "build_order": build_order,
            })
        result["teams"].append(team_data)

    return result


@app.post("/api/parse")
async def parse_replay(file: UploadFile = File(...)):
    """解析上传的录像文件，返回建造顺序"""
    if not file.filename or not file.filename.lower().endswith(".sc2replay"):
        raise HTTPException(status_code=400, detail="请上传 .SC2Replay 文件")

    try:
        content = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"读取文件失败: {e}")

    try:
        with tempfile.NamedTemporaryFile(suffix=".SC2Replay", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        try:
            replay = sc2reader.load_replay(tmp_path, load_level=4)
            return extract_build_order(replay)
        finally:
            Path(tmp_path).unlink(missing_ok=True)
    except ReadError as e:
        raise HTTPException(status_code=400, detail=f"录像解析失败: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败: {str(e)}")


static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def index():
    """返回主页面"""
    index_path = Path(__file__).parent / "static" / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"message": "请将 index.html 放入 static/ 目录"}
