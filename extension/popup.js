const select = selector => document.querySelector(selector);
let entries = [];
let visibleLimit = 60;
let editing = null;
let deleting = null;
let reloadTimer;
let requestSequence = 0;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "插件暂不可用，请重新打开弹窗。");
  return response;
}

function showError(error) {
  select("#error").textContent = error.message;
  select("#error").hidden = false;
}

function iconButton(label, path, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.className = className;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  button.append(svg);
  button.addEventListener("click", handler);
  return button;
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function render() {
  const query = select("#search").value.trim().toLowerCase();
  const filtered = entries.filter(entry => entry.word.includes(query) || entry.definition?.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const entry of filtered.slice(0, visibleLimit)) {
    const article = textElement("article", "word", "");
    const top = textElement("div", "word-top", "");
    top.append(textElement("h2", "word-title", entry.word));
    const actions = textElement("div", "word-actions", "");
    actions.append(
      iconButton(`编辑 ${entry.word} 的释义`, "m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5", () => openEdit(entry)),
      iconButton(`删除 ${entry.word}`, "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6", () => openDelete(entry), "delete"),
    );
    top.append(actions);
    article.append(top, textElement("p", `definition${entry.definition ? "" : " missing"}`, entry.definition || "词典暂未收录，点击编辑补充释义"));
    const metadata = textElement("div", "word-meta", "");
    const date = new Date(entry.createdAt);
    const time = textElement("time", "", date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }));
    time.dateTime = date.toISOString();
    metadata.append(time);
    if (entry.customDefinition !== null) metadata.append(textElement("span", "custom-label", "手动释义"));
    if (entry.pending) metadata.append(textElement("span", "pending-label", "仅本地 · 待提交"));
    article.append(metadata);
    fragment.append(article);
  }
  select("#word-list").replaceChildren(fragment);
  select("#list-label").textContent = query ? `找到 ${filtered.length} 个单词` : "全部单词";
  select("#empty").hidden = filtered.length > 0;
  select("#empty-title").textContent = query ? "没有找到这个单词" : "你的第一枚生词，等你拾起";
  select("#empty-description").textContent = query ? "换个关键词，也可以搜索中文释义。" : "在网页上选中英文单词，右键收藏。\n中文释义会自动准备好。";
  select("#load-more").hidden = filtered.length <= visibleLimit;
}

async function reload() {
  const sequence = ++requestSequence;
  const data = await send({ type: "list" });
  if (sequence !== requestSequence) return;
  entries = data.entries;
  select("#total-count").textContent = entries.length.toLocaleString("zh-CN");
  select("#sync-status").textContent = data.pending ? `${data.pending} 项待提交` : data.issue ? "同步暂不可用" : "已提交 Chrome";
  select("#sync-status").classList.toggle("pending", data.pending > 0 || !!data.issue);
  select("#storage-label").textContent = `${(data.bytes / 1024).toFixed(1)} / ${data.quota / 1024} KB`;
  select("#storage-meter").value = data.bytes;
  select("#storage-meter").max = data.quota;
  const notices = [data.issue, data.pendingDeletions ? `${data.pendingDeletions} 项删除尚未提交。` : null, data.dictionaryIssue].filter(Boolean);
  select("#notice").textContent = notices.join(" ");
  select("#notice").hidden = !notices.length;
  select("#error").hidden = true;
  render();
}

function openEdit(entry) {
  editing = entry;
  select("#edit-word").textContent = entry.word;
  select("#definition").value = entry.customDefinition ?? entry.definition ?? "";
  select("#edit-error").hidden = true;
  updateCount();
  select("#edit-dialog").showModal();
  select("#definition").focus();
}

function updateCount() {
  select("#character-count").textContent = `${select("#definition").value.length} / 1000`;
}

function openDelete(entry) {
  deleting = entry;
  select("#delete-word").textContent = entry.word;
  select("#delete-error").hidden = true;
  select("#delete-dialog").showModal();
  select("#delete-cancel").focus();
}

select("#edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  select("#edit-save").disabled = true;
  try {
    const value = select("#definition").value;
    const definition = editing.customDefinition === null && value.trim() === editing.definition?.trim() ? "" : value;
    await send({ type: "edit", word: editing.word, definition, expected: editing.revision });
    select("#edit-dialog").close();
    await reload();
  } catch (error) {
    select("#edit-error").textContent = error.message;
    select("#edit-error").hidden = false;
  } finally { select("#edit-save").disabled = false; }
});

select("#delete-form").addEventListener("submit", async event => {
  event.preventDefault();
  select("#delete-confirm").disabled = true;
  try {
    await send({ type: "delete", word: deleting.word, expected: deleting.revision });
    select("#delete-dialog").close();
    await reload();
  } catch (error) {
    select("#delete-error").textContent = error.message;
    select("#delete-error").hidden = false;
  } finally { select("#delete-confirm").disabled = false; }
});

select("#export-button").addEventListener("click", async () => {
  select("#export-button").disabled = true;
  try {
    const data = await send({ type: "export" });
    const backup = { format: "wordkeep-backup", version: 1, exportedAt: new Date().toISOString(), words: data.entries.map(entry => ({ word: entry.word, definition: entry.definition, customDefinition: entry.customDefinition, createdAt: new Date(entry.createdAt).toISOString(), pending: entry.pending })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `wordkeep-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showError(error); }
  finally { select("#export-button").disabled = false; }
});

select("#sync-button").addEventListener("click", async () => {
  select("#sync-button").disabled = true;
  try { await send({ type: "sync" }); await reload(); }
  catch (error) { showError(error); }
  finally { select("#sync-button").disabled = false; }
});

select("#search").addEventListener("input", () => { visibleLimit = 60; render(); });
select("#definition").addEventListener("input", updateCount);
select("#load-more").addEventListener("click", () => { visibleLimit += 60; render(); });
select("#help-toggle").addEventListener("click", () => {
  select("#help").hidden = !select("#help").hidden;
  select("#help-toggle").setAttribute("aria-expanded", String(!select("#help").hidden));
});
for (const button of ["#edit-close", "#edit-cancel"]) select(button).addEventListener("click", () => select("#edit-dialog").close());
select("#delete-cancel").addEventListener("click", () => select("#delete-dialog").close());
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    select("#search").focus();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.notebook) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void reload().catch(showError), 200);
});
void chrome.action.setBadgeText({ text: "" });
void reload().catch(showError);
