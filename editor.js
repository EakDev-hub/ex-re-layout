// Relayout Editor — content script (inject ผ่าน background เมื่อคลิกไอคอน)
// คลิกไอคอนซ้ำ = เปิด/ปิดสลับกัน
(() => {
  "use strict";

  // ถ้ามี instance อยู่แล้ว -> toggle
  if (window.__relayoutEditor) {
    window.__relayoutEditor.toggle();
    return;
  }

  const HOST_ID = "__relayout_host";

  // ---------------------------------------------------------------
  // state
  // ---------------------------------------------------------------
  const state = {
    enabled: false,
    mode: "edit",            // "edit" = คลิกเลือก/แก้ · "action" = ใช้งานหน้าเว็บตามปกติ
    selected: null,          // element ที่เลือกอยู่
    multi: [],               // เลือกหลายชิ้น (Shift+ลากคลุม / Shift+คลิก)
    marquee: null,           // กรอบคลุมเลือกที่กำลังลากอยู่
    editingText: false,      // กำลังแก้ข้อความ (contenteditable) อยู่ไหม
    dragging: null,          // ข้อมูล drag ปัจจุบัน
    changes: new Map(),      // Element -> change record
    addedSections: [],       // { el, refSelector, position }
    undoStack: [],           // { label, undo(), redo() }
    redoStack: [],           // action ที่ undo ไปแล้ว รอ redo
    clipboard: null,         // { node, from } element ที่คัดลอกไว้
    seq: 0,
  };

  // ---------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function shortLabel(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList.length) s += "." + Array.from(el.classList).slice(0, 2).join(".");
    return s;
  }

  function rgbToHex(rgb) {
    const m = rgb && rgb.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return "#ffffff";
    return (
      "#" +
      [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, "0")).join("")
    );
  }

  function getRecord(el) {
    let rec = state.changes.get(el);
    if (!rec) {
      rec = {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        styles: {},        // prop -> { from, to }
        text: null,        // { from, to }
        image: null,       // { from, to }
        movedTo: null,     // { parent, before } ตำแหน่งใหม่ใน DOM
        domMoved: 0,       // จำนวนครั้งที่ย้ายลำดับใน DOM
        hidden: false,
        deleted: false,
        // ตำแหน่ง DOM เดิม ณ ตอนเริ่มแก้ (ใช้ตอน reset)
        origParent: el.parentElement,
        origNext: el.nextSibling,
      };
      state.changes.set(el, rec);
      el.setAttribute("data-rl-changed", "");
    }
    return rec;
  }

  function pushUndo(label, undo, redo) {
    state.undoStack.push({ label, undo, redo });
    state.redoStack.length = 0; // มี action ใหม่ = สาย redo เดิมใช้ไม่ได้แล้ว
    updateUndoButton();
    scheduleSave();
  }

  // แทรก el กลับเข้า parent ก่อน next (ถ้า next หลุดจาก parent ไปแล้ว = ต่อท้าย)
  function insertAt(el, parent, next) {
    if (!parent || !parent.isConnected) return;
    parent.insertBefore(el, next && next.parentNode === parent ? next : null);
  }

  // บันทึกการแก้ style + ทำจริง + เก็บ undo
  function applyStyle(el, prop, value) {
    const rec = getRecord(el);
    const computedFrom = getComputedStyle(el)[prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    const prevInline = el.style.getPropertyValue(prop);
    if (!rec.styles[prop]) rec.styles[prop] = { from: computedFrom, to: value };
    else rec.styles[prop].to = value;
    el.style.setProperty(prop, value, "important");
    pushUndo(`แก้ ${prop} ของ ${shortLabel(el)}`, () => {
      if (prevInline) el.style.setProperty(prop, prevInline);
      else el.style.removeProperty(prop);
      rec.styles[prop].to = prevInline || rec.styles[prop].from;
      refreshBoxes();
      if (state.selected === el) populateInspector(el);
    }, () => {
      el.style.setProperty(prop, value, "important");
      rec.styles[prop].to = value;
      refreshBoxes();
      if (state.selected === el) populateInspector(el);
    });
  }

  // แก้หลาย property พร้อมกันเป็น undo เดียว (ใช้กับ layout preset / custom CSS)
  function applyStyles(el, props, label) {
    const rec = getRecord(el);
    const entries = Object.entries(props).map(([prop, value]) => {
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const from = getComputedStyle(el)[camel];
      const prevInline = el.style.getPropertyValue(prop);
      if (!rec.styles[prop]) rec.styles[prop] = { from, to: value };
      else rec.styles[prop].to = value;
      el.style.setProperty(prop, value, "important");
      return { prop, value, from, prevInline };
    });
    pushUndo(label, () => {
      for (const en of entries) {
        if (en.prevInline) el.style.setProperty(en.prop, en.prevInline);
        else el.style.removeProperty(en.prop);
        rec.styles[en.prop].to = en.prevInline || en.from;
      }
      refreshBoxes();
      if (state.selected === el) populateInspector(el);
    }, () => {
      for (const en of entries) {
        el.style.setProperty(en.prop, en.value, "important");
        rec.styles[en.prop].to = en.value;
      }
      refreshBoxes();
      if (state.selected === el) populateInspector(el);
    });
    updateCounter();
  }

  function download(filename, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function toast(msg) {
    const t = ui.toast;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---------------------------------------------------------------
  // UI (Shadow DOM กันสไตล์ชนกับหน้าเว็บ)
  // ---------------------------------------------------------------
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; top:0; left:0;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, "Noto Sans Thai", sans-serif; }

    .hoverbox, .selectbox {
      position: fixed; pointer-events: none; display: none;
      z-index: 2147483646;
    }
    .hoverbox { outline: 2px dashed #7c3aed; outline-offset: -1px; background: rgba(124,58,237,.08); }
    .selectbox { outline: 2px solid #7c3aed; outline-offset: -1px; }
    .selectbox .rz {
      position: absolute; pointer-events: auto; background: #7c3aed;
      border: 1.5px solid #fff; border-radius: 50%; width: 11px; height: 11px;
      box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .rz-e { right: -6px; top: 50%; margin-top: -6px; cursor: ew-resize; }
    .rz-s { bottom: -6px; left: 50%; margin-left: -6px; cursor: ns-resize; }
    .rz-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
    .crumbs { display: none; flex-wrap: wrap; gap: 3px; align-items: center; margin: -4px 0 10px; color: #6b5f97; font-size: 10px; }
    .crumbs.show { display: flex; }
    .crumbs button {
      background: #2a1f4a; border: 1px solid #3b2d63; color: #b9aee0; border-radius: 5px;
      padding: 2px 7px; font-size: 10.5px; cursor: pointer; font-family: ui-monospace, monospace;
    }
    .crumbs button:hover { background: #443574; color: #fff; }
    .crumbs button.cur { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    .dropline {
      position: fixed; pointer-events: none; display: none;
      background: #7c3aed; border-radius: 2px; z-index: 2147483646;
      box-shadow: 0 0 8px rgba(124,58,237,.9);
    }
    .marquee {
      position: fixed; pointer-events: none; display: none;
      border: 1.5px dashed #7c3aed; background: rgba(124,58,237,.12);
      z-index: 2147483646; border-radius: 3px;
    }
    .mbox {
      position: fixed; pointer-events: none;
      outline: 2px solid #7c3aed; outline-offset: -1px;
      background: rgba(124,58,237,.07); z-index: 2147483645;
    }
    .selectbox .tag {
      position: absolute; top: -22px; left: 0; background: #7c3aed; color: #fff;
      font-size: 11px; padding: 2px 8px; border-radius: 4px; white-space: nowrap;
    }

    .panel {
      position: fixed; top: 16px; right: 16px; width: 302px; max-height: calc(100vh - 32px);
      background: #1c1530; color: #ece9f6; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.45); display: flex; flex-direction: column;
      font-size: 13px; overflow: hidden; border: 1px solid #3b2d63;
    }
    .panel-header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #2a1f4a; cursor: grab; user-select: none;
    }
    .panel-header .dot { width: 10px; height: 10px; border-radius: 50%; background: #a78bfa; }
    .panel-header b { flex: 1; font-size: 13px; font-weight: 600; }
    .panel-header button {
      background: none; border: 0; color: #b9aee0; cursor: pointer; font-size: 15px; padding: 2px 6px;
    }
    .panel-header button:hover { color: #fff; }
    .panel-body { overflow-y: auto; padding: 10px 12px 14px; }

    .hint { color: #9c8fd0; font-size: 11.5px; line-height: 1.6; margin-bottom: 10px; }
    .sel-info {
      background: #2a1f4a; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px;
      font-family: ui-monospace, monospace; font-size: 11px; color: #c4b5fd; word-break: break-all;
    }
    .sel-info.empty { color: #7a6fa8; font-family: inherit; }

    h4 { margin: 12px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8d80c0; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .row label { flex: 1; color: #cfc7ec; font-size: 12.5px; }
    input[type="color"] {
      width: 40px; height: 26px; border: 1px solid #4b3d78; border-radius: 6px;
      background: #14102a; padding: 1px 2px; cursor: pointer;
    }
    input[type="number"], input[type="text"] {
      width: 88px; background: #14102a; border: 1px solid #4b3d78; color: #ece9f6;
      border-radius: 6px; padding: 4px 7px; font-size: 12px; outline: none;
    }
    input[type="text"].wide { width: 100%; }
    input:focus { border-color: #a78bfa; }

    .btnrow { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
    button.act {
      background: #362a5e; color: #e5defc; border: 1px solid #4b3d78; border-radius: 7px;
      padding: 6px 10px; font-size: 12px; cursor: pointer; flex: 1 1 auto;
    }
    button.act:hover { background: #443574; }
    button.act.primary { background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 600; }
    button.act.primary:hover { background: #8b5cf6; }
    button.act.danger { color: #fda4af; }
    button.act.danger:hover { background: #4c1d2e; }
    button.act:disabled { opacity: .4; cursor: default; }
    button.act.on { background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 600; }

    .divider { height: 1px; background: #3b2d63; margin: 12px 0; }
    button.mini {
      background: #362a5e; border: 1px solid #4b3d78; color: #e5defc;
      border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 12px;
    }
    button.mini:hover { background: #443574; }
    button.mini.on { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    select {
      background: #14102a; border: 1px solid #4b3d78; color: #ece9f6;
      border-radius: 6px; padding: 4px 6px; font-size: 12px; width: 96px; outline: none;
    }
    input[type="range"] { width: 96px; accent-color: #7c3aed; }
    .marginrow { gap: 5px; }
    .marginrow input { width: 25%; min-width: 0; flex: 1; }
    textarea {
      width: 100%; background: #14102a; border: 1px solid #4b3d78; color: #ece9f6;
      border-radius: 6px; padding: 6px 8px; font-size: 11.5px; outline: none; resize: vertical;
      font-family: ui-monospace, monospace; line-height: 1.5;
    }
    textarea:focus { border-color: #a78bfa; }
    .imgrow { display: none; }
    .imgrow.show { display: block; }
    .filelabel {
      display: block; text-align: center; background: #362a5e; border: 1px dashed #5b4a8f;
      border-radius: 7px; padding: 6px; font-size: 12px; cursor: pointer; margin-top: 6px; color: #cfc7ec;
    }
    .filelabel:hover { background: #443574; }
    input[type="file"] { display: none; }

    .changelist { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
    .chg { display: flex; align-items: center; gap: 6px; background: #2a1f4a; border-radius: 6px; padding: 4px 7px; font-size: 11px; }
    .chg .lbl {
      flex: 1; font-family: ui-monospace, monospace; color: #c4b5fd;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
    }
    .chg .lbl:hover { color: #fff; text-decoration: underline; }
    .chg .kinds { color: #8d80c0; font-size: 10px; white-space: nowrap; }
    .chg button { background: none; border: 0; cursor: pointer; font-size: 11px; padding: 1px 3px; }
    .restorebar {
      background: #2a1f4a; border: 1px solid #7c3aed; border-radius: 8px;
      padding: 8px 10px; margin-bottom: 10px; font-size: 12px; display: none;
      flex-direction: column; gap: 8px;
    }
    .restorebar.show { display: flex; }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
      background: #1c1530; color: #ece9f6; border: 1px solid #7c3aed; border-radius: 10px;
      padding: 10px 18px; font-size: 13px; opacity: 0; transition: all .25s; pointer-events: none;
      box-shadow: 0 8px 30px rgba(0,0,0,.4);
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    .counter { font-size: 11px; color: #8d80c0; text-align: center; margin-top: 8px; }

    /* ── โครงใหม่: modebar + tabs + pane ── */
    .panel.min .panel-main { display: none; }
    .panel-main { display: flex; flex-direction: column; min-height: 0; }
    .modebar { display: flex; gap: 6px; padding: 10px 12px 0; }
    .modebar .act { flex: 1; }
    .tabs { display: flex; gap: 2px; margin-top: 8px; padding: 0 8px; border-bottom: 1px solid #3b2d63; }
    .tab {
      flex: 1; background: none; border: 0; border-bottom: 2px solid transparent;
      color: #9c8fd0; padding: 8px 0 7px; font-size: 12px; cursor: pointer; position: relative;
      font-family: inherit;
    }
    .tab:hover { color: #e5defc; }
    .tab.on { color: #fff; border-bottom-color: #a78bfa; font-weight: 600; }
    .tab .badge {
      position: absolute; top: 1px; right: 4px; background: #7c3aed; color: #fff;
      font-size: 9px; min-width: 14px; height: 14px; line-height: 14px;
      border-radius: 7px; padding: 0 3px; display: none; font-weight: 600;
    }
    .tab .badge.show { display: inline-block; }
    .tabpane { display: none; }
    .tabpane.on { display: block; }

    /* ปุ่มจัดการแบบ icon grid */
    .qa { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 10px; }
    .qa.qa3 { grid-template-columns: repeat(3, 1fr); }
    .qa button {
      background: #362a5e; border: 1px solid #4b3d78; color: #e5defc; border-radius: 8px;
      padding: 7px 2px 5px; cursor: pointer; display: flex; flex-direction: column;
      align-items: center; gap: 3px; font-family: inherit;
    }
    .qa button span { font-size: 15px; line-height: 1; }
    .qa button small { font-size: 9.5px; color: #b9aee0; line-height: 1; }
    .qa button:hover { background: #443574; }
    .qa button.danger small { color: #fda4af; }
    .qa button.danger:hover { background: #4c1d2e; }

    /* หมวดพับได้ใน inspector */
    details.sec { border: 1px solid #3b2d63; border-radius: 8px; margin-bottom: 8px; background: #221941; }
    details.sec summary {
      list-style: none; cursor: pointer; padding: 8px 10px; font-size: 12px; font-weight: 600;
      color: #cfc7ec; display: flex; align-items: center; gap: 7px; user-select: none;
    }
    details.sec summary::-webkit-details-marker { display: none; }
    details.sec summary::before { content: "▸"; color: #8d80c0; font-size: 10px; transition: transform .15s; }
    details.sec[open] summary::before { transform: rotate(90deg); }
    details.sec .secbody { padding: 2px 10px 8px; }
    .changelist.tall { max-height: 340px; }
  </style>

  <div class="hoverbox"></div>
  <div class="selectbox">
    <span class="tag"></span>
    <span class="rz rz-e"></span><span class="rz rz-s"></span><span class="rz rz-se"></span>
  </div>
  <div class="dropline"></div>
  <div class="marquee"></div>
  <div class="multiboxes"></div>

  <div class="panel">
    <div class="panel-header" id="dragbar">
      <span class="dot"></span><b>Relayout Editor</b>
      <button id="btn-undo" title="Undo (⌘Z)" disabled>↩︎</button>
      <button id="btn-redo" title="Redo (⇧⌘Z)" disabled>↪︎</button>
      <button id="btn-min" title="ย่อ/ขยาย panel">▁</button>
      <button id="btn-close" title="ปิด">✕</button>
    </div>
    <div class="panel-main">
      <div class="modebar">
        <button class="act on" id="mode-edit">✏️ โหมดแก้ไข</button>
        <button class="act" id="mode-action">🖱 โหมดใช้งาน</button>
      </div>
      <div class="tabs">
        <button class="tab on" data-tab="edit">แก้ไข</button>
        <button class="tab" data-tab="add">เพิ่ม</button>
        <button class="tab" data-tab="list">รายการ<span class="badge" id="tab-badge"></span></button>
        <button class="tab" data-tab="export">ส่งออก</button>
      </div>
      <div class="panel-body">
        <div class="restorebar" id="restorebar">
          <span id="restore-info"></span>
          <div class="btnrow">
            <button class="act primary" id="btn-restore">↻ กู้คืน</button>
            <button class="act danger" id="btn-discard">ทิ้ง</button>
          </div>
        </div>

        <!-- ── แท็บ: แก้ไข ── -->
        <div class="tabpane on" data-pane="edit">
          <div class="sel-info empty" id="sel-info">ยังไม่ได้เลือก element</div>
          <div class="crumbs" id="crumbs"></div>
          <div class="hint" id="edit-hint">
            <b>คลิก</b> element บนหน้าเว็บเพื่อเริ่มแก้ไข<br>
            ลากที่เลือกอยู่ = ย้ายตำแหน่ง · ดับเบิลคลิก = แก้ข้อความ<br>
            <b>Shift+ลากคลุม</b> = เลือกหลายชิ้นแล้วย้ายพร้อมกัน<br>
            <b>⌘Z</b> undo · <b>Delete</b> ซ่อน · <b>⌘C</b>/<b>⌘V</b> คัดลอก/วาง
          </div>

          <div id="group-tools" style="display:none">
            <div class="hint" id="group-info"></div>
            <div class="btnrow">
              <button class="act danger" id="btn-group-hide">🙈 ซ่อนทั้งกลุ่ม</button>
              <button class="act danger" id="btn-group-delete">🗑 ลบทั้งกลุ่ม</button>
            </div>
            <div class="btnrow">
              <button class="act" id="btn-group-clear">✕ ยกเลิกเลือกกลุ่ม (Esc)</button>
            </div>
          </div>

          <div id="inspector" style="display:none">
            <div class="qa">
              <button id="btn-text" title="แก้ข้อความ (หรือดับเบิลคลิกที่ element)"><span>✏️</span><small>ข้อความ</small></button>
              <button id="btn-up" title="ย้ายลำดับขึ้น"><span>⬆︎</span><small>ขึ้น</small></button>
              <button id="btn-down" title="ย้ายลำดับลง"><span>⬇︎</span><small>ลง</small></button>
              <button id="btn-copy" title="คัดลอก (⌘C)"><span>📄</span><small>คัดลอก</small></button>
              <button id="btn-duplicate" title="ทำซ้ำต่อท้ายทันที"><span>⧉</span><small>ทำซ้ำ</small></button>
              <button id="btn-hide" class="danger" title="ซ่อน (Delete)"><span>🙈</span><small>ซ่อน</small></button>
              <button id="btn-delete" class="danger" title="ลบจริง (Shift+Delete)"><span>🗑</span><small>ลบ</small></button>
              <button id="btn-reset" title="รีเซ็ต element นี้กลับค่าเดิม"><span>♻️</span><small>รีเซ็ต</small></button>
            </div>

            <div class="imgrow" id="img-tools">
              <details class="sec" open>
                <summary>รูปภาพ</summary>
                <div class="secbody">
                  <input type="text" class="wide" id="in-imgurl" placeholder="วาง URL รูปใหม่ แล้วกด Enter">
                  <label class="filelabel">📁 เลือกรูปจากเครื่อง<input type="file" id="in-imgfile" accept="image/*"></label>
                </div>
              </details>
            </div>

            <div class="imgrow" id="modal-tools">
              <details class="sec" open>
                <summary>Modal นี้</summary>
                <div class="secbody">
                  <div class="btnrow">
                    <button class="act" id="btn-modal-hide">🙈 ซ่อน modal (สถานะเริ่มต้นของหน้า)</button>
                  </div>
                  <div class="hint">แก้ข้อความ/สีได้เหมือน element ทั่วไป · ซ่อนแล้วไปเลือกปุ่มที่จะผูกในหมวด "ผูก Modal"</div>
                </div>
              </details>
            </div>

            <div class="imgrow" id="col-tools">
              <details class="sec" open>
                <summary>คอลัมน์ตาราง</summary>
                <div class="secbody">
                  <div class="btnrow">
                    <button class="act" id="btn-col-left">⬅ ย้ายซ้าย</button>
                    <button class="act" id="btn-col-right">➡ ย้ายขวา</button>
                  </div>
                </div>
              </details>
            </div>

            <details class="sec" open>
              <summary>สี & ตัวอักษร</summary>
              <div class="secbody">
                <div class="row"><label>สีพื้นหลัง</label><input type="color" id="in-bg"></div>
                <div class="row"><label>สีตัวอักษร</label><input type="color" id="in-color"></div>
                <div class="row"><label>ขนาดฟอนต์ (px)</label><input type="number" id="in-fontsize" min="6" max="200"></div>
                <div class="row">
                  <label>ตัวหนา / จัดชิด</label>
                  <button class="mini" id="in-bold"><b>B</b></button>
                  <button class="mini" id="in-al" title="ชิดซ้าย">⯇</button>
                  <button class="mini" id="in-ac" title="กึ่งกลาง">≡</button>
                  <button class="mini" id="in-ar" title="ชิดขวา">⯈</button>
                </div>
              </div>
            </details>

            <details class="sec">
              <summary>ขนาด & ระยะ</summary>
              <div class="secbody">
                <div class="row"><label>กว้าง</label><input type="text" id="in-width" placeholder="เช่น 300px / 50%"></div>
                <div class="row"><label>สูง</label><input type="text" id="in-height" placeholder="auto"></div>
                <div class="row"><label>Padding (px)</label><input type="number" id="in-padding" min="0" max="300"></div>
                <div class="row"><label>Margin (px) บน/ขวา/ล่าง/ซ้าย</label></div>
                <div class="row marginrow">
                  <input type="number" id="in-mt" title="บน" placeholder="บน">
                  <input type="number" id="in-mr" title="ขวา" placeholder="ขวา">
                  <input type="number" id="in-mb" title="ล่าง" placeholder="ล่าง">
                  <input type="number" id="in-ml" title="ซ้าย" placeholder="ซ้าย">
                </div>
              </div>
            </details>

            <details class="sec">
              <summary>เส้นขอบ & เอฟเฟกต์</summary>
              <div class="secbody">
                <div class="row"><label>มุมโค้ง (px)</label><input type="number" id="in-radius" min="0" max="500"></div>
                <div class="row"><label>เส้นขอบ (px)</label><input type="number" id="in-borderw" min="0" max="50" style="width:52px"><input type="color" id="in-borderc"></div>
                <div class="row"><label>เงา</label>
                  <select id="in-shadow">
                    <option value="none">ไม่มี</option>
                    <option value="0 2px 8px rgba(0,0,0,.15)">เบา</option>
                    <option value="0 6px 20px rgba(0,0,0,.25)">กลาง</option>
                    <option value="0 14px 40px rgba(0,0,0,.35)">หนัก</option>
                  </select>
                </div>
                <div class="row"><label>ความทึบ (%)</label><input type="range" id="in-opacity" min="10" max="100" value="100"></div>
              </div>
            </details>

            <details class="sec">
              <summary>Layout / Grid</summary>
              <div class="secbody">
                <div class="row"><label>โหมดจัดวาง</label>
                  <select id="in-display">
                    <option value="">— เดิม —</option>
                    <option value="block">Block</option>
                    <option value="flex-row">Flex แถว</option>
                    <option value="flex-col">Flex คอลัมน์</option>
                    <option value="grid">Grid</option>
                  </select>
                </div>
                <div class="row"><label>จำนวนคอลัมน์ (grid)</label><input type="number" id="in-cols" min="1" max="12" value="3"></div>
                <div class="row"><label>ระยะห่างช่อง Gap (px)</label><input type="number" id="in-gap" min="0" max="120"></div>
              </div>
            </details>

            <details class="sec">
              <summary>CSS กำหนดเอง</summary>
              <div class="secbody">
                <textarea id="in-css" rows="4" spellcheck="false" placeholder="พิมพ์ CSS ตรง ๆ เช่น&#10;background: #1e293b;&#10;transform: rotate(2deg);"></textarea>
                <div class="btnrow" style="margin-top:6px">
                  <button class="act primary" id="btn-apply-css">✨ ใช้ CSS นี้</button>
                </div>
              </div>
            </details>

            <details class="sec" id="bind-tools">
              <summary>ผูก Modal (คลิกแล้วเปิด)</summary>
              <div class="secbody">
                <div class="hint" id="bind-none">ยังไม่มี modal ในหน้า — เพิ่มได้ที่แท็บ "เพิ่ม" (ปุ่ม 🪟 Modal)</div>
                <div id="bind-row">
                  <div class="row">
                    <label>เลือก modal</label>
                    <select id="in-modal-sel"></select>
                    <button class="mini" id="btn-modal-open" title="เปิด modal นี้ขึ้นมาดู/แก้">👁</button>
                  </div>
                  <div class="btnrow">
                    <button class="act primary" id="btn-bind-modal">🔗 ผูกกับ element นี้</button>
                    <button class="act danger" id="btn-unbind-modal" style="display:none">✕ ยกเลิกผูก</button>
                  </div>
                  <div class="hint">ผูกแล้วไปลองคลิกใน "โหมดใช้งาน" ได้เลย · HTML ที่ export ไปก็คลิกเปิดได้จริง</div>
                </div>
              </div>
            </details>
          </div>
        </div>

        <!-- ── แท็บ: เพิ่ม ── -->
        <div class="tabpane" data-pane="add">
          <div class="hint">วางต่อจาก element ที่เลือกอยู่ · ไม่ได้เลือก = ต่อท้ายหน้า<br>เส้นประของกล่อง/section ใหม่เป็นแค่ไกด์ตอนแก้ — โหมดใช้งาน/ส่งออก/screenshot จะไม่มี</div>
          <h4>Element</h4>
          <div class="qa qa3">
            <button id="btn-add-box" title="กล่องเปล่า ลาก element อื่นยัดเข้าไปได้"><span>🔲</span><small>กล่อง</small></button>
            <button id="btn-add-img" title="รูป placeholder เลือกแล้วเปลี่ยน URL/ไฟล์"><span>🖼️</span><small>รูปภาพ</small></button>
            <button id="btn-add-btn" title="ปุ่มใหม่"><span>🔘</span><small>ปุ่ม</small></button>
            <button id="btn-add-head" title="หัวข้อใหม่"><span>𝗛</span><small>หัวข้อ</small></button>
            <button id="btn-add-text" title="ย่อหน้าข้อความ"><span>¶</span><small>ข้อความ</small></button>
            <button id="btn-add-modal" title="กล่อง modal ลอยกลางจอ — ผูกกับปุ่มให้คลิกเปิดได้"><span>🪟</span><small>Modal</small></button>
            <button id="btn-paste" title="วาง element ที่คัดลอกไว้ (⌘V)"><span>📋</span><small>วาง ⌘V</small></button>
          </div>
          <h4>Section</h4>
          <div class="btnrow">
            <button class="act" id="btn-add-before">➕ ก่อนที่เลือก</button>
            <button class="act" id="btn-add-after">➕ หลังที่เลือก</button>
          </div>
          <div class="btnrow">
            <button class="act" id="btn-add-end">➕ ต่อท้ายหน้า</button>
          </div>
          <h4>คลัง Asset (ใช้ข้ามหน้าได้)</h4>
          <div class="btnrow">
            <button class="act" id="btn-asset-save">📦 เก็บ element ที่เลือกเข้าคลัง</button>
          </div>
          <div class="changelist" id="assetlist"><div class="hint">คลังยังว่าง</div></div>
        </div>

        <!-- ── แท็บ: รายการแก้ไข ── -->
        <div class="tabpane" data-pane="list">
          <h4 style="margin-top:2px">รายการแก้ไข</h4>
          <div class="changelist tall" id="changelist"><div class="hint">ยังไม่มีการแก้ไข</div></div>
          <div class="btnrow" style="margin-top:10px">
            <button class="act danger" id="btn-reset-all">♻️ รีเซ็ตทั้งหน้า</button>
          </div>
        </div>

        <!-- ── แท็บ: ส่งออก ── -->
        <div class="tabpane" data-pane="export">
          <h4 style="margin-top:2px">รายงานส่งให้ Dev</h4>
          <div class="btnrow">
            <button class="act primary" id="btn-export-json">📋 รายงาน JSON</button>
          </div>
          <div class="btnrow">
            <button class="act" id="btn-export-css">🎨 CSS</button>
            <button class="act" id="btn-export-html">🧾 HTML</button>
          </div>
          <h4>Screenshot</h4>
          <div class="btnrow">
            <button class="act" id="btn-export-shot">📸 จอ</button>
            <button class="act" id="btn-export-shot-el">📸 ที่เลือก</button>
            <button class="act" id="btn-export-shot-full">📸 ทั้งหน้า</button>
          </div>
          <h4>ขนาดจอ (ทดสอบ Responsive)</h4>
          <div class="btnrow">
            <button class="act" id="btn-vp-390">📱 390</button>
            <button class="act" id="btn-vp-768">📱 768</button>
            <button class="act" id="btn-vp-1280">💻 1280</button>
            <button class="act" id="btn-vp-restore">↩︎ คืน</button>
          </div>
          <h4>Import</h4>
          <label class="filelabel">📥 Import รายงาน JSON กลับมาแก้ต่อ<input type="file" id="in-import" accept=".json,application/json"></label>
        </div>

        <div class="counter" id="counter">ยังไม่มีการแก้ไข</div>
      </div>
    </div>
  </div>

  <div class="toast"></div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const ui = {
    hoverbox: $(".hoverbox"),
    selectbox: $(".selectbox"),
    dropline: $(".dropline"),
    marquee: $(".marquee"),
    multiboxes: $(".multiboxes"),
    seltag: $(".selectbox .tag"),
    panel: $(".panel"),
    selinfo: $("#sel-info"),
    inspector: $("#inspector"),
    imgtools: $("#img-tools"),
    toast: $(".toast"),
    counter: $("#counter"),
  };

  // ---------------------------------------------------------------
  // highlight boxes
  // ---------------------------------------------------------------
  function placeBox(box, el) {
    if (!el || !el.isConnected) { box.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }
  function refreshBoxes() {
    placeBox(ui.selectbox, state.selected);
    if (state.selected) ui.seltag.textContent = shortLabel(state.selected);
    if (state.multi.length > 1) drawMultiBoxes();
  }

  // ---------------------------------------------------------------
  // selection & inspector
  // ---------------------------------------------------------------
  function isOurUI(target, ev) {
    if (ev && ev.composedPath) return ev.composedPath().includes(host);
    return host.contains(target);
  }

  function select(el) {
    if (state.editingText) stopTextEdit();
    if (state.multi.length) { state.multi = []; clearMultiUI(); }
    state.selected = el;
    ui.hoverbox.style.display = "none";
    refreshBoxes();
    renderCrumbs(el);
    const hint = $("#edit-hint");
    if (el) {
      ui.selinfo.classList.remove("empty");
      ui.selinfo.textContent = cssPath(el);
      ui.inspector.style.display = "block";
      if (hint) hint.style.display = "none";
      populateInspector(el);
    } else {
      ui.selinfo.classList.add("empty");
      ui.selinfo.textContent = "ยังไม่ได้เลือก element";
      ui.inspector.style.display = "none";
      if (hint) hint.style.display = "block";
    }
  }

  // ---------------------------------------------------------------
  // multi-select: Shift+ลากคลุม / Shift+คลิก เลือกหลายชิ้น
  // ---------------------------------------------------------------
  function clearMultiUI() {
    ui.multiboxes.innerHTML = "";
    $("#group-tools").style.display = "none";
  }

  function drawMultiBoxes() {
    ui.multiboxes.innerHTML = "";
    for (const el of state.multi) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const b = document.createElement("div");
      b.className = "mbox";
      b.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px;`;
      ui.multiboxes.appendChild(b);
    }
  }

  // ตัด element ซ้ำ/ซ้อนกันออก (เก็บเฉพาะตัวนอกสุด)
  function normalizeMembers(list) {
    const uniq = [...new Set(list)].filter(
      (el) => el && el.isConnected && el !== document.body && el !== document.documentElement && !host.contains(el)
    );
    return uniq.filter((el) => !uniq.some((o) => o !== el && o.contains(el)));
  }

  function setMulti(els) {
    els = normalizeMembers(els);
    if (els.length <= 1) {
      state.multi = [];
      clearMultiUI();
      select(els[0] || null);
      return;
    }
    if (state.editingText) stopTextEdit();
    state.selected = null;
    state.multi = els;
    ui.selectbox.style.display = "none";
    ui.hoverbox.style.display = "none";
    renderCrumbs(null);
    ui.selinfo.classList.remove("empty");
    ui.selinfo.textContent = `เลือกอยู่ ${els.length} ชิ้น (กลุ่ม)`;
    ui.inspector.style.display = "none";
    $("#edit-hint").style.display = "none";
    $("#group-tools").style.display = "block";
    $("#group-info").innerHTML =
      `ลากชิ้นไหนก็ได้ในกลุ่ม = <b>ย้ายทั้ง ${els.length} ชิ้นพร้อมกัน</b><br>` +
      `Shift+คลิก = เพิ่ม/เอาออก · <b>Delete</b> = ซ่อนทั้งกลุ่ม`;
    drawMultiBoxes();
    setTab("edit");
  }

  // หา element ที่อยู่ในกรอบคลุมทั้งชิ้น (เก็บตัวนอกสุด ไม่เจาะลงลูก)
  function marqueePick(rect) {
    const out = [];
    const inside = (r) =>
      r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom;
    const overlaps = (r) =>
      !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
    const walk = (el) => {
      for (const c of el.children) {
        if (c === host) continue;
        const r = c.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (inside(r)) out.push(c);
        else if (overlaps(r)) walk(c);
      }
    };
    walk(document.body);
    return out;
  }

  function toggleMulti(target) {
    if (!target || target === document.body || target === document.documentElement) return;
    let list = state.multi.length > 1 ? [...state.multi] : state.selected ? [state.selected] : [];
    const hit = list.find((m) => m === target || m.contains(target));
    if (hit) list = list.filter((m) => m !== hit);
    else list.push(target);
    setMulti(list);
    if (list.length > 1) toast(`เลือกอยู่ ${list.length} ชิ้น`);
  }

  // breadcrumb ไต่ขึ้นไปเลือก element แม่ได้
  function renderCrumbs(el) {
    const c = $("#crumbs");
    c.innerHTML = "";
    if (!el) { c.classList.remove("show"); return; }
    const chain = [];
    let n = el;
    while (n && n.tagName !== "HTML") { chain.unshift(n); n = n.parentElement; }
    for (const node of chain.slice(-6)) {
      const b = document.createElement("button");
      b.textContent = shortLabel(node);
      b.title = node === el ? "element ที่เลือกอยู่" : "คลิกเพื่อเลือกตัวแม่";
      if (node === el) b.classList.add("cur");
      b.addEventListener("click", () => select(node));
      c.appendChild(b);
      if (node !== el) c.appendChild(document.createTextNode("›"));
    }
    c.classList.add("show");
  }

  function populateInspector(el) {
    const cs = getComputedStyle(el);
    $("#in-bg").value = rgbToHex(cs.backgroundColor);
    $("#in-color").value = rgbToHex(cs.color);
    $("#in-fontsize").value = parseInt(cs.fontSize) || "";
    $("#in-radius").value = parseInt(cs.borderRadius) || 0;
    $("#in-padding").value = parseInt(cs.paddingTop) || 0;
    $("#in-width").value = "";
    $("#in-height").value = "";
    $("#in-bold").classList.toggle("on", parseInt(cs.fontWeight) >= 600);
    $("#in-mt").value = parseInt(cs.marginTop) || 0;
    $("#in-mr").value = parseInt(cs.marginRight) || 0;
    $("#in-mb").value = parseInt(cs.marginBottom) || 0;
    $("#in-ml").value = parseInt(cs.marginLeft) || 0;
    const disp = cs.display;
    $("#in-display").value =
      disp.includes("grid") ? "grid"
      : disp.includes("flex") ? (cs.flexDirection.startsWith("column") ? "flex-col" : "flex-row")
      : disp === "block" ? "block" : "";
    if (disp.includes("grid")) {
      const nCols = cs.gridTemplateColumns.split(" ").filter(Boolean).length;
      if (nCols) $("#in-cols").value = nCols;
    }
    $("#in-gap").value = parseInt(cs.gap) || 0;
    const rec = state.changes.get(el);
    $("#in-css").value = rec && Object.keys(rec.styles).length
      ? Object.entries(rec.styles).map(([p, v]) => `${p}: ${v.to};`).join("\n")
      : "";
    $("#in-borderw").value = parseInt(cs.borderTopWidth) || 0;
    $("#in-borderc").value = rgbToHex(cs.borderTopColor);
    $("#in-shadow").value = [...$("#in-shadow").options].some((o) => o.value === cs.boxShadow) ? cs.boxShadow : "none";
    $("#in-opacity").value = Math.round(parseFloat(cs.opacity) * 100) || 100;
    const isImg = el.tagName === "IMG";
    ui.imgtools.classList.toggle("show", isImg);
    $("#col-tools").classList.toggle("show", !!(el.closest && el.closest("td, th")));
    $("#in-imgurl").value = "";
    // เครื่องมือ modal + หมวดผูก modal
    $("#modal-tools").classList.toggle("show", !!(el.closest && el.closest("[data-rl-modal]")));
    const modals = Array.from(document.querySelectorAll("[data-rl-modal]"));
    const msel = $("#in-modal-sel");
    msel.innerHTML = "";
    for (const m of modals) {
      const o = document.createElement("option");
      o.value = m.getAttribute("data-rl-modal");
      const h = m.querySelector("h1,h2,h3,h4");
      o.textContent = h && h.textContent.trim() ? h.textContent.trim().slice(0, 26) : o.value;
      msel.appendChild(o);
    }
    $("#bind-none").style.display = modals.length ? "none" : "";
    $("#bind-row").style.display = modals.length ? "" : "none";
    const bound = el.getAttribute && el.getAttribute("data-rl-opens-modal");
    if (bound) msel.value = bound;
    $("#btn-unbind-modal").style.display = bound ? "" : "none";
  }

  function updateCounter() {
    const n = state.changes.size + state.addedSections.length;
    ui.counter.textContent = n
      ? `แก้ไขแล้ว ${state.changes.size} element · เพิ่มใหม่ ${state.addedSections.length} รายการ`
      : "ยังไม่มีการแก้ไข";
    const badge = $("#tab-badge");
    if (badge) {
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.classList.toggle("show", n > 0);
    }
    refreshChangeList();
  }
  function updateUndoButton() {
    $("#btn-undo").disabled = state.undoStack.length === 0;
    $("#btn-redo").disabled = state.redoStack.length === 0;
  }

  // (เติม logic จริงในส่วน persistence / changes list ด้านล่าง)
  let scheduleSaveImpl = null;
  function scheduleSave() { if (scheduleSaveImpl) scheduleSaveImpl(); }
  let refreshChangeListImpl = null;
  function refreshChangeList() { if (refreshChangeListImpl) refreshChangeListImpl(); }

  // ---------------------------------------------------------------
  // text editing
  // ---------------------------------------------------------------
  function startTextEdit(el) {
    if (!el) return;
    state.editingText = true;
    el._rlTextBefore = el.innerHTML;
    el.setAttribute("contenteditable", "plaintext-only");
    el.focus();
    $("#btn-text").innerHTML = "<span>✅</span><small>เสร็จสิ้น</small>";
    toast("พิมพ์แก้ข้อความได้เลย เสร็จแล้วกด Esc");
  }
  function stopTextEdit() {
    const el = state.selected;
    state.editingText = false;
    $("#btn-text").innerHTML = "<span>✏️</span><small>ข้อความ</small>";
    if (!el) return;
    el.removeAttribute("contenteditable");
    const before = el._rlTextBefore;
    if (before !== undefined && before !== el.innerHTML) {
      const rec = getRecord(el);
      if (!rec.text) rec.text = { from: el._rlTextBefore0 ?? before, to: el.innerHTML };
      else rec.text.to = el.innerHTML;
      if (el._rlTextBefore0 === undefined) el._rlTextBefore0 = before;
      const after = el.innerHTML;
      pushUndo(`แก้ข้อความใน ${shortLabel(el)}`, () => {
        el.innerHTML = before;
        rec.text.to = before;
        refreshBoxes();
      }, () => {
        el.innerHTML = after;
        rec.text.to = after;
        refreshBoxes();
      });
      updateCounter();
    }
    delete el._rlTextBefore;
  }

  // ---------------------------------------------------------------
  // drag / move — ลากเป็น block แล้ววางเข้าตำแหน่งใน DOM จริง
  // (มีเส้นม่วงบอกจุดที่จะวาง ก่อน/หลัง element ปลายทาง)
  // ---------------------------------------------------------------
  let suppressClick = false; // กัน click ที่ตามหลังการลาก ไม่ให้เปลี่ยน selection

  // สร้าง ghost — สำเนา element ลอยตามเมาส์ระหว่างลาก (ตัวจริงจางอยู่ที่เดิม)
  function makeGhost(d, e) {
    const r = d.el.getBoundingClientRect();
    const g = d.el.cloneNode(true);
    // ย่อ ghost ถ้า element ใหญ่มาก จะได้ไม่บังจอ
    d.ghostScale = Math.min(1, 420 / Math.max(1, r.width), 320 / Math.max(1, r.height));
    d.ghostOffX = e.clientX - r.left;
    d.ghostOffY = e.clientY - r.top;
    g.setAttribute("data-rl-ghost", "");
    g.style.cssText +=
      `;position:fixed !important; left:0; top:0; width:${r.width}px !important; height:${r.height}px !important;` +
      `margin:0 !important; z-index:2147483645 !important; pointer-events:none !important; opacity:.85 !important;` +
      `transform-origin:0 0; box-shadow:0 14px 36px rgba(0,0,0,.35) !important; outline:2px solid #7c3aed;` +
      `transition:none !important; overflow:hidden;`;
    // ลากทั้งกลุ่ม: ติดป้ายจำนวนชิ้นบน ghost
    if (d.members && d.members.length > 1) {
      const badge = document.createElement("div");
      badge.textContent = "× " + d.members.length;
      badge.style.cssText =
        "position:absolute; top:6px; right:6px; background:#7c3aed; color:#fff;" +
        "font:700 12px/1.4 sans-serif; padding:2px 9px; border-radius:11px; z-index:9;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.3);";
      g.appendChild(badge);
    }
    d.ghost = g;
    document.body.appendChild(g);
    d.prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.setProperty("cursor", "grabbing", "important");
    moveGhost(d, e);
  }

  function moveGhost(d, e) {
    const g = d.ghost;
    if (!g) return;
    g.style.left = e.clientX - d.ghostOffX * d.ghostScale + "px";
    g.style.top = e.clientY - d.ghostOffY * d.ghostScale + "px";
    g.style.transform = `scale(${d.ghostScale}) rotate(1.2deg)`;
  }

  function removeGhost(d) {
    if (d.ghost) { d.ghost.remove(); d.ghost = null; }
    if (d.prevCursor) document.documentElement.style.cursor = d.prevCursor;
    else document.documentElement.style.removeProperty("cursor");
  }

  // element ปลายทางอยู่แถวเดียวกับพี่น้องไหม (ใช้ตัดสินว่าเส้นวางแนวตั้งหรือแนวนอน)
  function isHorizontalFlow(target) {
    const parent = target.parentElement;
    if (!parent) return false;
    const r = target.getBoundingClientRect();
    for (const s of parent.children) {
      if (s === target || s === host) continue;
      const sr = s.getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      if (Math.abs(sr.top - r.top) < Math.min(r.height, sr.height) * 0.5) return true;
    }
    return false;
  }

  // tag ที่วาง element "เข้าไปข้างใน" ได้
  const CONTAINER_TAGS = new Set([
    "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV",
    "UL", "OL", "LI", "FORM", "FIGURE", "FIELDSET", "TD", "TH", "DETAILS",
  ]);

  // เส้นบอกจุดแทรก ก่อน/หลัง element (side: left/right/top/bottom)
  function drawDropLine(rect, side) {
    const L = ui.dropline.style;
    L.display = "block";
    L.background = "#7c3aed";
    L.outline = "none";
    if (side === "left" || side === "right") {
      L.left = (side === "left" ? rect.left : rect.right) - 2 + "px";
      L.top = rect.top + "px";
      L.width = "4px";
      L.height = rect.height + "px";
    } else {
      L.left = rect.left + "px";
      L.top = (side === "top" ? rect.top : rect.bottom) - 2 + "px";
      L.width = rect.width + "px";
      L.height = "4px";
    }
  }

  // กรอบคลุม container = จะวาง "เข้าไปข้างใน"
  function drawDropBox(rect) {
    const L = ui.dropline.style;
    L.display = "block";
    L.background = "rgba(124,58,237,.14)";
    L.outline = "2px dashed #7c3aed";
    L.left = rect.left + 2 + "px";
    L.top = rect.top + 2 + "px";
    L.width = Math.max(0, rect.width - 4) + "px";
    L.height = Math.max(0, rect.height - 4) + "px";
  }

  // หา element ปลายทางใต้เมาส์ + คำนวณจุดวาง แล้ววาด indicator
  function updateDropTarget(e) {
    const d = state.dragging;
    d.drop = null;
    ui.dropline.style.display = "none";

    const prevPE = d.members.map((m) => m.style.pointerEvents);
    d.members.forEach((m) => m.style.setProperty("pointer-events", "none", "important"));
    let target = document.elementFromPoint(e.clientX, e.clientY);
    d.members.forEach((m, i) => {
      if (prevPE[i]) m.style.setProperty("pointer-events", prevPE[i]);
      else m.style.removeProperty("pointer-events");
    });

    if (!target || isOurUI(target) || d.members.some((m) => m === target || m.contains(target))) return;
    if (target === document.documentElement || target === document.body) return;
    const parent = target.parentElement;
    if (!parent || d.members.some((m) => m === parent || m.contains(parent))) return;

    const r = target.getBoundingClientRect();
    const horizontal = isHorizontalFlow(target);

    // โซนกลางของ container = วาง "เข้าไปข้างใน" (ชิดขอบ = วางก่อน/หลังตามปกติ)
    if (CONTAINER_TAGS.has(target.tagName)) {
      const edge = Math.min((horizontal ? r.width : r.height) * 0.3, 36);
      const inCenter = horizontal
        ? e.clientX > r.left + edge && e.clientX < r.right - edge
        : e.clientY > r.top + edge && e.clientY < r.bottom - edge;
      const kids = Array.from(target.children).filter(
        (c) => !d.members.includes(c) && c !== host
      );
      // ต้องเป็นกล่องจริง ๆ (มีลูก หรือสูงพอ) กัน div ข้อความบรรทัดเดียวโดนยัดโดยไม่ตั้งใจ
      if (inCenter && (kids.length || r.height >= 60)) {
        // หาลูกที่ใกล้เมาส์ที่สุด เพื่อแทรกให้ตรงจุด — ไม่มีลูก = ต่อท้ายข้างใน
        let best = null, bestDist = Infinity;
        for (const c of kids) {
          const cr = c.getBoundingClientRect();
          if (!cr.width && !cr.height) continue;
          const dist = Math.hypot(
            e.clientX - (cr.left + cr.width / 2),
            e.clientY - (cr.top + cr.height / 2)
          );
          if (dist < bestDist) { bestDist = dist; best = { el: c, rect: cr }; }
        }
        if (!best) {
          d.drop = { parent: target, ref: null };
          drawDropBox(r);
        } else {
          const cr = best.rect;
          const dxN = (e.clientX - (cr.left + cr.width / 2)) / Math.max(1, cr.width);
          const dyN = (e.clientY - (cr.top + cr.height / 2)) / Math.max(1, cr.height);
          if (Math.abs(dxN) > Math.abs(dyN)) {
            d.drop = { parent: target, ref: dxN < 0 ? best.el : best.el.nextSibling };
            drawDropLine(cr, dxN < 0 ? "left" : "right");
          } else {
            d.drop = { parent: target, ref: dyN < 0 ? best.el : best.el.nextSibling };
            drawDropLine(cr, dyN < 0 ? "top" : "bottom");
          }
        }
        return;
      }
    }

    const before = horizontal
      ? e.clientX < r.left + r.width / 2
      : e.clientY < r.top + r.height / 2;
    d.drop = { parent, ref: before ? target : target.nextSibling };
    drawDropLine(r, horizontal ? (before ? "left" : "right") : (before ? "top" : "bottom"));
  }

  // sync ค่า movedTo จากตำแหน่งจริงปัจจุบัน (null ถ้ากลับมาอยู่ที่เดิม)
  function syncMovedTo(el, rec) {
    if (el.parentElement === rec.origParent && el.nextSibling === rec.origNext) {
      rec.movedTo = null;
      return;
    }
    rec.movedTo = {
      parent: cssPath(el.parentElement),
      before: el.nextElementSibling && el.nextElementSibling !== host
        ? cssPath(el.nextElementSibling)
        : null,
    };
  }

  function onMouseDown(e) {
    suppressClick = false; // เริ่ม interaction ใหม่ — click ที่จะตามมาไม่ใช่ click จากการลากรอบก่อน
    if (!state.enabled || state.mode !== "edit" || state.editingText || isOurUI(e.target, e)) return;
    if (e.button !== 0) return;
    // Shift+ลาก = คลุมเลือกหลายชิ้น (Shift+คลิกเฉย ๆ = เพิ่ม/เอาออกทีละชิ้น จัดการตอน mouseup)
    if (e.shiftKey) {
      state.marquee = { x0: e.clientX, y0: e.clientY, moved: false };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const el = e.target;
    // ลากชิ้นไหนก็ได้ในกลุ่มที่เลือกไว้ = ย้ายทั้งกลุ่ม / ลาก element เดี่ยวที่เลือกอยู่ = ย้ายตัวเดียว
    const member = state.multi.length > 1
      ? state.multi.find((m) => m === el || m.contains(el))
      : null;
    const single = el === state.selected && el !== document.body && el !== document.documentElement;
    if (member || single) {
      const members = member ? [...state.multi] : [el];
      state.dragging = {
        el: member || el,          // ตัวที่ใช้ทำ ghost
        members,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        prev: members.map((m) => ({
          el: m, parent: m.parentElement, next: m.nextSibling, opacity: m.style.opacity,
        })),
        drop: null, // { parent, ref }
      };
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onMouseMove(e) {
    if (!state.enabled || state.mode !== "edit") return;
    // กำลังลากกรอบคลุมเลือก
    const mq = state.marquee;
    if (mq) {
      if (!mq.moved && Math.hypot(e.clientX - mq.x0, e.clientY - mq.y0) > 4) mq.moved = true;
      if (mq.moved) {
        const L = ui.marquee.style;
        L.display = "block";
        L.left = Math.min(mq.x0, e.clientX) + "px";
        L.top = Math.min(mq.y0, e.clientY) + "px";
        L.width = Math.abs(e.clientX - mq.x0) + "px";
        L.height = Math.abs(e.clientY - mq.y0) + "px";
      }
      e.preventDefault();
      return;
    }
    const d = state.dragging;
    if (d) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        for (const p of d.prev) p.el.style.setProperty("opacity", "0.4", "important");
        makeGhost(d, e); // ยก element ขึ้นมาลอยตามเมาส์
      }
      if (d.moved) {
        moveGhost(d, e);
        updateDropTarget(e);
      }
      e.preventDefault();
      return;
    }
    if (state.editingText) return;
    // hover highlight
    if (isOurUI(e.target, e)) { ui.hoverbox.style.display = "none"; return; }
    if (e.target === state.selected) { ui.hoverbox.style.display = "none"; return; }
    placeBox(ui.hoverbox, e.target);
  }

  function onMouseUp(e) {
    // จบการคลุมเลือก
    const mq = state.marquee;
    if (mq) {
      state.marquee = null;
      ui.marquee.style.display = "none";
      suppressClick = true;
      if (!mq.moved) {
        // Shift+คลิกเฉย ๆ = เพิ่ม/เอาออกจากกลุ่ม
        if (!isOurUI(e.target, e)) toggleMulti(e.target);
      } else {
        const rect = {
          left: Math.min(mq.x0, e.clientX), right: Math.max(mq.x0, e.clientX),
          top: Math.min(mq.y0, e.clientY), bottom: Math.max(mq.y0, e.clientY),
        };
        const picked = marqueePick(rect);
        if (!picked.length) toast("ไม่มี element อยู่ในกรอบทั้งชิ้น — ลากคลุมให้ครอบทั้งตัว");
        else if (picked.length === 1) toast("คลุมได้ 1 ชิ้น — เลือกให้เหมือนคลิกปกติ");
        else toast(`คลุมได้ ${picked.length} ชิ้น — ลากชิ้นไหนก็ได้เพื่อย้ายทั้งกลุ่ม`);
        setMulti(picked);
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const d = state.dragging;
    if (!d) return;
    state.dragging = null;
    ui.dropline.style.display = "none";
    removeGhost(d);
    if (!d.moved) return; // เป็นแค่คลิกธรรมดา ปล่อยให้ click handler จัดการ

    for (const p of d.prev) {
      if (p.opacity) p.el.style.setProperty("opacity", p.opacity);
      else p.el.style.removeProperty("opacity");
    }
    suppressClick = true;

    // จุดวางถูกคำนวณตอน mousemove ครั้งสุดท้าย — บนเว็บ SPA หน้าอาจ render ทับ
    // ระหว่างลาก ทำให้ parent/ref หลุดจาก DOM แล้ว ต้องตรวจก่อน insert กัน NotFoundError
    let dropLost = false;
    if (d.drop && (!d.drop.parent || !d.drop.parent.isConnected)) {
      d.drop = null;
      dropLost = true;
    }
    if (d.drop) {
      const { parent } = d.drop;
      let ref = d.drop.ref;
      while (ref && d.members.includes(ref)) ref = ref.nextSibling; // จุดวางต้องไม่ใช่สมาชิกกลุ่มเอง
      if (ref && ref.parentNode !== parent) ref = null; // ref หลุดจาก parent ไปแล้ว = วางต่อท้ายแทน
      const single = d.members.length === 1;
      const samePos = single && parent === d.el.parentElement && (ref === d.el || ref === d.el.nextSibling);
      if (!samePos) {
        // เรียงสมาชิกตามลำดับใน DOM เดิม เพื่อคงลำดับไว้หลังวาง
        const ordered = [...d.members].sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        // สร้าง record ก่อนย้าย เพื่อให้ origParent/origNext เป็นตำแหน่งเดิมจริง
        const moves = ordered.map((el) => {
          const p = d.prev.find((x) => x.el === el);
          return { el, rec: getRecord(el), prevParent: p.parent, prevNext: p.next };
        });
        for (const m of moves) parent.insertBefore(m.el, ref);
        for (const m of moves) syncMovedTo(m.el, m.rec);
        const refNode = ref;
        pushUndo(single ? `ย้าย block ${shortLabel(d.el)}` : `ย้าย ${moves.length} ชิ้นพร้อมกัน`, () => {
          // คืนย้อนจากท้ายไปหน้า กันตำแหน่งอ้างอิงกันเอง (สมาชิกติดกัน)
          for (let i = moves.length - 1; i >= 0; i--)
            insertAt(moves[i].el, moves[i].prevParent, moves[i].prevNext);
          for (const m of moves) syncMovedTo(m.el, m.rec);
          refreshBoxes();
        }, () => {
          for (const m of moves) insertAt(m.el, parent, refNode);
          for (const m of moves) syncMovedTo(m.el, m.rec);
          refreshBoxes();
        });
        updateCounter();
        if (single) d.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        else toast(`↔ ย้าย ${moves.length} ชิ้นพร้อมกันแล้ว`);
      } else {
        toast("วางที่เดิม — ไม่มีอะไรเปลี่ยน");
      }
    } else {
      toast(dropLost
        ? "จุดวางหายไปจากหน้า (หน้าเว็บ render ใหม่ระหว่างลาก) — ลองลากอีกครั้ง"
        : "ไม่มีจุดวาง — ลากไปวางบน element อื่น (เส้นม่วง = จุดที่จะแทรก)");
    }
    refreshBoxes();
    e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e) {
    if (!state.enabled || isOurUI(e.target, e)) return;
    // โหมดใช้งาน: จัดการเปิด/ปิด modal ที่ผูกไว้ (สำรองกรณี CSP บล็อก inline onclick)
    if (state.mode === "action") {
      const t = e.target;
      const trigger = t.closest ? t.closest("[data-rl-opens-modal]") : null;
      if (trigger) {
        e.preventDefault();
        openModal(trigger.getAttribute("data-rl-opens-modal"));
        return;
      }
      const closer = t.closest ? t.closest("[data-rl-modal-close]") : null;
      if (closer) {
        e.preventDefault();
        const m = closer.closest("[data-rl-modal]");
        if (m) m.style.display = "none";
        return;
      }
      if (t.hasAttribute && t.hasAttribute("data-rl-modal")) t.style.display = "none"; // คลิกฉากหลัง = ปิด
      return;
    }
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (state.editingText) {
      // คลิกนอก element ที่กำลังแก้ = จบการแก้ข้อความ
      if (!state.selected.contains(e.target)) { stopTextEdit(); select(e.target); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    select(e.target);
    setTab("edit"); // เลือก element จากหน้า = พาไปแท็บแก้ไขเสมอ
  }

  function onDblClick(e) {
    if (!state.enabled || state.mode !== "edit" || isOurUI(e.target, e) || state.editingText) return;
    e.preventDefault();
    e.stopPropagation();
    select(e.target);
    startTextEdit(e.target);
  }

  function onKeyDown(e) {
    if (!state.enabled || state.mode !== "edit") return;
    if (e.key === "Escape") {
      if (isOurUI(e.target, e)) return; // กำลังพิมพ์ใน panel — ปล่อยตามปกติ
      if (state.editingText) { stopTextEdit(); refreshBoxes(); }
      else if (state.multi.length > 1) setMulti([]); // ยกเลิกกลุ่มก่อน
      else select(null);
      e.preventDefault();
      return;
    }
    if (state.editingText || isOurUI(e.target, e)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && state.multi.length > 1) {
      e.shiftKey ? groupDelete() : groupHide();
      e.preventDefault();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected) {
      e.shiftKey ? deleteSelected() : hideSelected(); // Shift+Delete = ลบจริง
      e.preventDefault();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.shiftKey ? doRedo() : doUndo();
      e.preventDefault();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
      doRedo();
      e.preventDefault();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && state.selected) {
      // ถ้าผู้ใช้ลากคลุมข้อความอยู่ ให้ copy ข้อความตามปกติ ไม่แย่ง
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { copySelected(); e.preventDefault(); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v" && state.clipboard) {
      pasteClipboard();
      e.preventDefault();
    }
  }

  // ---------------------------------------------------------------
  // mode: แก้ไข (cursor crosshair, คลิก = เลือก) / ใช้งานจริง (หน้าเว็บทำงานปกติ)
  // ---------------------------------------------------------------
  const modeStyle = document.createElement("style");
  modeStyle.id = "__relayout_mode_style";
  modeStyle.textContent =
    `html[data-rl-mode="edit"], html[data-rl-mode="edit"] *:not(#${HOST_ID}) { cursor: crosshair !important; }\n` +
    // เส้นประของ section/กล่องใหม่ = ไกด์ตอนแก้เท่านั้น ไม่ใช่สไตล์จริง
    // (โหมดใช้งาน / screenshot / export จะไม่มีเส้นประ และ inline style ของผู้ใช้ทับ background นี้ได้)
    `html[data-rl-mode="edit"] [data-rl-guide] { outline: 2px dashed rgba(124,58,237,.65); outline-offset: -2px; }\n` +
    `html[data-rl-mode="edit"] [data-rl-guide="section"] { background-color: rgba(124,58,237,.06); }`;

  function setMode(m) {
    state.mode = m;
    document.documentElement.setAttribute("data-rl-mode", m);
    $("#mode-edit").classList.toggle("on", m === "edit");
    $("#mode-action").classList.toggle("on", m === "action");
    ui.hoverbox.style.display = "none";
    if (m === "action" && state.editingText) stopTextEdit();
    toast(m === "edit"
      ? "✏️ โหมดแก้ไข — คลิกเพื่อเลือก element"
      : "🖱 โหมดใช้งาน — คลิกลิงก์/ปุ่มของหน้าได้ตามปกติ");
  }

  // ---------------------------------------------------------------
  // actions
  // ---------------------------------------------------------------
  function hideSelected() {
    const el = state.selected;
    if (!el) return;
    const rec = getRecord(el);
    const prev = el.style.display;
    el.style.setProperty("display", "none", "important");
    rec.hidden = true;
    el.setAttribute("data-rl-hidden", "");
    pushUndo(`ซ่อน ${shortLabel(el)}`, () => {
      if (prev) el.style.display = prev; else el.style.removeProperty("display");
      rec.hidden = false;
      el.removeAttribute("data-rl-hidden");
      refreshBoxes();
    }, () => {
      el.style.setProperty("display", "none", "important");
      rec.hidden = true;
      el.setAttribute("data-rl-hidden", "");
      if (state.selected === el) select(null);
      refreshBoxes();
    });
    select(null);
    updateCounter();
    toast("ซ่อน element แล้ว (กด ↩︎ เพื่อเอาคืน)");
  }

  // ลบจริง (เอาออกจาก DOM — ต่างจากซ่อนตรงที่รายงานจะบอก dev ว่า "เอาออกเลย")
  function deleteSelected() {
    const el = state.selected;
    if (!el) return;
    const parent = el.parentElement, next = el.nextSibling;
    if (el.hasAttribute("data-rl-added")) {
      // ของที่เพิ่มเอง: ลบ = ถอนออกจากรายการเพิ่ม ไม่ต้องมี change record
      const i = state.addedSections.findIndex((s) => s.el === el);
      const info = i >= 0 ? state.addedSections[i] : null;
      el.remove();
      if (i >= 0) state.addedSections.splice(i, 1);
      pushUndo(`ลบ ${shortLabel(el)}`, () => {
        insertAt(el, parent, next);
        if (info) state.addedSections.push(info);
        updateCounter();
      }, () => {
        el.remove();
        const j = info ? state.addedSections.indexOf(info) : -1;
        if (j >= 0) state.addedSections.splice(j, 1);
        if (state.selected === el) select(null);
        updateCounter();
      });
    } else {
      const rec = getRecord(el);
      el.remove();
      rec.deleted = true;
      pushUndo(`ลบ ${shortLabel(el)}`, () => {
        insertAt(el, parent, next);
        rec.deleted = false;
        refreshBoxes();
      }, () => {
        el.remove();
        rec.deleted = true;
        if (state.selected === el) select(null);
        refreshBoxes();
      });
    }
    select(null);
    updateCounter();
    toast("🗑 ลบ element แล้ว (↩︎ เอาคืนได้)");
  }

  // ซ่อนทั้งกลุ่มที่คลุมเลือกไว้ (undo เดียว)
  function groupHide() {
    const els = state.multi.filter((el) => el.isConnected);
    if (els.length < 2) return;
    const entries = els.map((el) => ({ el, rec: getRecord(el), prevDisplay: el.style.display }));
    const apply = () => {
      for (const en of entries) {
        en.el.style.setProperty("display", "none", "important");
        en.rec.hidden = true;
        en.el.setAttribute("data-rl-hidden", "");
      }
      refreshBoxes();
    };
    apply();
    pushUndo(`ซ่อน ${els.length} ชิ้น`, () => {
      for (const en of entries) {
        if (en.prevDisplay) en.el.style.display = en.prevDisplay;
        else en.el.style.removeProperty("display");
        en.rec.hidden = false;
        en.el.removeAttribute("data-rl-hidden");
      }
      refreshBoxes();
    }, apply);
    setMulti([]);
    updateCounter();
    toast(`🙈 ซ่อน ${els.length} ชิ้นแล้ว (↩︎ เอาคืนได้)`);
  }

  // ลบจริงทั้งกลุ่ม (undo เดียว)
  function groupDelete() {
    const els = state.multi.filter((el) => el.isConnected);
    if (els.length < 2) return;
    const entries = els.map((el) => {
      const added = el.hasAttribute("data-rl-added");
      const i = added ? state.addedSections.findIndex((s) => s.el === el) : -1;
      return {
        el,
        info: i >= 0 ? state.addedSections[i] : null,
        rec: added ? null : getRecord(el),
        parent: el.parentElement,
        next: el.nextSibling,
      };
    });
    const apply = () => {
      for (const en of entries) {
        en.el.remove();
        if (en.rec) en.rec.deleted = true;
        if (en.info) {
          const j = state.addedSections.indexOf(en.info);
          if (j >= 0) state.addedSections.splice(j, 1);
        }
      }
      updateCounter();
      refreshBoxes();
    };
    apply();
    pushUndo(`ลบ ${els.length} ชิ้น`, () => {
      // คืนจากท้ายไปหน้า กันตำแหน่งอ้างอิงกันเองเมื่อสมาชิกเป็นพี่น้องติดกัน
      for (let i = entries.length - 1; i >= 0; i--) {
        const en = entries[i];
        insertAt(en.el, en.parent, en.next);
        if (en.rec) en.rec.deleted = false;
        if (en.info) state.addedSections.push(en.info);
      }
      updateCounter();
      refreshBoxes();
    }, apply);
    setMulti([]);
    updateCounter();
    toast(`🗑 ลบ ${els.length} ชิ้นแล้ว (↩︎ เอาคืนได้)`);
  }

  // สลับคอลัมน์ตาราง — สลับ cell ลำดับ a กับ b (ติดกัน) ในทุกแถวของตาราง
  function swapAdjacentColumns(table, a, b) {
    for (const row of Array.from(table.rows)) {
      const ca = row.cells[a], cb = row.cells[b];
      if (!ca || !cb) continue;
      row.insertBefore(cb, ca);
    }
  }

  function moveColumn(dir) {
    const el = state.selected;
    const cell = el && el.closest ? el.closest("td, th") : null;
    const table = cell && cell.closest("table");
    if (!table) { toast("เลือกช่องในตาราง (td/th) ก่อน"); return; }
    for (const c of table.querySelectorAll("td, th")) {
      if (c.colSpan > 1 || c.rowSpan > 1) {
        toast("ตารางนี้มี colspan/rowspan — สลับคอลัมน์อัตโนมัติไม่ได้");
        return;
      }
    }
    const idx = cell.cellIndex;
    const to = idx + dir;
    if (to < 0 || to >= cell.parentElement.cells.length) { toast("สุดขอบตารางแล้ว"); return; }
    const a = Math.min(idx, to), b = Math.max(idx, to);
    const rec = getRecord(table);
    if (!rec.colSwaps) rec.colSwaps = [];
    swapAdjacentColumns(table, a, b);
    rec.colSwaps.push([a, b]);
    pushUndo(`สลับคอลัมน์ ${a + 1}↔${b + 1}`, () => {
      swapAdjacentColumns(table, a, b); // สลับซ้ำ = ย้อนกลับ
      rec.colSwaps.pop();
      refreshBoxes();
    }, () => {
      swapAdjacentColumns(table, a, b);
      rec.colSwaps.push([a, b]);
      refreshBoxes();
    });
    updateCounter();
    refreshBoxes();
    toast(`↔ สลับคอลัมน์ ${a + 1} กับ ${b + 1} แล้ว`);
  }

  // ทำซ้ำ element ที่เลือก (สำเนาวางต่อท้ายทันที)
  function duplicateSelected() {
    const el = state.selected;
    if (!el) { toast("เลือก element ที่จะทำซ้ำก่อน"); return; }
    if (!el.parentElement) { toast("element นี้หลุดจากหน้าไปแล้ว"); return; }
    state.seq += 1;
    const clone = cleanClone(el.cloneNode(true));
    clone.setAttribute("data-rl-added", "dup-" + state.seq);
    el.parentElement.insertBefore(clone, el.nextElementSibling);
    trackAdded(clone, "after", cssPath(el), `ทำซ้ำ ${shortLabel(el)}`);
    toast("⧉ ทำซ้ำแล้ว");
  }

  function moveInDom(dir) {
    const el = state.selected;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    if (!sib || host === sib) { toast("ย้ายต่อไม่ได้แล้ว"); return; }
    const anchor = dir < 0 ? sib : sib.nextElementSibling;
    const prevNext = el.nextElementSibling;
    const rec = getRecord(el); // สร้าง record ก่อนย้าย เพื่อเก็บตำแหน่งเดิมให้ถูก
    parent.insertBefore(el, anchor);
    rec.domMoved += 1;
    syncMovedTo(el, rec);
    const newNext = el.nextSibling;
    pushUndo(`ย้ายลำดับ ${shortLabel(el)}`, () => {
      insertAt(el, parent, prevNext);
      rec.domMoved -= 1;
      syncMovedTo(el, rec);
      refreshBoxes();
    }, () => {
      insertAt(el, parent, newNext);
      rec.domMoved += 1;
      syncMovedTo(el, rec);
      refreshBoxes();
    });
    updateCounter();
    refreshBoxes();
  }

  // คืน element หนึ่งตัวกลับสภาพเดิม (style / ข้อความ / รูป / ตำแหน่งใน DOM)
  function restoreElement(el, rec) {
    if (rec.colSwaps) {
      for (let i = rec.colSwaps.length - 1; i >= 0; i--)
        swapAdjacentColumns(el, rec.colSwaps[i][0], rec.colSwaps[i][1]); // สลับซ้ำย้อนลำดับ = คืนเดิม
    }
    for (const prop of Object.keys(rec.styles)) el.style.removeProperty(prop);
    el.style.removeProperty("transform");
    el.style.removeProperty("opacity");
    if (rec.text && rec.text.from !== undefined) el.innerHTML = rec.text.from;
    if (rec.image && el.tagName === "IMG") el.src = rec.image.from;
    if (rec.hidden) el.style.removeProperty("display");
    if (rec.opensModal) {
      el.removeAttribute("data-rl-opens-modal");
      if (rec.prevOnclick) el.setAttribute("onclick", rec.prevOnclick);
      else el.removeAttribute("onclick");
    }
    if (
      rec.origParent && rec.origParent.isConnected &&
      (el.parentElement !== rec.origParent || el.nextSibling !== rec.origNext)
    ) {
      const anchor =
        rec.origNext && rec.origNext.parentNode === rec.origParent ? rec.origNext : null;
      rec.origParent.insertBefore(el, anchor);
    }
    el.removeAttribute("data-rl-changed");
    el.removeAttribute("data-rl-hidden");
  }

  function resetSelected() {
    const el = state.selected;
    if (!el) return;
    const rec = state.changes.get(el);
    if (!rec) { toast("element นี้ยังไม่ได้แก้อะไร"); return; }
    restoreElement(el, rec);
    state.changes.delete(el);
    populateInspector(el);
    refreshBoxes();
    updateCounter();
    scheduleSave();
    toast("รีเซ็ต element กลับค่าเดิมแล้ว");
  }

  // รีเซ็ตทุกการแก้ไขทั้งหน้า กลับสภาพเดิม
  function resetAll() {
    const n = state.changes.size + state.addedSections.length;
    if (!n) { toast("ยังไม่มีการแก้ไขให้รีเซ็ต"); return; }
    if (!confirm(`รีเซ็ตการแก้ไขทั้งหมด (${state.changes.size} element, ${state.addedSections.length} section) กลับสภาพเดิมของหน้า?`)) return;
    if (state.editingText) stopTextEdit();
    select(null);
    for (const s of state.addedSections) s.el.remove();
    state.addedSections.length = 0;
    for (const [el, rec] of state.changes) {
      if (el.hasAttribute("data-rl-added")) continue; // section ที่เพิ่ม ถูกลบไปแล้ว
      restoreElement(el, rec);
    }
    state.changes.clear();
    state.undoStack.length = 0;
    state.redoStack.length = 0;
    updateUndoButton();
    updateCounter();
    refreshBoxes();
    scheduleSave(); // จะเคลียร์ draft ใน storage ให้ด้วย
    toast("♻️ รีเซ็ตทั้งหน้ากลับสภาพเดิมแล้ว");
  }

  function changeImage(src) {
    const el = state.selected;
    if (!el || el.tagName !== "IMG" || !src) return;
    const rec = getRecord(el);
    const prev = el.src;
    if (!rec.image) rec.image = { from: prev, to: src };
    else rec.image.to = src;
    el.src = src;
    el.removeAttribute("srcset");
    pushUndo(`เปลี่ยนรูป ${shortLabel(el)}`, () => {
      el.src = prev;
      rec.image.to = prev;
      refreshBoxes();
    }, () => {
      el.src = src;
      el.removeAttribute("srcset");
      rec.image.to = src;
      refreshBoxes();
    });
    updateCounter();
    refreshBoxes();
    toast("เปลี่ยนรูปแล้ว");
  }

  // ลงทะเบียน element ที่เพิ่มใหม่ (section / กล่อง / รูป / ที่วางจากคลิปบอร์ด) + undo
  function trackAdded(el, position, refSelector, label) {
    const info = { el, position, refSelector };
    state.addedSections.push(info);
    const parent = el.parentElement, next = el.nextSibling;
    pushUndo(label, () => {
      el.remove();
      const i = state.addedSections.indexOf(info);
      if (i >= 0) state.addedSections.splice(i, 1);
      if (state.selected === el) select(null);
      updateCounter();
    }, () => {
      insertAt(el, parent, next);
      state.addedSections.push(info);
      updateCounter();
    });
    select(el);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    updateCounter();
  }

  // แทรก element ใหม่: ต่อหลัง element ที่เลือกอยู่ ถ้าไม่ได้เลือกอะไร = ต่อท้ายหน้า
  function insertNew(el, label) {
    const ref = state.selected;
    if (ref && ref.parentElement) {
      ref.parentElement.insertBefore(el, ref.nextElementSibling);
      trackAdded(el, "after", cssPath(ref), label);
    } else {
      document.body.appendChild(el);
      trackAdded(el, "end", "body", label);
    }
  }

  function addSection(position) {
    // position: 'before' | 'after' | 'end'
    const ref = state.selected;
    if ((position === "before" || position === "after") && (!ref || !ref.parentElement)) {
      toast(ref ? "element ที่เลือกหลุดจากหน้าไปแล้ว" : "เลือก element ก่อน แล้วค่อยเพิ่ม section");
      return;
    }
    state.seq += 1;
    const sec = document.createElement("div");
    sec.setAttribute("data-rl-added", "section-" + state.seq);
    sec.setAttribute("data-rl-guide", "section"); // เส้นประ+พื้นจาง เห็นเฉพาะโหมดแก้ไข
    sec.style.cssText =
      "padding:32px 24px; margin:16px; border-radius:12px;" +
      "text-align:center; color:#5b21b6; font-family:inherit;";
    sec.innerHTML =
      `<div style="font-size:18px;font-weight:700;margin-bottom:6px;">Section ใหม่ #${state.seq}</div>` +
      `<div style="font-size:13px;opacity:.8;">ดับเบิลคลิกเพื่อแก้ข้อความ · คลิกเลือกแล้วปรับสี/ขนาด/ลากย้ายได้</div>`;

    let refSelector = "body";
    if (position === "before") { ref.parentElement.insertBefore(sec, ref); refSelector = cssPath(ref); }
    else if (position === "after") { ref.parentElement.insertBefore(sec, ref.nextElementSibling); refSelector = cssPath(ref); }
    else document.body.appendChild(sec);

    trackAdded(sec, position, refSelector, `เพิ่ม section #${state.seq}`);
  }

  // เพิ่มกล่องเปล่า
  function addBox() {
    state.seq += 1;
    const box = document.createElement("div");
    box.setAttribute("data-rl-added", "box-" + state.seq);
    box.setAttribute("data-rl-guide", ""); // เส้นประเห็นเฉพาะโหมดแก้ไข
    box.style.cssText =
      "min-height:120px; padding:16px; margin:12px;" +
      "border-radius:10px; background:#f8fafc; color:#64748b; font-size:13px; font-family:inherit;";
    box.innerHTML = `กล่องใหม่ #${state.seq} — ดับเบิลคลิกแก้ข้อความ · ปรับสี/ขนาด · ลากย้ายได้`;
    insertNew(box, `เพิ่มกล่อง #${state.seq}`);
    toast("เพิ่มกล่องแล้ว 🔲");
  }

  // เพิ่มรูป placeholder (เลือกแล้วเปลี่ยน URL / ไฟล์ได้จากเครื่องมือรูป)
  function addImage() {
    state.seq += 1;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">` +
      `<rect width="100%" height="100%" fill="#e2e8f0"/>` +
      `<circle cx="180" cy="110" r="34" fill="#94a3b8"/>` +
      `<path d="M80 220 L180 140 L260 200 L320 160 L400 220 Z" fill="#94a3b8"/>` +
      `<text x="240" y="250" font-family="sans-serif" font-size="16" fill="#475569" text-anchor="middle">รูปใหม่ — เลือกรูปนี้แล้ววาง URL หรือเลือกไฟล์จากเครื่อง</text>` +
      `</svg>`;
    const img = document.createElement("img");
    img.setAttribute("data-rl-added", "img-" + state.seq);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    img.alt = "รูปใหม่ #" + state.seq;
    img.style.cssText = "display:block; max-width:100%; margin:12px auto; border-radius:8px;";
    insertNew(img, `เพิ่มรูป #${state.seq}`);
    toast("เพิ่มรูปแล้ว 🖼️ — เลือกรูปเพื่อเปลี่ยน URL/ไฟล์");
  }

  // ---------------------------------------------------------------
  // modal: สร้าง + ผูกกับปุ่ม (คลิกเปิดในโหมดใช้งาน และใน HTML ที่ export)
  // ---------------------------------------------------------------
  // inline onclick ทำให้ HTML ที่ export ไปทำงานได้เอง / delegated handler ใน
  // editor (onClick โหมดใช้งาน) เป็นตัวสำรองบนเว็บที่ CSP บล็อก inline script
  function bindOnclickStr(id) {
    return `var m=document.querySelector('[data-rl-modal="${id}"]');if(m)m.style.display='flex';return false;`;
  }

  function openModal(id) {
    const m = document.querySelector(`[data-rl-modal="${id}"]`);
    if (m) m.style.display = "flex";
    return m;
  }

  function addModal() {
    state.seq += 1;
    const id = "m" + Date.now().toString(36) + state.seq; // กันชนกับ modal จาก draft เก่า
    const overlay = document.createElement("div");
    overlay.setAttribute("data-rl-added", "modal-" + state.seq);
    overlay.setAttribute("data-rl-modal", id);
    overlay.setAttribute("onclick", "if(event.target===this)this.style.display='none'");
    overlay.style.cssText =
      "display:flex; position:fixed; inset:0; background:rgba(15,23,42,.55); z-index:2147483000;" +
      "align-items:center; justify-content:center; font-family:inherit;";
    overlay.innerHTML =
      `<div style="background:#fff; border-radius:14px; padding:28px 32px; max-width:420px; width:90%;` +
      ` box-shadow:0 24px 80px rgba(0,0,0,.35); position:relative; color:#1f2937;">` +
      `<button data-rl-modal-close onclick="this.closest('[data-rl-modal]').style.display='none';return false"` +
      ` style="position:absolute; top:10px; right:12px; border:0; background:none; font-size:20px; cursor:pointer; color:#94a3b8;">✕</button>` +
      `<h3 style="margin:0 0 10px; font-size:20px;">Modal ใหม่ #${state.seq}</h3>` +
      `<p style="margin:0 0 18px; line-height:1.65; color:#475569;">ดับเบิลคลิกแก้ข้อความได้เลย · เสร็จแล้วกดซ่อน modal ในหมวด "Modal นี้" แล้วไปเลือกปุ่มที่จะผูก</p>` +
      `<button data-rl-modal-close onclick="this.closest('[data-rl-modal]').style.display='none';return false"` +
      ` style="background:#7c3aed; color:#fff; border:0; border-radius:8px; padding:10px 24px; font-weight:600; cursor:pointer;">ปิด</button>` +
      `</div>`;
    document.body.appendChild(overlay);
    trackAdded(overlay, "end", "body", `เพิ่ม modal #${state.seq}`);
    toast("เพิ่ม modal แล้ว 🪟 — แก้ข้อความ/สไตล์ได้เลย แล้วผูกกับปุ่มที่ต้องการ");
  }

  function bindModal() {
    const el = state.selected;
    if (!el) { toast("เลือกปุ่ม/element ที่จะผูกก่อน"); return; }
    const id = $("#in-modal-sel").value;
    if (!id) { toast("ยังไม่มี modal — เพิ่มที่แท็บ \"เพิ่ม\" ก่อน"); return; }
    if (el.closest("[data-rl-modal]")) { toast("ผูกจาก element ข้างใน modal ไม่ได้ — เลือกปุ่มบนหน้า"); return; }
    const rec = getRecord(el);
    const prev = {
      attr: el.getAttribute("data-rl-opens-modal"),
      onclick: el.getAttribute("onclick"),
      recModal: rec.opensModal || null,
    };
    if (rec.prevOnclick === undefined) rec.prevOnclick = prev.onclick; // onclick เดิมของหน้า ไว้คืนตอน reset
    el.setAttribute("data-rl-opens-modal", id);
    el.setAttribute("onclick", bindOnclickStr(id));
    rec.opensModal = id;
    pushUndo(`ผูก modal กับ ${shortLabel(el)}`, () => {
      if (prev.attr) el.setAttribute("data-rl-opens-modal", prev.attr);
      else el.removeAttribute("data-rl-opens-modal");
      if (prev.onclick) el.setAttribute("onclick", prev.onclick);
      else el.removeAttribute("onclick");
      rec.opensModal = prev.recModal;
      if (state.selected === el) populateInspector(el);
    }, () => {
      el.setAttribute("data-rl-opens-modal", id);
      el.setAttribute("onclick", bindOnclickStr(id));
      rec.opensModal = id;
      if (state.selected === el) populateInspector(el);
    });
    updateCounter();
    populateInspector(el);
    const m = document.querySelector(`[data-rl-modal="${id}"]`);
    if (m) m.style.display = "none"; // เก็บ modal เข้าสถานะเริ่มต้น พร้อมลองกด
    toast(`🔗 ผูกแล้ว — สลับ "โหมดใช้งาน" แล้วคลิก ${shortLabel(el)} เพื่อเปิด modal`);
  }

  function unbindModal() {
    const el = state.selected;
    if (!el || !el.getAttribute("data-rl-opens-modal")) return;
    const rec = getRecord(el);
    const prevAttr = el.getAttribute("data-rl-opens-modal");
    const prevClick = el.getAttribute("onclick");
    const clear = () => {
      el.removeAttribute("data-rl-opens-modal");
      if (rec.prevOnclick) el.setAttribute("onclick", rec.prevOnclick);
      else el.removeAttribute("onclick");
      rec.opensModal = null;
      if (state.selected === el) populateInspector(el);
    };
    clear();
    pushUndo(`ยกเลิกผูก modal ของ ${shortLabel(el)}`, () => {
      el.setAttribute("data-rl-opens-modal", prevAttr);
      if (prevClick) el.setAttribute("onclick", prevClick);
      rec.opensModal = prevAttr;
      if (state.selected === el) populateInspector(el);
    }, clear);
    updateCounter();
    toast("ยกเลิกผูก modal แล้ว");
  }

  // element library: ปุ่ม / หัวข้อ / ย่อหน้าข้อความ
  function addButtonEl() {
    state.seq += 1;
    const b = document.createElement("a");
    b.setAttribute("data-rl-added", "btn-" + state.seq);
    b.href = "#";
    b.textContent = "ปุ่มใหม่";
    b.style.cssText =
      "display:inline-block; background:#7c3aed; color:#fff; padding:10px 24px;" +
      "border-radius:8px; font-weight:600; text-decoration:none; margin:8px; font-family:inherit;";
    insertNew(b, `เพิ่มปุ่ม #${state.seq}`);
    toast("เพิ่มปุ่มแล้ว 🔘 — ดับเบิลคลิกแก้ข้อความ");
  }

  function addHeadingEl() {
    state.seq += 1;
    const h = document.createElement("h2");
    h.setAttribute("data-rl-added", "head-" + state.seq);
    h.textContent = "หัวข้อใหม่ — ดับเบิลคลิกแก้ข้อความ";
    h.style.cssText = "margin:16px; font-family:inherit;";
    insertNew(h, `เพิ่มหัวข้อ #${state.seq}`);
    toast("เพิ่มหัวข้อแล้ว");
  }

  function addTextEl() {
    state.seq += 1;
    const p = document.createElement("p");
    p.setAttribute("data-rl-added", "text-" + state.seq);
    p.textContent = "ย่อหน้าข้อความใหม่ — ดับเบิลคลิกเพื่อพิมพ์ข้อความจริงแทนที่ข้อความตัวอย่างนี้";
    p.style.cssText = "margin:12px 16px; line-height:1.7; font-family:inherit;";
    insertNew(p, `เพิ่มข้อความ #${state.seq}`);
    toast("เพิ่มย่อหน้าข้อความแล้ว");
  }

  // ---------------------------------------------------------------
  // copy / paste element
  // ---------------------------------------------------------------
  function cleanClone(clone) {
    const all = [clone, ...clone.querySelectorAll("[data-rl-changed],[data-rl-hidden],[data-rl-added],[data-rl-ghost],[data-rl-guide],[contenteditable]")];
    for (const n of all) {
      n.removeAttribute("data-rl-changed");
      n.removeAttribute("data-rl-hidden");
      n.removeAttribute("data-rl-added");
      n.removeAttribute("data-rl-ghost");
      n.removeAttribute("data-rl-guide");
      n.removeAttribute("contenteditable");
    }
    clone.style.removeProperty("opacity");
    return clone;
  }

  function copySelected() {
    const el = state.selected;
    if (!el) { toast("เลือก element ที่จะคัดลอกก่อน"); return; }
    state.clipboard = { node: cleanClone(el.cloneNode(true)), from: cssPath(el) };
    toast(`📄 คัดลอก ${shortLabel(el)} แล้ว — กด "วาง" หรือ ⌘V`);
  }

  function pasteClipboard() {
    const c = state.clipboard;
    if (!c) { toast("ยังไม่ได้คัดลอก element ไหนเลย"); return; }
    state.seq += 1;
    const el = c.node.cloneNode(true); // วางซ้ำได้หลายครั้ง
    el.setAttribute("data-rl-added", "paste-" + state.seq);
    insertNew(el, `วางสำเนา ${shortLabel(el)}`);
    toast("📋 วางสำเนาแล้ว");
  }

  function doUndo() {
    const item = state.undoStack.pop();
    if (!item) return;
    item.undo();
    if (item.redo) state.redoStack.push(item);
    updateUndoButton();
    updateCounter();
    refreshChangeList();
    scheduleSave();
    toast("↩︎ ยกเลิก: " + item.label);
  }

  function doRedo() {
    const item = state.redoStack.pop();
    if (!item) return;
    item.redo();
    state.undoStack.push(item);
    updateUndoButton();
    updateCounter();
    refreshChangeList();
    scheduleSave();
    toast("↪︎ ทำอีกครั้ง: " + item.label);
  }

  // ---------------------------------------------------------------
  // export
  // ---------------------------------------------------------------
  function ts() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function buildReport() {
    const changes = [];
    for (const [el, rec] of state.changes) {
      if (el.hasAttribute("data-rl-added")) continue; // section ใหม่รายงานแยก
      const item = { selector: rec.selector, tag: rec.tag, summary: [] };
      if (Object.keys(rec.styles).length) {
        item.styles = rec.styles;
        for (const [p, v] of Object.entries(rec.styles))
          item.summary.push(`${p}: "${v.from}" → "${v.to}"`);
      }
      if (rec.text) { item.textChanged = rec.text; item.summary.push("แก้ข้อความ"); }
      if (rec.image) { item.imageChanged = rec.image; item.summary.push("เปลี่ยนรูป"); }
      if (rec.movedTo) {
        item.movedTo = rec.movedTo;
        item.summary.push(
          `ย้าย block ไปไว้ใน "${rec.movedTo.parent}"` +
          (rec.movedTo.before ? ` ก่อน "${rec.movedTo.before}"` : " (ต่อท้าย)")
        );
      }
      if (rec.domMoved) { item.domReordered = rec.domMoved; item.summary.push("สลับลำดับใน DOM"); }
      if (rec.colSwaps && rec.colSwaps.length) {
        item.columnSwaps = rec.colSwaps;
        item.summary.push("สลับคอลัมน์ตาราง " + rec.colSwaps.map(([a, b]) => `${a + 1}↔${b + 1}`).join(", "));
      }
      if (rec.opensModal) {
        item.opensModal = rec.opensModal;
        item.summary.push(`ผูกให้คลิกแล้วเปิด modal "${rec.opensModal}"`);
      }
      if (rec.hidden) { item.hidden = true; item.summary.push("ซ่อน element นี้"); }
      if (rec.deleted) { item.deleted = true; item.summary.push("ลบ element นี้ออกเลย"); }
      if (item.summary.length) changes.push(item);
    }
    const added = state.addedSections.map((s) => {
      // ตัด attribute ไกด์ (เส้นประ) ออกจาก HTML ที่ส่งให้ dev
      const c = s.el.cloneNode(true);
      c.removeAttribute("data-rl-guide");
      c.querySelectorAll("[data-rl-guide]").forEach((n) => n.removeAttribute("data-rl-guide"));
      return {
        position: s.position,
        referenceSelector: s.refSelector,
        html: c.outerHTML,
        currentStyles: state.changes.get(s.el)?.styles || {},
      };
    });
    return {
      tool: "Relayout Editor",
      url: location.href,
      title: document.title,
      exportedAt: new Date().toISOString(),
      viewport: { width: innerWidth, height: innerHeight },
      changedElements: changes,
      addedSections: added,
    };
  }

  function exportJSON() {
    const report = buildReport();
    if (!report.changedElements.length && !report.addedSections.length) {
      toast("ยังไม่มีการแก้ไขให้ export");
      return;
    }
    download(
      `relayout-report-${ts()}.json`,
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    );
    toast("ดาวน์โหลดรายงาน JSON แล้ว 📋");
  }

  function exportHTML() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelector("#" + HOST_ID)?.remove();
    clone.querySelector("#__relayout_mode_style")?.remove();
    clone.removeAttribute("data-rl-mode");
    clone.querySelectorAll("[data-rl-guide]").forEach((n) => n.removeAttribute("data-rl-guide"));
    clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
    const header =
      `<!-- แก้ไขด้วย Relayout Editor ${new Date().toISOString()}\n` +
      `     ต้นทาง: ${location.href}\n` +
      `     element ที่แก้จะมี attribute data-rl-changed / section ใหม่มี data-rl-added -->\n`;
    const html = "<!DOCTYPE html>\n" + header + clone.outerHTML;
    download(`relayout-page-${ts()}.html`, new Blob([html], { type: "text/html" }));
    toast("ดาวน์โหลดหน้า HTML แล้ว 🧾");
  }

  // ซ่อน UI + เส้นไกด์ของเราก่อนถ่าย / เอาคืนหลังถ่าย
  function uiOffForShot() {
    host.style.display = "none";
    document.documentElement.removeAttribute("data-rl-mode");
  }
  function uiOnAfterShot() {
    host.style.display = "";
    document.documentElement.setAttribute("data-rl-mode", state.mode);
  }

  function exportScreenshot() {
    uiOffForShot();
    requestAnimationFrame(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "rl-capture" }, (res) => {
          uiOnAfterShot();
          if (!res || !res.dataUrl) { toast("ถ่าย screenshot ไม่สำเร็จ"); return; }
          fetch(res.dataUrl)
            .then((r) => r.blob())
            .then((blob) => download(`relayout-shot-${ts()}.png`, blob));
          toast("ดาวน์โหลด screenshot แล้ว 📸");
        });
      }, 80);
    });
  }

  // ---------------------------------------------------------------
  // export CSS snippet
  // ---------------------------------------------------------------
  function exportCSS() {
    const report = buildReport();
    let css = `/* Relayout Editor — ${location.href}\n   export เมื่อ ${new Date().toISOString()} */\n\n`;
    let has = false;
    for (const item of report.changedElements) {
      const notes = [];
      if (item.textChanged) notes.push("แก้ข้อความด้วย (ดูรายงาน JSON)");
      if (item.imageChanged) notes.push("เปลี่ยนรูปด้วย");
      if (item.movedTo) notes.push(`ย้ายไปไว้ใน ${item.movedTo.parent}`);
      if (item.deleted) notes.push("ลบ element นี้ออกจากหน้า");
      const props = Object.entries(item.styles || {});
      if (item.hidden) props.push(["display", { to: "none" }]);
      if (!props.length && !notes.length) continue;
      has = true;
      if (notes.length) css += `/* ${notes.join(" · ")} */\n`;
      if (props.length) {
        css += `${item.selector} {\n`;
        for (const [p, v] of props) css += `  ${p}: ${v.to};\n`;
        css += `}\n\n`;
      } else {
        css += `/* ${item.selector} */\n\n`;
      }
    }
    if (!has) { toast("ยังไม่มีการแก้สไตล์ให้ export"); return; }
    download(`relayout-styles-${ts()}.css`, new Blob([css], { type: "text/css" }));
    toast("ดาวน์โหลด CSS แล้ว 🎨");
  }

  // ---------------------------------------------------------------
  // screenshot เฉพาะ element / ทั้งหน้า
  // ---------------------------------------------------------------
  function captureViewport() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "rl-capture" }, (res) =>
          resolve((res && res.dataUrl) || null)
        );
      } catch { resolve(null); }
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function exportShotElement() {
    const el = state.selected;
    if (!el) { toast("เลือก element ที่จะถ่ายก่อน"); return; }
    el.scrollIntoView({ block: "nearest" });
    await wait(150);
    const r = el.getBoundingClientRect();
    uiOffForShot();
    await wait(100);
    const dataUrl = await captureViewport();
    uiOnAfterShot();
    if (!dataUrl) { toast("ถ่าย screenshot ไม่สำเร็จ"); return; }
    const img = new Image();
    img.onload = () => {
      const dpr = img.width / innerWidth;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.getContext("2d").drawImage(
        img, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr,
        0, 0, c.width, c.height
      );
      c.toBlob((b) => {
        download(`relayout-element-${ts()}.png`, b);
        toast("📸 ถ่ายเฉพาะ element แล้ว");
      });
    };
    img.src = dataUrl;
  }

  async function exportShotFull() {
    const total = Math.min(document.documentElement.scrollHeight, 8000); // กันหน้ายาวอนันต์
    const vh = innerHeight;
    const prevScroll = scrollY;
    toast("📸 กำลังถ่ายทั้งหน้า อย่าขยับเมาส์/สกรอลล์…");
    await wait(600);
    uiOffForShot();
    const shots = [];
    try {
      for (let y = 0; y < total; y += vh) {
        scrollTo(0, y);
        await wait(450); // รอ paint + rate limit ของ captureVisibleTab
        const dataUrl = await captureViewport();
        if (!dataUrl) throw new Error("capture fail");
        shots.push({ actualY: scrollY, dataUrl });
      }
    } catch {
      uiOnAfterShot();
      scrollTo(0, prevScroll);
      toast("ถ่ายทั้งหน้าไม่สำเร็จ");
      return;
    }
    scrollTo(0, prevScroll);
    uiOnAfterShot();
    const imgs = await Promise.all(shots.map(
      (s) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = s.dataUrl; })
    ));
    const dpr = imgs[0].width / innerWidth;
    const c = document.createElement("canvas");
    c.width = imgs[0].width;
    c.height = Math.round(total * dpr);
    const ctx = c.getContext("2d");
    shots.forEach((s, i) => ctx.drawImage(imgs[i], 0, Math.round(s.actualY * dpr)));
    c.toBlob((b) => {
      download(`relayout-fullpage-${ts()}.png`, b);
      toast("📸 ดาวน์โหลดภาพทั้งหน้าแล้ว");
    });
  }

  // ---------------------------------------------------------------
  // persistence: บันทึก draft ข้าม refresh + import JSON
  // ---------------------------------------------------------------
  const draftKey = "rl-draft:" + location.origin + location.pathname;

  function storageSet(val) {
    try {
      if (chrome?.storage?.local) chrome.storage.local.set({ [draftKey]: val });
      else localStorage.setItem(draftKey, JSON.stringify(val));
    } catch {}
  }
  function storageGet(cb) {
    try {
      if (chrome?.storage?.local) chrome.storage.local.get(draftKey, (r) => cb((r && r[draftKey]) || null));
      else cb(JSON.parse(localStorage.getItem(draftKey) || "null"));
    } catch { cb(null); }
  }
  function storageClear() {
    try {
      if (chrome?.storage?.local) chrome.storage.local.remove(draftKey);
      else localStorage.removeItem(draftKey);
    } catch {}
  }

  let saveTimer = null;
  scheduleSaveImpl = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (state.changes.size || state.addedSections.length) storageSet(buildReport());
      else storageClear();
    }, 600);
  };

  // เอารายงาน (จาก storage หรือไฟล์ import) กลับมา apply บนหน้า
  function applyReport(report) {
    let ok = 0, fail = 0;
    for (const item of report.changedElements || []) {
      const el = document.querySelector(item.selector);
      if (!el || host.contains(el)) { fail++; continue; }
      const rec = getRecord(el); // เก็บ origParent/origNext ตอนนี้ (ก่อนย้าย) ให้ reset ได้
      for (const [prop, v] of Object.entries(item.styles || {})) {
        rec.styles[prop] = { from: v.from, to: v.to };
        el.style.setProperty(prop, v.to, "important");
      }
      if (item.textChanged) {
        rec.text = { from: item.textChanged.from, to: item.textChanged.to };
        el.innerHTML = item.textChanged.to;
      }
      if (item.imageChanged && el.tagName === "IMG") {
        rec.image = { from: item.imageChanged.from, to: item.imageChanged.to };
        el.src = item.imageChanged.to;
        el.removeAttribute("srcset");
      }
      if (item.movedTo) {
        const parent = document.querySelector(item.movedTo.parent);
        if (parent && parent !== el && !el.contains(parent)) {
          const before = item.movedTo.before ? document.querySelector(item.movedTo.before) : null;
          parent.insertBefore(el, before && before.parentElement === parent ? before : null);
          syncMovedTo(el, rec);
        }
      }
      if (item.columnSwaps && el.tagName === "TABLE") {
        rec.colSwaps = rec.colSwaps || [];
        for (const [a, b] of item.columnSwaps) {
          swapAdjacentColumns(el, a, b);
          rec.colSwaps.push([a, b]);
        }
      }
      if (item.opensModal) {
        if (rec.prevOnclick === undefined) rec.prevOnclick = el.getAttribute("onclick");
        el.setAttribute("data-rl-opens-modal", item.opensModal);
        el.setAttribute("onclick", bindOnclickStr(item.opensModal));
        rec.opensModal = item.opensModal;
      }
      if (item.hidden) {
        el.style.setProperty("display", "none", "important");
        rec.hidden = true;
        el.setAttribute("data-rl-hidden", "");
      }
      if (item.deleted) { rec.deleted = true; el.remove(); }
      ok++;
    }
    for (const add of report.addedSections || []) {
      const tpl = document.createElement("template");
      tpl.innerHTML = (add.html || "").trim();
      const el = tpl.content.firstElementChild;
      if (!el) { fail++; continue; }
      let placed = false;
      if (add.position !== "end" && add.referenceSelector) {
        const ref = document.querySelector(add.referenceSelector);
        if (ref && ref.parentElement) {
          ref.parentElement.insertBefore(el, add.position === "before" ? ref : ref.nextElementSibling);
          placed = true;
        }
      }
      if (!placed) document.body.appendChild(el);
      // คืนไกด์เส้นประให้ (เห็นเฉพาะโหมดแก้ไข) เพื่อให้รู้ว่าเป็นของที่เพิ่มเอง
      if (/^(section|box)-/.test(el.getAttribute("data-rl-added") || ""))
        el.setAttribute("data-rl-guide", el.getAttribute("data-rl-added").startsWith("section") ? "section" : "");
      state.addedSections.push({ el, position: add.position, refSelector: add.referenceSelector });
      ok++;
    }
    updateCounter();
    refreshBoxes();
    scheduleSave();
    return { ok, fail };
  }

  // เช็ค draft เก่าตอนเปิด editor → โชว์แถบกู้คืน
  function checkDraft() {
    if (state.changes.size || state.addedSections.length) return;
    storageGet((saved) => {
      if (!saved) return;
      const n = (saved.changedElements || []).length + (saved.addedSections || []).length;
      if (!n) return;
      $("#restore-info").textContent =
        `💾 พบงานที่ค้างไว้ ${n} รายการ (${new Date(saved.exportedAt).toLocaleString("th-TH")})`;
      $("#restorebar").classList.add("show");
      $("#btn-restore").onclick = () => {
        const res = applyReport(saved);
        $("#restorebar").classList.remove("show");
        toast(`↻ กู้คืนแล้ว ${res.ok} รายการ` + (res.fail ? ` · หา element ไม่เจอ ${res.fail}` : ""));
      };
      $("#btn-discard").onclick = () => {
        storageClear();
        $("#restorebar").classList.remove("show");
        toast("ทิ้งงานเก่าแล้ว");
      };
    });
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const report = JSON.parse(reader.result);
        const res = applyReport(report);
        toast(`📥 import แล้ว ${res.ok} รายการ` + (res.fail ? ` · หา element ไม่เจอ ${res.fail}` : ""));
      } catch {
        toast("ไฟล์ JSON ไม่ถูกต้อง");
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------
  // คลัง asset: เก็บ element ไว้ใน chrome.storage แล้วเอาไปวางหน้าอื่นได้
  // ---------------------------------------------------------------
  const ASSETS_KEY = "rl-assets";

  function assetsGet(cb) {
    try {
      if (chrome?.storage?.local) chrome.storage.local.get(ASSETS_KEY, (r) => cb((r && r[ASSETS_KEY]) || []));
      else cb(JSON.parse(localStorage.getItem(ASSETS_KEY) || "[]"));
    } catch { cb([]); }
  }
  function assetsSet(list) {
    try {
      if (chrome?.storage?.local) chrome.storage.local.set({ [ASSETS_KEY]: list });
      else localStorage.setItem(ASSETS_KEY, JSON.stringify(list));
    } catch {}
  }

  // อบ computed styles ลง inline เพื่อให้ asset หน้าตาใกล้เคียงเดิมแม้ไปวางหน้าที่ไม่มี CSS ของหน้านี้
  const BAKE_PROPS = [
    "display", "padding", "margin", "border", "border-radius", "background", "color",
    "font-family", "font-size", "font-weight", "line-height", "text-align", "text-decoration",
    "box-shadow", "gap", "flex-direction", "flex-wrap", "justify-content", "align-items",
    "grid-template-columns", "object-fit", "opacity", "max-width",
  ];
  function bakeStyles(srcEl, cloneEl) {
    let count = 0;
    const walk = (s, c) => {
      if (!s || !c || c.nodeType !== 1 || ++count > 80) return;
      const cs = getComputedStyle(s);
      for (const p of BAKE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v && !c.style.getPropertyValue(p)) c.style.setProperty(p, v);
      }
      for (let i = 0; i < c.children.length; i++) walk(s.children[i], c.children[i]);
    };
    walk(srcEl, cloneEl);
  }

  function saveAsset() {
    const el = state.selected;
    if (!el) { toast("เลือก element ที่จะเก็บก่อน"); return; }
    const name = prompt("ตั้งชื่อ asset:", shortLabel(el));
    if (name === null) return;
    const clone = cleanClone(el.cloneNode(true));
    // ถอดไกด์ชั่วคราว กัน background จาง ๆ ของไกด์ถูกอบติดเข้า asset
    const hadGuide = el.getAttribute("data-rl-guide");
    if (hadGuide !== null) el.removeAttribute("data-rl-guide");
    bakeStyles(el, clone);
    if (hadGuide !== null) el.setAttribute("data-rl-guide", hadGuide);
    const asset = {
      id: Date.now() + "-" + ++state.seq,
      name: name.trim() || shortLabel(el),
      html: clone.outerHTML,
      from: location.href,
      savedAt: new Date().toISOString(),
    };
    assetsGet((list) => {
      list.unshift(asset);
      if (list.length > 30) list.length = 30; // เก็บล่าสุด 30 ชิ้นพอ
      assetsSet(list);
      refreshAssetList();
      toast(`📦 เก็บ "${asset.name}" เข้าคลังแล้ว — เปิด editor หน้าไหนก็เอาไปวางได้`);
    });
  }

  function insertAsset(asset) {
    const tpl = document.createElement("template");
    tpl.innerHTML = asset.html.trim();
    const el = tpl.content.firstElementChild;
    if (!el) { toast("asset นี้เสียหาย"); return; }
    state.seq += 1;
    el.setAttribute("data-rl-added", "asset-" + state.seq);
    insertNew(el, `วาง asset "${asset.name}"`);
    toast(`📌 วาง "${asset.name}" แล้ว`);
  }

  function refreshAssetList() {
    assetsGet((list) => {
      const box = $("#assetlist");
      box.innerHTML = "";
      if (!list.length) {
        box.innerHTML = `<div class="hint">คลังยังว่าง — เลือก element แล้วกด "เก็บเข้าคลัง"</div>`;
        return;
      }
      for (const asset of list) {
        const row = document.createElement("div");
        row.className = "chg";
        const lbl = document.createElement("span");
        lbl.className = "lbl";
        lbl.textContent = asset.name;
        lbl.title = `จาก ${asset.from}\nคลิกเพื่อวางลงหน้า`;
        lbl.addEventListener("click", () => insertAsset(asset));
        const put = document.createElement("button");
        put.textContent = "📌";
        put.title = "วางลงหน้า (ต่อจาก element ที่เลือก)";
        put.addEventListener("click", () => insertAsset(asset));
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.title = "ลบออกจากคลัง";
        del.addEventListener("click", () => {
          assetsGet((cur) => {
            assetsSet(cur.filter((a) => a.id !== asset.id));
            refreshAssetList();
            toast(`ลบ "${asset.name}" ออกจากคลังแล้ว`);
          });
        });
        row.append(lbl, put, del);
        box.appendChild(row);
      }
    });
  }

  // ---------------------------------------------------------------
  // รายการแก้ไขใน panel
  // ---------------------------------------------------------------
  refreshChangeListImpl = () => {
    const list = $("#changelist");
    list.innerHTML = "";
    const items = [];
    for (const [el, rec] of state.changes) {
      if (el.hasAttribute("data-rl-added")) continue;
      const kinds = [];
      if (Object.keys(rec.styles).length) kinds.push("สไตล์");
      if (rec.text) kinds.push("ข้อความ");
      if (rec.image) kinds.push("รูป");
      if (rec.movedTo || rec.domMoved) kinds.push("ย้าย");
      if (rec.colSwaps && rec.colSwaps.length) kinds.push("คอลัมน์");
      if (rec.opensModal) kinds.push("ผูก modal");
      if (rec.hidden) kinds.push("ซ่อน");
      if (rec.deleted) kinds.push("ลบ");
      if (!kinds.length) continue;
      items.push({ el, rec, kinds });
    }
    for (const s of state.addedSections) items.push({ el: s.el, kinds: ["เพิ่มใหม่"], added: true });
    if (!items.length) {
      list.innerHTML = `<div class="hint">ยังไม่มีการแก้ไข</div>`;
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "chg";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = shortLabel(it.el);
      lbl.title = "คลิกเพื่อกระโดดไปดู";
      lbl.addEventListener("click", () => {
        if (!it.el.isConnected) { toast("element นี้ไม่อยู่ในหน้าแล้ว (ถูกลบ/โดน render ทับ)"); return; }
        select(it.el);
        it.el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      const kinds = document.createElement("span");
      kinds.className = "kinds";
      kinds.textContent = it.kinds.join("·");
      row.append(lbl, kinds);
      if (!it.added) {
        const rs = document.createElement("button");
        rs.textContent = "♻️";
        rs.title = "รีเซ็ต element นี้กลับค่าเดิม";
        rs.addEventListener("click", () => {
          restoreElement(it.el, it.rec);
          state.changes.delete(it.el);
          if (state.selected === it.el) populateInspector(it.el);
          refreshBoxes();
          updateCounter();
          scheduleSave();
          toast("รีเซ็ต " + shortLabel(it.el) + " แล้ว");
        });
        row.appendChild(rs);
      }
      list.appendChild(row);
    }
  };

  // ---------------------------------------------------------------
  // SPA guard: เตือนเมื่อ framework ของหน้า render ทับการแก้ไข
  // ---------------------------------------------------------------
  let spaTimer = null;
  let spaWarned = false;
  const spaObserver = new MutationObserver(() => {
    if (spaTimer) return;
    spaTimer = setTimeout(() => {
      spaTimer = null;
      if (!state.enabled) return;
      let lost = 0;
      for (const [el, rec] of state.changes) {
        if (el.hasAttribute("data-rl-added")) continue;
        if (!el.isConnected && !rec.deleted) lost++;
      }
      for (const s of state.addedSections) if (!s.el.isConnected) lost++;
      if (lost && !spaWarned) {
        spaWarned = true;
        toast(`⚠️ หน้าเว็บ render ทับ — การแก้ไข ${lost} รายการหลุดจากหน้า (ใช้ปุ่มกู้คืน/import ได้)`);
      }
      if (!lost) spaWarned = false;
    }, 800);
  });

  // ---------------------------------------------------------------
  // responsive preview: ปรับขนาดหน้าต่างเบราว์เซอร์ผ่าน background
  // ---------------------------------------------------------------
  function setViewport(width) {
    try {
      if (width === "restore") {
        chrome.runtime.sendMessage({ type: "rl-resize", restore: true });
        toast("↩︎ คืนขนาดหน้าต่างเดิม");
        return;
      }
      const outer = width + (window.outerWidth - window.innerWidth);
      chrome.runtime.sendMessage({ type: "rl-resize", width: outer });
      toast(`📐 ปรับ viewport เป็น ~${width}px`);
    } catch {
      toast("ปรับขนาดหน้าต่างไม่ได้ในโหมดนี้");
    }
  }

  // ---------------------------------------------------------------
  // panel events
  // ---------------------------------------------------------------
  // สลับแท็บ
  function setTab(name) {
    shadow.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
    shadow.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.dataset.pane === name));
  }
  shadow.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => setTab(t.dataset.tab))
  );
  $("#btn-min").addEventListener("click", () => {
    const min = ui.panel.classList.toggle("min");
    $("#btn-min").textContent = min ? "▔" : "▁";
    $("#btn-min").title = min ? "ขยาย panel" : "ย่อ panel";
  });
  $("#btn-close").addEventListener("click", () => api.toggle());
  $("#btn-undo").addEventListener("click", doUndo);
  $("#btn-redo").addEventListener("click", doRedo);
  $("#mode-edit").addEventListener("click", () => setMode("edit"));
  $("#mode-action").addEventListener("click", () => setMode("action"));
  $("#btn-asset-save").addEventListener("click", saveAsset);
  $("#btn-text").addEventListener("click", () => {
    if (state.editingText) { stopTextEdit(); refreshBoxes(); }
    else startTextEdit(state.selected);
  });
  $("#btn-up").addEventListener("click", () => moveInDom(-1));
  $("#btn-down").addEventListener("click", () => moveInDom(1));
  $("#btn-col-left").addEventListener("click", () => moveColumn(-1));
  $("#btn-col-right").addEventListener("click", () => moveColumn(1));
  $("#btn-hide").addEventListener("click", hideSelected);
  $("#btn-group-hide").addEventListener("click", groupHide);
  $("#btn-group-delete").addEventListener("click", groupDelete);
  $("#btn-group-clear").addEventListener("click", () => setMulti([]));
  $("#btn-reset").addEventListener("click", resetSelected);
  $("#btn-reset-all").addEventListener("click", resetAll);
  $("#btn-copy").addEventListener("click", copySelected);
  $("#btn-paste").addEventListener("click", pasteClipboard);
  $("#btn-duplicate").addEventListener("click", duplicateSelected);
  $("#btn-delete").addEventListener("click", deleteSelected);
  $("#btn-add-box").addEventListener("click", addBox);
  $("#btn-add-img").addEventListener("click", addImage);
  $("#btn-add-btn").addEventListener("click", addButtonEl);
  $("#btn-add-head").addEventListener("click", addHeadingEl);
  $("#btn-add-text").addEventListener("click", addTextEl);
  $("#btn-add-modal").addEventListener("click", addModal);
  $("#btn-bind-modal").addEventListener("click", bindModal);
  $("#btn-unbind-modal").addEventListener("click", unbindModal);
  $("#btn-modal-open").addEventListener("click", () => {
    const id = $("#in-modal-sel").value;
    if (id && openModal(id)) toast("👁 เปิด modal ให้ดู/แก้แล้ว");
  });
  $("#btn-modal-hide").addEventListener("click", () => {
    const m = state.selected && state.selected.closest && state.selected.closest("[data-rl-modal]");
    if (!m) return;
    m.style.display = "none";
    select(null);
    toast("🙈 ซ่อน modal แล้ว (สถานะเริ่มต้น) — เลือกปุ่มแล้วผูกได้เลย");
  });
  $("#btn-add-before").addEventListener("click", () => addSection("before"));
  $("#btn-add-after").addEventListener("click", () => addSection("after"));
  $("#btn-add-end").addEventListener("click", () => addSection("end"));
  $("#btn-export-json").addEventListener("click", exportJSON);
  $("#btn-export-css").addEventListener("click", exportCSS);
  $("#btn-export-html").addEventListener("click", exportHTML);
  $("#btn-export-shot").addEventListener("click", exportScreenshot);
  $("#btn-export-shot-el").addEventListener("click", exportShotElement);
  $("#btn-export-shot-full").addEventListener("click", exportShotFull);
  $("#btn-vp-390").addEventListener("click", () => setViewport(390));
  $("#btn-vp-768").addEventListener("click", () => setViewport(768));
  $("#btn-vp-1280").addEventListener("click", () => setViewport(1280));
  $("#btn-vp-restore").addEventListener("click", () => setViewport("restore"));
  $("#in-import").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) importJSON(f);
    e.target.value = "";
  });

  $("#in-bg").addEventListener("input", (e) => state.selected && applyStyle(state.selected, "background-color", e.target.value));
  $("#in-color").addEventListener("input", (e) => state.selected && applyStyle(state.selected, "color", e.target.value));
  $("#in-fontsize").addEventListener("change", (e) => state.selected && e.target.value && applyStyle(state.selected, "font-size", e.target.value + "px"));
  $("#in-radius").addEventListener("change", (e) => state.selected && applyStyle(state.selected, "border-radius", e.target.value + "px"));
  $("#in-padding").addEventListener("change", (e) => state.selected && applyStyle(state.selected, "padding", e.target.value + "px"));
  $("#in-width").addEventListener("change", (e) => state.selected && e.target.value && applyStyle(state.selected, "width", e.target.value));
  $("#in-height").addEventListener("change", (e) => state.selected && e.target.value && applyStyle(state.selected, "height", e.target.value));
  $("#in-bold").addEventListener("click", () => {
    const el = state.selected;
    if (!el) return;
    const isBold = parseInt(getComputedStyle(el).fontWeight) >= 600;
    applyStyle(el, "font-weight", isBold ? "400" : "700");
    $("#in-bold").classList.toggle("on", !isBold);
  });
  $("#in-al").addEventListener("click", () => state.selected && applyStyle(state.selected, "text-align", "left"));
  $("#in-ac").addEventListener("click", () => state.selected && applyStyle(state.selected, "text-align", "center"));
  $("#in-ar").addEventListener("click", () => state.selected && applyStyle(state.selected, "text-align", "right"));
  const applyMargin = () => {
    if (!state.selected) return;
    const v = (id) => (parseInt($(id).value) || 0) + "px";
    applyStyle(state.selected, "margin", `${v("#in-mt")} ${v("#in-mr")} ${v("#in-mb")} ${v("#in-ml")}`);
  };
  ["#in-mt", "#in-mr", "#in-mb", "#in-ml"].forEach((id) =>
    $(id).addEventListener("change", applyMargin)
  );

  // Layout / Grid
  $("#in-display").addEventListener("change", (e) => {
    const el = state.selected;
    if (!el || !e.target.value) return;
    const gap = parseInt($("#in-gap").value);
    const cols = Math.max(1, parseInt($("#in-cols").value) || 3);
    const presets = {
      block: { display: "block" },
      "flex-row": { display: "flex", "flex-direction": "row", "flex-wrap": "wrap" },
      "flex-col": { display: "flex", "flex-direction": "column" },
      grid: { display: "grid", "grid-template-columns": `repeat(${cols}, 1fr)` },
    };
    const props = { ...presets[e.target.value] };
    if (e.target.value !== "block" && !Number.isNaN(gap) && gap > 0) props.gap = gap + "px";
    applyStyles(el, props, `จัด layout ${e.target.value} ที่ ${shortLabel(el)}`);
  });
  $("#in-cols").addEventListener("change", (e) => {
    const el = state.selected;
    if (!el) return;
    const cols = Math.max(1, parseInt(e.target.value) || 1);
    // ตั้งคอลัมน์ = ตั้ง grid ให้เลยถ้ายังไม่เป็น
    if (getComputedStyle(el).display.includes("grid"))
      applyStyle(el, "grid-template-columns", `repeat(${cols}, 1fr)`);
    else
      applyStyles(el, { display: "grid", "grid-template-columns": `repeat(${cols}, 1fr)` },
        `จัด grid ${cols} คอลัมน์ ที่ ${shortLabel(el)}`);
    $("#in-display").value = "grid";
  });
  $("#in-gap").addEventListener("change", (e) => state.selected && applyStyle(state.selected, "gap", (parseInt(e.target.value) || 0) + "px"));

  // CSS กำหนดเอง
  $("#btn-apply-css").addEventListener("click", () => {
    const el = state.selected;
    if (!el) { toast("เลือก element ก่อน"); return; }
    const props = {};
    const bad = [];
    for (const decl of $("#in-css").value.split(/;|\n/)) {
      const s = decl.trim();
      if (!s || s.startsWith("/*")) continue;
      const i = s.indexOf(":");
      const prop = i > 0 ? s.slice(0, i).trim().toLowerCase() : "";
      const value = i > 0 ? s.slice(i + 1).trim().replace(/!important\s*$/i, "").trim() : "";
      if (!prop || !value || !CSS.supports(prop, value)) { bad.push(s); continue; }
      props[prop] = value;
    }
    const n = Object.keys(props).length;
    if (!n) { toast(bad.length ? "CSS ไม่ถูกต้อง: " + bad[0] : "ยังไม่ได้พิมพ์ CSS"); return; }
    applyStyles(el, props, `custom CSS ที่ ${shortLabel(el)}`);
    toast(`✨ ใช้ CSS แล้ว ${n} รายการ` + (bad.length ? ` · ข้ามที่ไม่ถูกต้อง ${bad.length}` : ""));
  });
  $("#in-css").addEventListener("keydown", (e) => e.stopPropagation()); // กันคีย์ลัดของ editor แย่งตอนพิมพ์
  const applyBorder = () => {
    if (!state.selected) return;
    const w = parseInt($("#in-borderw").value) || 0;
    applyStyle(state.selected, "border", w ? `${w}px solid ${$("#in-borderc").value}` : "none");
  };
  $("#in-borderw").addEventListener("change", applyBorder);
  $("#in-borderc").addEventListener("input", applyBorder);
  $("#in-shadow").addEventListener("change", (e) => state.selected && applyStyle(state.selected, "box-shadow", e.target.value));
  $("#in-opacity").addEventListener("change", (e) => state.selected && applyStyle(state.selected, "opacity", String(e.target.value / 100)));
  ["in-bg", "in-color", "in-fontsize", "in-radius", "in-padding"].forEach((id) => {
    $("#" + id).addEventListener("input", updateCounter);
  });
  $("#in-imgurl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") changeImage(e.target.value.trim());
    e.stopPropagation();
  });
  $("#in-imgfile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => changeImage(reader.result);
    reader.readAsDataURL(f);
  });

  // ลาก handle ที่ขอบ/มุม selectbox เพื่อปรับขนาด element
  (() => {
    let rz = null;
    const start = (dir) => (e) => {
      const el = state.selected;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      rz = {
        el, dir,
        startX: e.clientX, startY: e.clientY,
        startW: r.width, startH: r.height,
        fromW: cs.width, fromH: cs.height,
        prevW: el.style.getPropertyValue("width"),
        prevH: el.style.getPropertyValue("height"),
      };
      e.preventDefault();
      e.stopPropagation();
    };
    shadow.querySelector(".rz-e").addEventListener("mousedown", start("e"));
    shadow.querySelector(".rz-s").addEventListener("mousedown", start("s"));
    shadow.querySelector(".rz-se").addEventListener("mousedown", start("se"));

    window.addEventListener("mousemove", (e) => {
      if (!rz) return;
      if (rz.dir !== "s")
        rz.el.style.setProperty("width", Math.max(10, Math.round(rz.startW + e.clientX - rz.startX)) + "px", "important");
      if (rz.dir !== "e")
        rz.el.style.setProperty("height", Math.max(10, Math.round(rz.startH + e.clientY - rz.startY)) + "px", "important");
      refreshBoxes();
      e.preventDefault();
      e.stopPropagation(); // กัน hover highlight ของ editor เอง
    }, true);

    window.addEventListener("mouseup", (e) => {
      if (!rz) return;
      const r = rz;
      rz = null;
      e.stopPropagation();
      const el = r.el, rec = getRecord(el);
      const changed = [];
      const finalW = el.style.getPropertyValue("width");
      const finalH = el.style.getPropertyValue("height");
      if (r.dir !== "s" && finalW !== r.prevW) changed.push(["width", r.fromW, finalW, r.prevW]);
      if (r.dir !== "e" && finalH !== r.prevH) changed.push(["height", r.fromH, finalH, r.prevH]);
      if (!changed.length) return;
      for (const [prop, from, to] of changed) {
        if (!rec.styles[prop]) rec.styles[prop] = { from, to };
        else rec.styles[prop].to = to;
      }
      pushUndo(`ปรับขนาด ${shortLabel(el)}`, () => {
        for (const [prop, from, , prevInline] of changed) {
          if (prevInline) el.style.setProperty(prop, prevInline);
          else el.style.removeProperty(prop);
          rec.styles[prop].to = prevInline || from;
        }
        refreshBoxes();
      }, () => {
        for (const [prop, , to] of changed) {
          el.style.setProperty(prop, to, "important");
          rec.styles[prop].to = to;
        }
        refreshBoxes();
      });
      updateCounter();
      populateInspector(el);
    }, true);
  })();

  // ลาก panel ย้ายที่ได้
  (() => {
    const bar = $("#dragbar");
    let sx, sy, ox, oy, moving = false;
    bar.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      moving = true;
      sx = e.clientX; sy = e.clientY;
      const r = ui.panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!moving) return;
      ui.panel.style.left = ox + e.clientX - sx + "px";
      ui.panel.style.top = Math.max(0, oy + e.clientY - sy) + "px";
      ui.panel.style.right = "auto";
    }, true);
    window.addEventListener("mouseup", () => (moving = false), true);
  })();

  // ---------------------------------------------------------------
  // enable / disable
  // ---------------------------------------------------------------
  const listeners = [
    ["mousedown", onMouseDown, true],
    ["mousemove", onMouseMove, true],
    ["mouseup", onMouseUp, true],
    ["click", onClick, true],
    ["dblclick", onDblClick, true],
    ["keydown", onKeyDown, true],
  ];
  const onScrollResize = () => refreshBoxes();

  const api = {
    toggle() {
      state.enabled ? disable() : enable();
    },
  };

  function enable() {
    state.enabled = true;
    document.documentElement.appendChild(host);
    for (const [ev, fn, cap] of listeners) document.addEventListener(ev, fn, cap);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    spaObserver.observe(document.body, { childList: true, subtree: true });
    document.head.appendChild(modeStyle);
    document.documentElement.setAttribute("data-rl-mode", state.mode);
    updateCounter();
    updateUndoButton();
    checkDraft();
    refreshAssetList();
    toast("🎨 Relayout Editor เปิดแล้ว — คลิกเลือก element ได้เลย");
  }

  function disable() {
    if (state.editingText) stopTextEdit();
    if (state.dragging) { removeGhost(state.dragging); state.dragging = null; }
    state.enabled = false;
    select(null);
    for (const [ev, fn, cap] of listeners) document.removeEventListener(ev, fn, cap);
    window.removeEventListener("scroll", onScrollResize, true);
    window.removeEventListener("resize", onScrollResize);
    spaObserver.disconnect();
    modeStyle.remove();
    document.documentElement.removeAttribute("data-rl-mode");
    host.remove();
    // การแก้ไขทั้งหมดยังคงอยู่บนหน้า เปิดใหม่จะแก้ต่อ/export ได้
  }

  window.__relayoutEditor = api;
  enable();
})();
