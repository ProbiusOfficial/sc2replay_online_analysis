export function setupExportButtons() {
  const buildOrders = document.getElementById("buildOrders");
  if (!buildOrders) return;
  buildOrders.querySelectorAll(".player-panel").forEach(panel => {
    const btn = panel.querySelector(".export-btn");
    if (!btn) return;
    btn.onclick = () => {
      const lines = [];
      panel.querySelectorAll(".build-item").forEach(item => {
        const t = item.querySelector(".time")?.textContent.trim() || "";
        const s = item.querySelector(".supply")?.textContent.trim() || "";
        const u = item.querySelector(".unit")?.textContent.trim() || "";
        if (t || s || u) lines.push([t, s, u].filter(Boolean).join(" "));
      });
      const name = panel.querySelector(".player-name")?.textContent.trim() || "player";
      const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}_build.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    };
  });
}
