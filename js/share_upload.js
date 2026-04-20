import { appState } from "./state.js";
import { escapeHtml } from "./format_utils.js";
import { trackEvent } from "./telemetry.js";
import { uploadReplayShare } from "./upload_api.js";

const PANEL_ID = "shareUploadPanel";

function buildReplayShareUrl(md5) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(/\/[^/]*$/, "/replays.html");
  url.search = "";
  url.searchParams.set("md5", String(md5 || "").trim());
  url.hash = "";
  return url.toString();
}

function buildShareCopyText(message, url) {
  const safeMessage = String(message || "").trim() || "无留言";
  return `我分享了一个录像，关于${safeMessage}，快来sc2replayAnalysis 看看吧：${url}`;
}

async function copyTextToClipboard(text) {
  const copyText = String(text || "");
  if (!copyText) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = copyText;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

function getPlayersText(data) {
  const names = [];
  if (!Array.isArray(data?.teams)) return "—";
  for (const team of data.teams) {
    if (!Array.isArray(team?.players)) continue;
    for (const p of team.players) {
      if (p?.name) names.push(String(p.name));
    }
  }
  return names.length ? names.join("、") : "—";
}

export function renderSharePanel(data) {
  const host = document.getElementById("shareUploadHost");
  if (!host) return;
  host.innerHTML = "";

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.className = "share-panel";
  panel.innerHTML = `
    <button class="share-panel-toggle" id="sharePanelToggle" type="button">共享这份录像到公开库</button>
    <div class="share-panel-body" id="sharePanelBody" style="display:none">
      <p class="share-panel-desc">分享会把录像与摘要信息上传到公共仓库，提交前服务端会再次校验录像格式与元数据。</p>
      <div class="share-meta-grid">
        <span><strong>地图</strong> ${escapeHtml(data?.map_name || "Unknown")}</span>
        <span><strong>玩家</strong> ${escapeHtml(getPlayersText(data))}</span>
        <span><strong>胜者</strong> ${escapeHtml(data?.winner || "—")}</span>
        <span><strong>时长</strong> ${escapeHtml(String(data?.game_length || 0))} 秒</span>
        <span><strong>区域</strong> ${escapeHtml(data?.region || "—")}</span>
        <span><strong>版本</strong> ${escapeHtml(data?.client_version || "—")}</span>
      </div>
      <label class="share-consent"><input type="checkbox" id="shareAgreePublic" /> 我同意这份录像将会在互联网上公开</label>
      <label class="share-consent"><input type="checkbox" id="shareAgreeUsage" /> 我确定他人可以使用这份录像之中的流程和相关数据</label>
      <label class="share-message-label" for="shareMessage">留言板：描述你的录像是什么战术（限制50字）</label>
      <textarea id="shareMessage" maxlength="50" rows="2" placeholder="例如：三矿运营转双线空投"></textarea>
      <div class="share-message-footer"><span id="shareMessageCount">0/50</span></div>
      <div class="share-actions">
        <button id="shareSubmitBtn" class="share-submit-btn" type="button">分享（上传并复制）</button>
        <span id="shareSubmitStatus" class="share-submit-status"></span>
      </div>
    </div>
  `;
  host.appendChild(panel);

  const toggleBtn = document.getElementById("sharePanelToggle");
  const body = document.getElementById("sharePanelBody");
  const msgInput = document.getElementById("shareMessage");
  const msgCount = document.getElementById("shareMessageCount");
  const submitBtn = document.getElementById("shareSubmitBtn");
  const status = document.getElementById("shareSubmitStatus");

  if (toggleBtn && body) {
    toggleBtn.addEventListener("click", () => {
      const willShow = body.style.display === "none";
      body.style.display = willShow ? "block" : "none";
      trackEvent("share_panel_opened", { open: willShow });
    });
  }
  if (msgInput && msgCount) {
    msgInput.addEventListener("input", () => {
      const v = msgInput.value || "";
      msgCount.textContent = `${v.length}/50`;
    });
  }
  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const agreedPublic = !!document.getElementById("shareAgreePublic")?.checked;
      const agreedUsage = !!document.getElementById("shareAgreeUsage")?.checked;
      const message = (msgInput?.value || "").trim();
      if (!agreedPublic || !agreedUsage) {
        if (status) status.textContent = "请先勾选两个同意项";
        return;
      }
      if (!appState.lastFile) {
        if (status) status.textContent = "当前无可上传的本地录像文件，请重新选择并解析";
        return;
      }
      const confirmed = window.confirm("点击确定后将执行上传并公开该录像；上传完成后会自动复制分享文案。是否继续？");
      if (!confirmed) {
        if (status) status.textContent = "已取消分享上传";
        return;
      }
      trackEvent("share_submit_clicked", { hasMessage: !!message });
      submitBtn.disabled = true;
      if (status) status.textContent = "上传中，请稍候...";
      try {
        const result = await uploadReplayShare({
          replayFile: appState.lastFile,
          agreedPublic,
          agreedUsage,
          message,
          data,
        });
        const md5 = String(result?.md5 || "").trim();
        if (!md5) throw new Error("上传成功但未返回 md5，无法生成分享链接");
        const shareUrl = buildReplayShareUrl(md5);
        const copyText = buildShareCopyText(message, shareUrl);
        const copied = await copyTextToClipboard(copyText);
        if (status) {
          status.textContent = copied
            ? `上传成功，分享文案已复制：${shareUrl}`
            : `上传成功，请手动复制链接：${shareUrl}`;
        }
        trackEvent("share_upload_success", {
          md5,
          duplicate: !!result?.duplicate,
          copied,
        });
      } catch (err) {
        const msg = err?.message || "上传失败";
        if (status) status.textContent = msg;
        trackEvent("share_upload_failed", { detail: msg });
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
}
