import { Notebook } from "./core/notebook.js";
import { Dictionary } from "./core/dictionary.js";

const notebook = new Notebook({ local: chrome.storage.local, sync: chrome.storage.sync });
const dictionary = new Dictionary();
const menuId = "wordkeep-add";

async function prepare() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.alarms.create("wordkeep-sync", { periodInMinutes: 1 });
}

function report(error) {
  console.error("Wordkeep:", error);
  void chrome.action.setBadgeBackgroundColor({ color: "#A73B32" });
  void chrome.action.setBadgeText({ text: "!" });
  void chrome.action.setTitle({ title: `拾词：${error.message}` });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) report(new Error(chrome.runtime.lastError.message));
    chrome.contextMenus.create({ id: menuId, title: "收藏到拾词：%s", contexts: ["selection"] }, () => {
      if (chrome.runtime.lastError) report(new Error(chrome.runtime.lastError.message));
    });
  });
  void prepare().then(() => notebook.dispatch({ type: "sync" })).catch(report);
});

chrome.runtime.onStartup.addListener(() => {
  void prepare().then(() => notebook.dispatch({ type: "sync" })).catch(report);
});

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId !== menuId) return;
  void notebook.dispatch({ type: "add", word: info.selectionText }).then(async result => {
    const entry = result.entries.find(item => item.word === result.word);
    if (!entry) {
      await chrome.action.setBadgeText({ text: "−" });
      await chrome.action.setTitle({ title: `拾词：${result.word} 已被另一台设备删除` });
      return;
    }
    const text = !result.added ? "已收藏" : entry.pending ? "已本地保存，待提交 Chrome" : "已收藏并提交 Chrome";
    await chrome.action.setBadgeBackgroundColor({ color: entry.pending ? "#AA6729" : "#3F6B59" });
    await chrome.action.setBadgeText({ text: !result.added ? "=" : entry.pending ? "•" : "✓" });
    await chrome.action.setTitle({ title: `拾词：${result.word} ${text}` });
  }).catch(report);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "wordkeep-sync") void notebook.dispatch({ type: "sync" }).catch(report);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") void notebook.dispatch({ type: "sync", changes }).catch(report);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  if (!message || !["list", "edit", "delete", "sync", "export"].includes(message.type)) return false;
  void notebook.dispatch(message).then(async result => {
    if (message.type === "list" || message.type === "export") {
      result.dictionaryIssue = null;
      result.entries = await Promise.all(result.entries.map(async entry => {
        if (entry.customDefinition !== null) return { ...entry, definition: entry.customDefinition };
        try { return { ...entry, definition: await dictionary.lookup(entry.word) }; }
        catch (error) { result.dictionaryIssue = error.message; return { ...entry, definition: null }; }
      }));
    }
    sendResponse({ ok: true, ...result });
  }).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
