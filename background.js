// คลิกไอคอน extension -> inject/toggle ตัว editor ลงในแท็บปัจจุบัน
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["editor.js"],
    });
  } catch (e) {
    // หน้า chrome:// หรือ Web Store จะ inject ไม่ได้
    console.warn("Relayout Editor: inject ไม่ได้บนหน้านี้", e);
  }
});

// เก็บขนาดหน้าต่างเดิมก่อนปรับ responsive preview (ต่อ window)
const origSizes = {};

// content script ขอ screenshot / ปรับขนาดหน้าต่าง
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "rl-capture") {
    chrome.tabs.captureVisibleTab(
      sender.tab ? sender.tab.windowId : undefined,
      { format: "png" },
      (dataUrl) => {
        sendResponse({ dataUrl: dataUrl || null, error: chrome.runtime.lastError?.message });
      }
    );
    return true; // async sendResponse
  }

  if (msg && msg.type === "rl-resize" && sender.tab) {
    const winId = sender.tab.windowId;
    chrome.windows.get(winId, (win) => {
      if (msg.restore) {
        const o = origSizes[winId];
        if (o) chrome.windows.update(winId, { width: o.width, height: o.height, state: "normal" });
        delete origSizes[winId];
      } else {
        if (!origSizes[winId]) origSizes[winId] = { width: win.width, height: win.height };
        chrome.windows.update(winId, { width: Math.max(320, msg.width), state: "normal" });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});
