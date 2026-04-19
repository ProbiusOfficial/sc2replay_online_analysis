import { PARSE_SCRIPT } from "./parse_script.js";
import { appState } from "./state.js";
import { PYODIDE_VERSION } from "./constants.js";
import { setInitStatus } from "./errors_init.js";

export async function parseReplayBufferToData(buffer) {
  if (!appState.pyodide) throw new Error("解析环境尚未就绪");
  appState.pyodide.FS.writeFile("/tmp/replay.SC2Replay", new Uint8Array(buffer));
  try {
    const code = `${PARSE_SCRIPT}\nresult = extract_replay_data("/tmp/replay.SC2Replay")\njson.dumps(result)`;
    const json = await appState.pyodide.runPythonAsync(code);
    return JSON.parse(json);
  } finally {
    try { appState.pyodide.FS.unlink("/tmp/replay.SC2Replay"); } catch (_) {}
  }
}

export async function initPyodide() {
  const initStatus = document.getElementById("initStatus");
  const dropZone = document.getElementById("dropZone");
  try {
    setInitStatus("加载 Pyodide 运行时...");
    appState.pyodide = await loadPyodide({ indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` });

    setInitStatus("安装 mpyq（从源码）...");
    const mpyqResp = await fetch("https://cdn.jsdelivr.net/gh/eagleflo/mpyq@master/mpyq.py");
    if (!mpyqResp.ok) throw new Error("mpyq 下载失败: " + mpyqResp.status);
    appState.pyodide.FS.mkdirTree("/tmp");
    appState.pyodide.FS.writeFile("/tmp/mpyq.py", new TextEncoder().encode(await mpyqResp.text()));
    await appState.pyodide.runPythonAsync(`import sys\nsys.path.insert(0, "/tmp")\nimport mpyq`);

    setInitStatus("安装 sc2reader & spawningtool...");
    await appState.pyodide.loadPackage("micropip");
    await appState.pyodide.runPythonAsync(`import micropip\nawait micropip.install('sc2reader', deps=False)\nawait micropip.install('spawningtool', deps=False)`);

    if (initStatus) initStatus.style.display = "none";
    if (dropZone) dropZone.style.display = "block";
  } catch (e) {
    console.error(e);
    setInitStatus("");
    if (initStatus) initStatus.innerHTML = `<p style="color:var(--accent-red)">初始化失败: ${e.message}</p><p style="margin-top:0.5rem;font-size:0.85rem">请检查网络连接后刷新重试。</p>`;
  }
}
