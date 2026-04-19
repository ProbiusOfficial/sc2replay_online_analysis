import { appState } from "./state.js";

export function destroyCharts() {
  appState.chartInstances.forEach(c => c.destroy());
  appState.chartInstances = [];
}

export function renderBenchmarks(data) {
  destroyCharts();
  const benchEl = document.getElementById("benchmarks");
  if (!benchEl) return;

  const allPlayers = [];
  data.teams.forEach(team => team.players.forEach(p => allPlayers.push(p)));
  const playersWithStats = allPlayers.filter(p => p.stats && p.stats.length);
  if (!playersWithStats.length) {
    benchEl.style.display = "none";
    return;
  }
  benchEl.style.display = "block";

  const maxMin = Math.max(0, ...playersWithStats.map(p => p.stats[p.stats.length - 1].minute));
  const labels = [];
  for (let m = 1; m <= maxMin; m++) labels.push(`${m} min`);

  function getVal(stats, minute, key) {
    const e = stats.find(s => s.minute === minute);
    return e ? (e[key] ?? null) : null;
  }

  function forwardFill(stats, key) {
    let last = null;
    const arr = [];
    for (let m = 1; m <= maxMin; m++) {
      const v = getVal(stats, m, key);
      if (v != null) last = v;
      arr.push(last != null ? last : 0);
    }
    return arr;
  }

  function playerHue(i) {
    return (i * 47.618 + 13.7) % 360;
  }

  function lineDataset(label, data, hue, opts = {}) {
    const dashed = Array.isArray(opts.borderDash);
    return {
      label,
      data,
      borderColor: `hsl(${hue}, 70%, ${dashed ? 52 : 58}%)`,
      backgroundColor: `hsla(${hue}, 70%, 55%, 0.08)`,
      tension: 0.3,
      pointRadius: maxMin > 48 ? 0 : 2,
      borderDash: opts.borderDash,
      fill: false,
    };
  }

  const dsWorkers = playersWithStats.map((p, i) => {
    const hue = playerHue(i);
    let dataPts;
    if (Array.isArray(p.workers_curve) && p.workers_curve.length > 0) {
      dataPts = p.workers_curve.map(pt => ({ x: pt.t, y: pt.w }));
    } else {
      const ser = forwardFill(p.stats, "workers");
      dataPts = [];
      for (let m = 1; m <= maxMin; m++) dataPts.push({ x: m, y: ser[m - 1] ?? 0 });
    }
    return {
      label: `${p.name} 农民`,
      data: dataPts,
      borderColor: `hsl(${hue}, 70%, 58%)`,
      backgroundColor: `hsla(${hue}, 70%, 55%, 0.08)`,
      tension: 0,
      stepped: "after",
      pointRadius: dataPts.length > 72 ? 0 : 2,
      fill: false,
    };
  });

  const dsArmy = [];
  playersWithStats.forEach((p, i) => {
    const h = playerHue(i);
    dsArmy.push(lineDataset(`${p.name} 军队(矿)`, forwardFill(p.stats, "army_minerals"), h));
    dsArmy.push(lineDataset(`${p.name} 军队(气)`, forwardFill(p.stats, "army_vespene"), h, { borderDash: [5, 4] }));
  });

  const dsCollection = [];
  playersWithStats.forEach((p, i) => {
    const h = playerHue(i);
    dsCollection.push(lineDataset(`${p.name} 矿采集`, forwardFill(p.stats, "minerals_rate"), h));
    dsCollection.push(lineDataset(`${p.name} 气采集`, forwardFill(p.stats, "vespene_rate"), h, { borderDash: [5, 4] }));
  });

  const dsSupply = [];
  playersWithStats.forEach((p, i) => {
    const h = playerHue(i);
    dsSupply.push(lineDataset(`${p.name} 已用人口`, forwardFill(p.stats, "food_used"), h));
    dsSupply.push(lineDataset(`${p.name} 补给上限`, forwardFill(p.stats, "food_made"), h, { borderDash: [5, 4] }));
  });

  const dsWorkerKD = [];
  playersWithStats.forEach((p, i) => {
    const h = playerHue(i);
    dsWorkerKD.push(lineDataset(`${p.name} 累计击杀工人`, forwardFill(p.stats, "workers_killed"), h));
    dsWorkerKD.push(lineDataset(`${p.name} 累计损失工人`, forwardFill(p.stats, "workers_lost"), h, { borderDash: [5, 4] }));
  });

  const defaultOpts = {
    responsive: true,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: "#e6edf3", font: { size: 10 } } } },
    scales: {
      x: { ticks: { color: "#8b949e", maxRotation: 45 }, grid: { color: "rgba(48,54,61,0.5)" } },
      y: { ticks: { color: "#8b949e" }, grid: { color: "rgba(48,54,61,0.5)" }, beginAtZero: true },
    },
  };

  function makeChart(canvasId, type, datasets) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const c = new Chart(ctx, {
      type,
      data: { labels, datasets },
      options: JSON.parse(JSON.stringify(defaultOpts)),
    });
    appState.chartInstances.push(c);
  }

  function makeWorkersChart(canvasId, datasets) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const opts = JSON.parse(JSON.stringify(defaultOpts));
    opts.scales.x = {
      type: "linear",
      ticks: { color: "#8b949e", maxTicksLimit: 14 },
      grid: { color: "rgba(48,54,61,0.5)" },
      title: { display: true, text: "游戏分钟 (更快，每秒一点)", color: "#8b949e", font: { size: 11 } },
    };
    const c = new Chart(ctx, { type: "line", data: { datasets }, options: opts });
    appState.chartInstances.push(c);
  }

  makeWorkersChart("chartWorkers", dsWorkers);
  makeChart("chartArmy", "line", dsArmy);
  makeChart("chartCollection", "line", dsCollection);
  makeChart("chartSupply", "line", dsSupply);
  makeChart("chartWorkerKD", "line", dsWorkerKD);
}
