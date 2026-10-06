/* Asset Record – web app (iPhone, Android, PC). Rules live in logic.js (ARLogic). */
(function () {
  "use strict";
  const L = window.ARLogic;
  const app = document.getElementById("app");

  // ------------------------------------------------------------------ helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== "list" && k !== "inputMode") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const dmy = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const today = () => dmy(new Date());
  const isoToDmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; };
  const dmyToIso = (s) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; };
  const U = (s) => String(s || "").toUpperCase().trim();
  const hhmmNow = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

  // ------------------------------------------------------------------ storage (IndexedDB, memory fallback)
  const Store = {
    db: null, memoryOnly: false, master: null, session: null, devLists: { manufacturer: [], model: [], received: [], unit: [] },
    locs: [], assets: [], changes: [], photoMem: new Map(),
    byFl: new Map(), byFinal: new Map(), kids: new Map(), byEtag: new Map(),

    req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    tx(stores, mode, fn) {
      if (!this.db) return Promise.resolve();
      return new Promise((res, rej) => {
        const t = this.db.transaction(stores, mode);
        fn(t); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    async init() {
      try { const l = JSON.parse(localStorage.getItem("ar.last") || "{}"); this.lastUser = l.user; this.lastFacility = l.fac; } catch (e) {}
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open("assetrecord", 1);
          r.onupgradeneeded = () => { const d = r.result; for (const n of ["kv", "photos"]) d.createObjectStore(n); for (const n of ["locs", "assets"]) d.createObjectStore(n, { keyPath: "key" }); };
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        const t = this.db.transaction(["kv", "locs", "assets"]);
        const [master, session, devLists, locs, assets, changes] = await Promise.all([
          this.req(t.objectStore("kv").get("master")), this.req(t.objectStore("kv").get("session")),
          this.req(t.objectStore("kv").get("devLists")),
          this.req(t.objectStore("locs").getAll()), this.req(t.objectStore("assets").getAll()), this.req(t.objectStore("kv").get("changes"))]);
        this.master = master || null; this.session = session || null; if (devLists) this.devLists = devLists;
        this.locs = locs || []; this.assets = assets || []; this.changes = changes || [];
        try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      } catch (e) { this.db = null; this.memoryOnly = true; }
      this.reindex();
    },
    reindex() {
      this.byFl = new Map(); this.byFinal = new Map(); this.kids = new Map(); this.byEtag = new Map();
      for (const l of this.locs) {
        const r = l.row; if (!this.byFl.has(U(r[0]))) this.byFl.set(U(r[0]), l);
        if (r[14] && !this.byFinal.has(U(r[14]))) this.byFinal.set(U(r[14]), l);
        const k = U(r[12]); if (!this.kids.has(k)) this.kids.set(k, []); this.kids.get(k).push(r[14]);
      }
      for (const a of this.assets) this.byEtag.set(U(a.row[0]), a);
    },
    ref(l) { return l ? { fl: l.row[0], description: l.row[1], localId: l.row[2], parentCode: l.row[12], finalCode: l.row[14] } : null; },
    get index() {
      return { byFl: (f) => this.ref(this.byFl.get(U(f))), byFinal: (c) => this.ref(this.byFinal.get(U(c))), children: (p) => this.kids.get(U(p)) || [] };
    },
    async kvSet(k, v) { await this.tx(["kv"], "readwrite", (t) => t.objectStore("kv").put(v, k)); },
    async saveSession(s) { this.session = s; await this.kvSet("session", s); },

    locClass(name) { const n = U(name); return (this.master.locClasses || []).find((c) => U(c.name) === n) || null; },
    assetType(name) { const n = U(name); return (this.master.assetTypes || []).find((c) => U(c.name) === n) || null; },
    list(kind) {
      const base = { manufacturer: "manufacturers", model: "models", received: "receivedFrom", unit: "units" }[kind];
      const seen = new Set(); const out = [];
      for (const v of [...(this.master[base] || []), ...(this.devLists[kind] || [])]) { const k = U(v); if (k && !seen.has(k)) { seen.add(k); out.push(v); } }
      return out.sort((a, b) => a.localeCompare(b));
    },
    async addListValue(kind, v) {
      v = String(v || "").trim(); if (!v) return;
      if (this.list(kind).some((x) => U(x) === U(v))) return;
      this.devLists[kind].push(v); await this.kvSet("devLists", this.devLists);
    },
    descForFinal(code) { const l = this.byFinal.get(U(code)); return l ? `${l.row[1]} ${l.row[2]}`.trim() : null; },
    facilityLocs(fac) { return this.locs.filter((l) => l.row[4] === fac).sort((a, b) => a.row[14].localeCompare(b.row[14])); },
    facilityAssets(fac) { return this.assets.filter((a) => a.row[41] === fac); },

    async addLocation(row) {
      const rec = { key: U(row[0]), row, origin: 1, exported: false, createdAt: Date.now() };
      await this.tx(["locs"], "readwrite", (t) => t.objectStore("locs").put(rec));
      this.locs.push(rec); this.reindex(); return rec;
    },
    async addAsset(row, photo) {
      const rec = { key: U(row[0]), row, origin: 1, exported: false, createdAt: Date.now(), hasPhoto: !!photo };
      await this.tx(["assets", "photos"], "readwrite", (t) => { t.objectStore("assets").put(rec); if (photo) t.objectStore("photos").put(photo, rec.key); });
      if (photo && !this.db) this.photoMem.set(rec.key, photo);
      this.assets.push(rec); this.reindex(); return rec;
    },
    async deleteLocation(rec) { await this.tx(["locs"], "readwrite", (t) => t.objectStore("locs").delete(rec.key)); this.locs = this.locs.filter((x) => x !== rec); this.reindex(); },
    async deleteAsset(rec) {
      await this.tx(["assets", "photos"], "readwrite", (t) => { t.objectStore("assets").delete(rec.key); t.objectStore("photos").delete(rec.key); });
      this.photoMem.delete(rec.key); this.assets = this.assets.filter((x) => x !== rec); this.reindex();
    },
    async photo(key) {
      if (!this.db) return this.photoMem.get(key) || null;
      const t = this.db.transaction(["photos"]); return (await this.req(t.objectStore("photos").get(key))) || null;
    },
    async markExported(locs, assets, changes = []) {
      for (const r of [...locs, ...assets, ...changes]) r.exported = true;
      await this.tx(["locs", "assets", "kv"], "readwrite", (t) => { locs.forEach((r) => t.objectStore("locs").put(r)); assets.forEach((r) => t.objectStore("assets").put(r)); t.objectStore("kv").put(this.changes, "changes"); });
    },
    /** Transfer or dispose (admin). The asset row is updated at once; the change is exported for ImportFromApp. */
    async recordChange(type, rec, data) {
      const s = this.session; const date = data.date || today();
      const ch = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase(), type, etag: rec.row[0], date,
        fromFl: rec.row[8], fromCode: rec.row[9], toFl: "", toCode: "", reason: data.reason, ref: data.ref || "", remarks: data.remarks || "",
        user: s.user, recorded: `${today()} ${hhmmNow()}`, ts: Date.now(), exported: false };
      if (type === "TRANSFER") {
        const to = this.ref(this.byFl.get(U(data.toFl)));
        ch.toFl = to.fl; ch.toCode = to.finalCode;
        rec.row = L.applyTransfer(rec.row, to, s.user, date, (c) => this.descForFinal(c));
      } else rec.row = L.applyDispose(rec.row, s.user, date);
      rec.changed = true;
      this.changes.push(ch);
      await this.tx(["assets", "kv"], "readwrite", (t) => { t.objectStore("assets").put(rec); t.objectStore("kv").put(this.changes, "changes"); });
      return ch;
    },
    changesFor(etag) { return this.changes.filter((c) => U(c.etag) === U(etag)).sort((a, b) => a.ts - b.ts); },

    /** Same rules as the Android Db.importMaster. */
    async importMaster(json) {
      if (!json || !Array.isArray(json.locClasses) || !Array.isArray(json.locations) || !Array.isArray(json.assets))
        throw new Error("This file is not an Asset Record master file (from ExportMasterForApp).");
      const norm = (r, n) => Array.from({ length: n }, (_, i) => (r[i] == null ? "" : String(r[i])));
      const devLocs = new Map(this.locs.filter((l) => l.origin === 1).map((l) => [l.key, l]));
      const devAssets = new Map(this.assets.filter((a) => a.origin === 1).map((a) => [a.key, a]));
      let syncedL = 0, syncedA = 0; const conflicts = [];
      const locs = [];
      for (const raw of json.locations) {
        const row = norm(raw, 17); if (!row[0].trim()) continue; const key = U(row[0]);
        const d = devLocs.get(key);
        if (d) { syncedL++; if (U(d.row[14]) !== U(row[14])) conflicts.push(`Location ${row[0]}: phone code ${d.row[14]} vs workbook ${row[14]} (workbook kept)`); devLocs.delete(key); }
        locs.push({ key, row, origin: 0, exported: true, createdAt: 0 });
      }
      const wbFinal = new Map(locs.map((l) => [U(l.row[14]), l.row[0]]));
      for (const d of devLocs.values()) {
        const other = wbFinal.get(U(d.row[14]));
        if (other && U(other) !== d.key) conflicts.push(`Location ${d.row[0]}: code ${d.row[14]} is already used by ${other} in the workbook`);
        locs.push(d);
      }
      const assets = [];
      for (const raw of json.assets) {
        const row = norm(raw, 45); if (!row[0].trim()) continue; const key = U(row[0]);
        const d = devAssets.get(key);
        if (d) { syncedA++; devAssets.delete(key); }
        assets.push({ key, row, origin: 0, exported: true, createdAt: 0, hasPhoto: d ? d.hasPhoto : false });
      }
      for (const d of devAssets.values()) assets.push(d);
      // Re-apply transfers/disposals the workbook does not show yet; drop the ones it already contains.
      const byKey = new Map(assets.map((x) => [x.key, x])); let syncedC = 0; const keep = [];
      const fin = new Map(locs.map((l) => [U(l.row[14]), l]));
      const descOf = (c) => { const l = fin.get(U(c)); return l ? `${l.row[1]} ${l.row[2]}`.trim() : ""; };
      const groups = new Map();
      for (const ch of this.changes) { const k = U(ch.etag) + "|" + ch.type; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ch); }
      for (const list of groups.values()) {
        list.sort((x, y) => x.ts - y.ts); const latest = list[list.length - 1]; const a = byKey.get(U(latest.etag));
        if (a && a.origin === 0 && list.every((c) => c.exported) && L.isReflected(latest, a.row)) { syncedC += list.length; continue; }
        keep.push(...list);
        if (!a || L.isReflected(latest, a.row)) continue;
        if (latest.type === "TRANSFER") {
          const to = locs.find((l) => l.key === U(latest.toFl));
          if (to) { a.row = L.applyTransfer(a.row, { fl: to.row[0], finalCode: to.row[14] }, latest.user, latest.date, descOf); a.changed = true; }
        } else { a.row = L.applyDispose(a.row, latest.user, latest.date); a.changed = true; }
      }
      this.changes = keep;
      const master = { version: String(json.version || ""), users: json.users || [], facilities: json.facilities || [],
        locClasses: json.locClasses, assetTypes: json.assetTypes || [], units: json.units || [], manufacturers: json.manufacturers || [],
        models: json.models || [], receivedFrom: json.receivedFrom || [], demo: !!json.demo };
      await this.tx(["kv", "locs", "assets"], "readwrite", (t) => {
        t.objectStore("kv").put(master, "master"); t.objectStore("kv").put(keep, "changes");
        const ls = t.objectStore("locs"), as = t.objectStore("assets"); ls.clear(); as.clear();
        locs.forEach((r) => ls.put(r)); assets.forEach((r) => as.put(r));
      });
      this.master = master; this.locs = locs; this.assets = assets; this.reindex();
      return { version: master.version, locations: json.locations.length, assets: json.assets.length, syncedL, syncedA, syncedC, conflicts };
    },
  };

  /** Admin = may create, transfer, dispose. Viewers only browse. */
  const canEdit = () => !Store.session || Store.session.role !== "Viewer";

  // ------------------------------------------------------------------ UI primitives
  const stack = [];
  function go(view, ...args) { stack.push([view, args]); view(...args); window.scrollTo(0, 0); }
  function back() { stack.pop(); const top = stack[stack.length - 1]; if (top) { top[0](...top[1]); window.scrollTo(0, 0); } }
  function home() { stack.length = 0; go(viewHome); }

  function screen(title, { backBtn = true, chip = true } = {}, ...content) {
    app.replaceChildren(...[
      h("header", { class: "bar" },
        backBtn ? h("button", { class: "back", "aria-label": "Back", onclick: back, text: "‹" }) : h("span", { class: "logo", text: "AR" }),
        h("h1", { text: title }),
        chip && Store.session ? h("span", { class: "chip", text: Store.session.facility }) : null,
        Store.session ? h("span", { class: "avatar", title: Store.session.user, text: Store.session.user.slice(0, 2).toUpperCase() }) : null),
      Store.memoryOnly ? h("main", { style: "padding-bottom:0" }, h("div", { class: "banner", text: "This browser is blocking storage, so records are kept only until you close the page. Export before closing." })) : null,
      h("main", null, ...content)].filter(Boolean));
  }
  function actions(...btns) { app.append(h("div", { class: "actions" }, h("div", null, ...btns))); }
  function field(label, control, opts = {}) {
    return h("label", { class: "field" + (opts.full ? " full" : "") }, h("span", null, label, opts.req ? h("b", { text: " *" }) : null), control, opts.hint || null);
  }
  const input = (props = {}) => h("input", { class: "input", ...props });
  const select = (items, value) => { const s = h("select", { class: "input" }, items.map(([v, t]) => h("option", { value: v, text: t }))); if (value != null) s.value = value; return s; };
  const dateInput = (dmyVal) => { const i = input({ type: "date" }); i.value = dmyToIso(dmyVal); return i; };
  const btn = (text, onclick, kind = "") => h("button", { class: "btn " + kind, type: "button", text, onclick });

  function toast(msg) {
    const t = h("div", { class: "toast", role: "status", text: msg }); document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  /** In-page dialog (the artifact viewer suppresses alert/confirm). Resolves with the clicked button's value. */
  function modal(title, body, buttons = [["OK", true, ""]]) {
    return new Promise((resolve) => {
      const close = (v) => { bg.remove(); resolve(v); };
      const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) close(null); } },
        h("div", { class: "modal", role: "dialog", "aria-modal": "true" },
          h("h3", { text: title }),
          h("div", { class: "mbody" }, typeof body === "string" ? h("p", { text: body }) : body),
          h("div", { class: "mfoot" }, buttons.map(([t, v, kind]) => btn(t, () => close(v), kind)))));
      document.body.append(bg);
      const first = bg.querySelector("button"); first && first.focus();
    });
  }

  /**
   * Searchable picker (replaces MSForms ComboBox). options(): [{value,label,sub}]
   * free: allow typed values (manufacturer, model…).
   */
  function picker({ label, options, value = "", display, placeholder = "Tap to choose", free = false, req = false, onChange, full }) {
    let cur = value;
    const v = h("span", { class: "v" });
    const button = h("button", { class: "pick", type: "button", onclick: open }, v);
    const show = () => {
      const d = cur ? (display ? display(cur) : cur) : "";
      v.textContent = d || placeholder; v.classList.toggle("ph", !d);
    };
    function open() {
      const all = options();
      const q = input({ type: "search", placeholder: free ? "Search or type a new value" : "Search…", autocomplete: "off", enterkeyhint: "done" });
      const list = h("div", { class: "opts" });
      const choose = (val) => { cur = val; show(); bg.remove(); onChange && onChange(cur); };
      const render = () => {
        const term = q.value.trim().toLowerCase(); const words = term.split(/\s+/).filter(Boolean);
        const hits = words.length ? all.filter((o) => { const hay = (o.label + " " + (o.sub || "") + " " + o.value).toLowerCase(); return words.every((w) => hay.includes(w)); }) : all;
        const kids = [];
        if (free && q.value.trim() && !all.some((o) => U(o.value) === U(q.value))) kids.push(h("button", { class: "opt free", type: "button", onclick: () => choose(q.value.trim()) }, h("span", { class: "l", text: `Use “${q.value.trim()}”` })));
        for (const o of hits.slice(0, 200)) kids.push(h("button", { class: "opt", type: "button", onclick: () => choose(o.value) }, h("span", { class: "l", text: o.label }), o.sub ? h("span", { class: "sub", text: o.sub }) : null));
        if (hits.length > 200) kids.push(h("div", { class: "more", text: `Showing 200 of ${hits.length}. Type more to narrow.` }));
        if (!kids.length) kids.push(h("div", { class: "more", text: "No match." }));
        list.replaceChildren(...kids);
      };
      q.addEventListener("input", render);
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { const f = list.querySelector(".opt"); f && f.click(); } });
      const bg = h("div", { class: "sheet-bg", onclick: (e) => { if (e.target === bg) bg.remove(); } },
        h("div", { class: "sheet", role: "dialog", "aria-label": label },
          h("header", null, h("div", null, h("strong", { text: label }),
            cur ? h("button", { type: "button", text: "Clear", onclick: () => choose("") }) : null,
            h("button", { type: "button", text: "Close", onclick: () => bg.remove() })), q), list));
      document.body.append(bg); render(); setTimeout(() => q.focus(), 50);
    }
    show();
    return { el: field(label, button, { req, full }), get value() { return cur; }, set(x) { cur = x || ""; show(); } };
  }

  function locOptions() {
    return Store.facilityLocs(Store.session.facility).map((l) => ({ value: l.row[0], label: `${l.row[0]}  ${l.row[1]} ${l.row[2]}`.trim(), sub: l.row[14] }));
  }
  const locDisplay = (fl) => { const l = Store.byFl.get(U(fl)); return l ? `${l.row[14]} · ${l.row[1]} ${l.row[2]}`.trim() : fl; };


  // ------------------------------------------------------------------ master file: Asset_Record.xlsm or master .json
  function loadXlsxLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    const tryLoad = (src) => new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = src; sc.onload = () => (window.XLSX ? res(window.XLSX) : rej(new Error("load"))); sc.onerror = () => { sc.remove(); rej(new Error("load")); }; document.head.append(sc); });
    return tryLoad("xlsx.full.min.js").catch(() => tryLoad("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"))
      .catch(() => { throw new Error("Could not load the Excel reader. Check the internet connection once, or use the .json from ExportMasterForApp."); });
  }
  let setBusy = () => {};
  async function readMasterFile(f, busy) {
    const buf = await f.arrayBuffer(); const head = new Uint8Array(buf.slice(0, 4));
    const isZip = head[0] === 0x50 && head[1] === 0x4B;             // "PK": xlsx/xlsm or a zip
    const name = (f.name || "").toLowerCase();
    if (isZip) {
      if (/\.zip$/.test(name)) throw new Error("This is a ZIP file. Pick Asset_Record.xlsm (or the master .json). Export ZIPs from this app go into Excel with the macro ImportFromApp.");
      busy("Reading workbook… this takes a few seconds");
      try {
        const XLSX = await loadXlsxLib();
        await new Promise((r) => setTimeout(r, 30));                  // let the busy text paint
        const d = new Date(); const ver = `${f.name} ${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        return L.masterFromSheets(window.ARXlsx.workbookSheets(XLSX, buf), ver);
      } finally { busy(""); }
    }
    if (head[0] === 0xD0 && head[1] === 0xCF) throw new Error("This is an old .xls file. Save the workbook as .xlsm and pick that.");
    let text = new TextDecoder("utf-8").decode(buf); if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try { return JSON.parse(text); } catch (e) { throw new Error("This file is not Asset_Record.xlsm or a master .json file."); }
  }

  // ------------------------------------------------------------------ views
  /** SAP Fiori logon layout: branded background, centred card, no shell bar. */
  function logon(...content) {
    app.replaceChildren(h("div", { class: "logon" },
      h("div", { class: "logon-card" },
        h("div", { class: "logon-brand" }, h("span", { class: "logo lg", text: "AR" }),
          h("div", null, h("div", { class: "logon-title", text: "Asset Record" }), h("div", { class: "logon-sub", text: "Asset & Functional Location Survey" }))),
        ...content),
      h("p", { class: "logon-foot", text: Store.master ? `Master data ${Store.master.version || "-"}${Store.master.demo ? " · demo" : ""} · works offline` : "Works offline on iPhone, Android and PC" })));
  }

  function viewSetup() {
    const msg = h("div", { class: "banner", hidden: true });
    const busyEl = h("div", { class: "banner info", hidden: true });
    setBusy = (t) => { busyEl.hidden = !t; busyEl.textContent = t; if (t) msg.hidden = true; };
    const file = h("input", { type: "file", hidden: true, onchange: async () => {
      const f = file.files[0]; if (!f) return;
      try { await Store.importMaster(await readMasterFile(f, setBusy)); toast("Master data loaded"); stack.length = 0; go(viewLogin); }
      catch (e) { msg.hidden = false; msg.textContent = e.message || String(e); }
      file.value = "";
    } });
    logon(
      h("h2", { class: "logon-h", text: "Load your data" }),
      h("p", { class: "lede", text: "Pick your Asset_Record.xlsm workbook (or the .json made by the macro ExportMasterForApp). The app copies users, facilities, Class&Units lists, locations and assets." }),
      msg, busyEl,
      btn("Pick Asset_Record.xlsm…", () => file.click()), file,
      h("div", { class: "logon-or" }, h("span", { text: "or" })),
      btn("Try demo data", async () => {
        await Store.importMaster(JSON.parse(document.getElementById("demo-master").textContent)); stack.length = 0; go(viewLogin);
      }, "ghost"),
      Store.master ? h("button", { class: "linkbtn", type: "button", text: "Back to sign in", onclick: () => { stack.length = 0; go(viewLogin); } }) : null);
  }

  function viewLogin() {
    const m = Store.master;
    const users = m.users || [];
    const userSel = select(users.map((u) => [u.name, u.name]), Store.lastUser || undefined);
    userSel.id = "lg-user";
    const id = input({ id: "lg-id", inputMode: "numeric", autocomplete: "username" });
    const pw = input({ id: "lg-pw", type: "password", autocomplete: "current-password", placeholder: "Password" });
    const eye = h("button", { class: "eye", type: "button", "aria-label": "Show password", text: "Show", onclick: () => {
      const show = pw.type === "password"; pw.type = show ? "text" : "password"; eye.textContent = show ? "Hide" : "Show";
    } });
    const fac = select([["", "Select facility"], ...(m.facilities || []).map((f) => [f.code, `${f.code} — ${String(f.name || "").trim()}`])], Store.lastFacility || "");
    fac.id = "lg-fac";
    const err = h("div", { class: "banner err", role: "alert", hidden: true });
    const fail = (t, el) => { err.textContent = t; err.hidden = false; el && el.focus(); };
    const fillId = () => { const u = users.find((x) => x.name === userSel.value); id.value = u ? u.id : ""; };   // CMB3_Change
    userSel.addEventListener("change", fillId); fillId();
    const login = async () => {
      err.hidden = true;
      const u = users.find((x) => x.name === userSel.value);
      if (!u) return fail("User not found.", userSel);
      if (String(u.id) !== id.value.trim()) return fail("Invalid ID.", id);
      if (String(u.password) !== pw.value) return fail("Invalid password.", pw);
      if (!fac.value) return fail("Please select a facility.", fac);
      const f = m.facilities.find((x) => x.code === fac.value);
      await Store.saveSession({ role: L.isAdmin(m.users, u.name) ? "Admin" : "Viewer", user: u.name, uid: u.id, facility: f.code, facilityName: String(f.name || "").trim(), lastSiteDate: (Store.session && Store.session.lastSiteDate) || "" });
      try { localStorage.setItem("ar.last", JSON.stringify({ user: u.name, fac: f.code })); } catch (e) {}
      home();
    };
    const form = h("form", { class: "logon-form", onsubmit: (e) => { e.preventDefault(); login(); } },
      h("h2", { class: "logon-h", text: "Log On" }),
      m.demo ? h("div", { class: "banner info", text: "Demo: user demo / password demo (Admin) or viewer / viewer (view only) · facility F99 DEMO" }) : null,
      err,
      field("User", userSel),
      field("ID", id),
      field("Password", h("div", { class: "pwrow" }, pw, eye)),
      field("Facility", fac),
      h("button", { class: "btn", type: "submit", text: "Log On" }));
    logon(form, h("button", { class: "linkbtn", type: "button", text: "Load a different master file", onclick: () => go(viewSetup) }));
    setTimeout(() => (users.length ? pw : userSel).focus(), 50);
  }

  function viewHome() {
    const s = Store.session; const fac = s.facility;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const fl = Store.facilityLocs(fac).length, fa = Store.facilityAssets(fac).length;
    const tl = Store.locs.filter((l) => l.origin === 1 && l.createdAt >= +start).length;
    const ta = Store.assets.filter((a) => a.origin === 1 && a.createdAt >= +start).length;
    const pl = Store.locs.filter((l) => l.origin === 1 && !l.exported).length;
    const pa = Store.assets.filter((a) => a.origin === 1 && !a.exported).length;
    const pc = Store.changes.filter((c) => !c.exported).length;
    const nDisp = Store.facilityAssets(fac).filter((a) => U(a.row[40]) === "DISPOSED").length;
    const admin = canEdit();
    // Fiori launchpad generic tiles
    const ICONS = {
      add: '<path d="M12 4v16M4 12h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
      tree: '<path d="M4 4h6v5H4zM14 10h6v5h-6zM14 17h6v4h-6zM7 9v10h7M7 12.5h7" stroke="currentColor" stroke-width="1.7" fill="none"/>',
      tag: '<path d="M3 12V4h8l10 10-8 8L3 12z" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="7.5" cy="8" r="1.6" fill="currentColor"/>',
      sync: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
      move: '<path d="M4 8h13l-3-3M20 16H7l3 3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      bin: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/>',
      user: '<circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M4 21c1-4.5 4-6.5 8-6.5s7 2 8 6.5" stroke="currentColor" stroke-width="1.7" fill="none"/>',
    };
    const icon = (k) => { const sp = h("span"); sp.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`; return sp.firstChild; };
    const tile = (title, sub, num, unit, ic, onclick, warn, foot) => h("button", { class: "gt", type: "button", onclick },
      h("span", { class: "gt-h", text: title }), h("span", { class: "gt-s", text: sub }),
      h("span", { class: "gt-f" }, icon(ic), num != null ? h("span", null, h("span", { class: "gt-n" + (warn ? " neg" : ""), text: num }), unit ? h("span", { class: "gt-u", text: " " + unit }) : null) : null),
      foot ? h("span", { class: "gt-foot", text: foot }) : null);
    const hr = new Date().getHours();
    const greet = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    const sec = (id, title, ...tiles) => h("section", { class: "lp-sec", id: "sp-" + id }, h("div", { class: "lp-group", text: title }), h("div", { class: "lp" }, ...tiles));
    screen("Asset Record", { backBtn: false },
      h("div", { class: "welcome" }, h("h2", { text: `${greet}, ${s.user}` }),
        h("span", { text: `${fac} · ${s.facilityName || "Facility"} · ${admin ? "Admin" : "View only"} · today ${tl} locations, ${ta} assets created` })),
      Store.master.demo ? h("div", { class: "banner info", text: "Demo data. Load your master file from Sync with Excel." }) : null,
      sec("master", "Asset Master Data",
        admin ? tile("Create Location", "Functional location", null, null, "add", () => go(viewLocForm, {}), false, "Auto LocationCodeFinal") : null,
        admin ? tile("Create Asset", "Equipment / Etag", null, null, "add", () => go(viewAssetForm, {}), false, "New Etag") : null,
        tile("Location Hierarchy", "Tree with assets", fl, "FL", "tree", () => go(viewTree), false, "Functional locations"),
        tile("Assets", "Equipment list", fa, "EQ", "tag", () => go(viewBrowse, "asset"), false, "Registered in facility")),
      admin ? sec("moves", "Asset Movements",
        tile("Transfer Asset", "Shift to another location", null, null, "move", () => go(viewBrowse, "asset", null, "move"), false, "Updates FL1–FL6"),
        tile("Dispose Asset", "Retire from register", nDisp, "disposed", "bin", () => go(viewBrowse, "asset", null, "disp"), false, "Status = Disposed")) : null,
      sec("sync", "Integration",
        admin ? tile("Sync with Excel", "Export / import workbook", pl + pa + pc, "to export", "sync", () => go(viewSync), pl + pa + pc > 0, "ImportFromApp")
              : tile("Refresh Data", "Load latest workbook", null, null, "sync", () => go(viewSync), false, "Asset_Record.xlsm"),
        tile("Change Facility", "Sign out", null, null, "user", async () => { await Store.saveSession(null); stack.length = 0; go(viewLogin); }, false, fac)),
      h("p", { class: "hint", text: `Master data version ${Store.master.version || "-"}${Store.master.demo ? " (demo)" : ""}` }));
    // SAP launchpad space tabs
    const tabs = [["master", "Asset Master Data"], ...(admin ? [["moves", "Asset Movements"]] : []), ["sync", "Integration"]];
    const nav = h("nav", { "aria-label": "Spaces" }, h("button", { type: "button", class: "on", text: "My Home", onclick: (e) => { window.scrollTo({ top: 0, behavior: "smooth" }); mark(e.target); } }),
      tabs.map(([id, t]) => h("button", { type: "button", text: t, onclick: (e) => { document.getElementById("sp-" + id).scrollIntoView({ behavior: "smooth" }); mark(e.target); } })));
    const mark = (el) => nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === el));
    app.insertBefore(h("div", { class: "spaces" }, nav), app.querySelector("main"));
  }

  // ---------------- new location (SaveLocationRow)
  // ---------------- "saved below the form" tables (sap.m.Table)
  const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return +d; };
  const statusOf = (r) => {
    if (r.row && r.row.length > 40 && U(r.row[40]) === "DISPOSED") return ["Disposed", "disp"];
    if (r.changed && Store.changesFor(r.row[0]).some((c) => !c.exported)) return ["Changed", "new"];
    return r.origin === 0 ? ["Workbook", ""] : r.exported ? ["Exported", "exp"] : ["New", "new"];
  };
  /**
   * Table under an entry form. scopes: [{id,label,rows:()=>[]}], cols: [{h, v:(r)=>text, cls}].
   * Newest first; the just-saved record is highlighted; clicking a row opens it.
   */
  function savedTable({ title, scopes, cols, open, highlight, scopeId }) {
    let cur = scopeId && scopes.find((x) => x.id === scopeId) ? scopeId : scopes[0].id;
    const head = h("div", { class: "tbl-head" });
    const wrap = h("div", { class: "tbl-wrap" });
    function render() {
      const sc = scopes.find((x) => x.id === cur); const rows = sc.rows();
      head.replaceChildren(h("strong", { text: `${title} (${rows.length})` }),
        h("div", { class: "seg", role: "tablist" }, scopes.map((x) => h("button", { type: "button", role: "tab", "aria-selected": String(x.id === cur), class: x.id === cur ? "on" : "", text: x.label, onclick: () => { cur = x.id; render(); } }))));
      if (!rows.length) { wrap.replaceChildren(h("div", { class: "empty", text: sc.empty || "Nothing saved yet. Records appear here as soon as you save them." })); return; }
      wrap.replaceChildren(h("table", { class: "tbl" },
        h("thead", null, h("tr", null, cols.map((c) => h("th", { class: c.cls || "", text: c.h })))),
        h("tbody", null, rows.slice(0, 200).map((r) => h("tr", { class: r.key === highlight ? "hl" : "", tabindex: "0", onclick: () => open(r), onkeydown: (e) => { if (e.key === "Enter") open(r); } },
          cols.map((c) => { const v = c.v(r); return h("td", { class: c.cls || "" }, v && v.nodeType ? v : String(v == null ? "" : v)); }))))));
    }
    render();
    return { el: h("section", { class: "tbl-card" }, head, wrap), refresh: render };
  }
  const statusCell = (r) => { const [t, c] = statusOf(r); return h("span", { class: "badge " + c, text: t }); };

  // ---------------- new location (SaveLocationRow)
  function viewLocForm({ parentFl = "", keep = true, highlight = "", scope = "" }) {
    const s = Store.session;
    const fl = input({ autocapitalize: "characters", autocomplete: "off" });
    fl.value = L.nextFlCode(Store.locs.map((l) => l.row[0]));
    const local = input({ placeholder: "e.g. BLD0213 - CPP - New LV Room", autocomplete: "off" });
    const plate = h("div", { class: "plate" });
    const keepChk = h("input", { type: "checkbox", checked: keep });
    const desc = picker({ label: "Location Description", req: true, options: () => Store.master.locClasses.map((c) => ({ value: c.name, label: c.name, sub: `${c.cls} · ${c.locCode}/${c.secondCode}` })), onChange: refresh });
    const parent = picker({ label: "Parent Location", req: true, value: parentFl, options: locOptions, display: locDisplay, onChange: () => { refresh(); table.refresh(); }, full: true });
    const keepRow = h("label", { class: "check full" }, keepChk, "Keep parent for the next location (untick to drill down into the new one)");
    fl.addEventListener("input", refresh);

    function gen() { const cls = desc.value ? Store.locClass(desc.value) : null; return [L.buildLocation(Store.index, fl.value, desc.value, cls, parent.value, s.facility), cls]; }
    function refresh() {
      const cls = desc.value ? Store.locClass(desc.value) : null;
      const isFac = !!desc.value && L.isFacilityClass(desc.value, cls);
      parent.el.hidden = isFac; keepRow.hidden = isFac;
      if (!desc.value) { plate.className = "plate"; plate.replaceChildren(h("small", { text: "LocationCodeFinal" }), h("span", { class: "meta", text: "Choose a description to see the new code." })); return; }
      const [g] = gen();
      if (g.ok) { plate.className = "plate"; plate.replaceChildren(h("small", { text: "New LocationCodeFinal" }), h("code", { text: g.finalCode }), h("span", { class: "meta", text: `Level ${g.level} · sequence ${g.seq}${cls ? ` · ${cls.cls}` : ""}` })); }
      else { plate.className = "plate err"; plate.replaceChildren(h("small", { text: "Cannot create yet" }), h("code", { text: g.error })); }
    }
    async function save() {
      const [g, cls] = gen();
      if (!g.ok) return modal("Cannot save", g.error);
      const row = L.locationRow(fl.value, cls.name, local.value, parent.value, s.facility, s.user, today(), cls, g);
      await Store.addLocation(row);
      toast(`Saved ${row[0]} · ${g.finalCode}`);
      const next = keepChk.checked && !g.isFacility ? parent.value : row[0];
      stack.pop(); go(viewLocForm, { parentFl: next, keep: keepChk.checked, highlight: U(row[0]), scope: table ? curScope() : "" });
    }
    const facLocs = () => Store.facilityLocs(s.facility);
    const table = savedTable({
      title: "Saved locations", highlight, scopeId: scope,
      scopes: [
        { id: "today", label: "Saved today", rows: () => facLocs().filter((l) => l.origin === 1 && l.createdAt >= startOfToday()).sort((a, b) => b.createdAt - a.createdAt) },
        { id: "parent", label: "Under selected parent", empty: "Pick a parent location to see what is already under it.",
          rows: () => { const p = Store.byFl.get(U(parent.value)); return p ? facLocs().filter((l) => U(l.row[12]) === U(p.row[14])).sort((a, b) => a.row[14].localeCompare(b.row[14])) : []; } },
        { id: "device", label: "All on this device", rows: () => Store.locs.filter((l) => l.origin === 1).sort((a, b) => b.createdAt - a.createdAt) },
      ],
      cols: [
        { h: "FL Code", v: (r) => r.row[0] },
        { h: "LocationCodeFinal", v: (r) => r.row[14], cls: "code" },
        { h: "Description", v: (r) => r.row[1] },
        { h: "Local ID", v: (r) => r.row[2], cls: "c-opt" },
        { h: "Level", v: (r) => r.row[16], cls: "c-opt num" },
        { h: "Status", v: statusCell },
        { h: "Time", v: (r) => (r.createdAt ? hhmm(r.createdAt) : r.row[6]), cls: "c-opt" },
      ],
      open: (r) => locDetail(r),
    });
    const curScope = () => table.el.querySelector(".seg .on") ? scopeIdByLabel(table.el.querySelector(".seg .on").textContent) : "";
    const scopeIdByLabel = (t) => ({ "Saved today": "today", "Under selected parent": "parent", "All on this device": "device" })[t] || "";

    screen("New location", {},
      h("section", { class: "card form wide" },
        h("div", { class: "grp", text: "Location entry" }),
        field("FL Code", fl, { req: true, hint: h("span", { class: "hint", text: "Next free F-number. Change it if you use pre-printed tags." }) }),
        desc.el, field("Local ID / Name", local, { full: false }),
        parent.el, keepRow, plate),
      table.el);
    actions(btn("Save location", save));
    refresh();
    if (highlight) setTimeout(() => desc.el.querySelector("button").focus(), 50);
  }

  // ---------------- new asset (CMD_SAVE_ASSET_Click / WriteAssetDataToRow)
  function viewAssetForm({ flCode = "", carry = {}, highlight = "", scope = "" }) {
    const s = Store.session;
    let photoBlob = null;
    const prefix = select(L.ASSET_PREFIXES.map(([c, n]) => [c, `${c} — ${n}`]), carry.prefix || "EQP");
    const num = input({ inputMode: "numeric", autocomplete: "off", placeholder: "e.g. 105507", value: carry.next || "" });
    const tagHint = h("span", { class: "hint" });
    const classHint = h("span", { class: "hint" });
    const desc = picker({ label: "Etag Description", req: true, free: true, options: () => Store.master.assetTypes.map((t) => ({ value: t.name, label: t.name, sub: `${t.systemCode} · ${t.category}` })), onChange: updClass });
    const extra = input({ placeholder: "Added to TechDesc, e.g. 16 or North", autocomplete: "off" });
    const loc = picker({ label: "Functional Location", req: true, value: flCode, options: locOptions, display: locDisplay, full: true, onChange: () => table.refresh() });
    const listPick = (label, kind, upper) => picker({ label, free: true, options: () => Store.list(kind).map((v) => ({ value: upper ? v.toUpperCase() : v, label: v })) });
    const mfg = listPick("Manufacturer", "manufacturer", true), model = listPick("Model number", "model", true);
    const serial = input({ autocomplete: "off" });
    const recv = listPick("Received From", "received"); recv.set(carry.received || "");
    const qty = input({ inputMode: "numeric", value: "1" });
    const unit = listPick("Capacity unit", "unit");
    const cap = input({ inputMode: "decimal" });
    const cond = select(L.CONDITIONS.map((c) => [c, c]), carry.condition || "Good");
    const kind = select(L.ASSET_OR_ITEM.map((c) => [c, c]), "Asset");
    const acq = dateInput(""), valid = dateInput(L.DEFAULT_VALID_TO), acqVal = input({ inputMode: "decimal" });
    const purch = input(), repl = input(), supplier = input();
    const wrty = select([["", "Select"], ["Yes", "Yes"], ["No", "No"]], carry.warranty || "");
    const wStart = dateInput(""), wEnd = dateInput("");
    const site = dateInput(carry.site || s.lastSiteDate || today());
    const img = h("img", { class: "photo", alt: "Asset photo", hidden: true });
    const photoIn = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: async () => {
      const f = photoIn.files[0]; if (!f) return;
      try { photoBlob = await shrink(f); img.src = URL.createObjectURL(photoBlob); img.hidden = false; photoBtn.textContent = "Retake photo"; }
      catch (e) { modal("Photo", "Could not read that image."); }
      photoIn.value = "";
    } });
    const photoBtn = btn("Take photo", () => { if (!num.value.trim()) return modal("Photo", "Enter the Etag number first. The photo is saved as <Etag>.jpg."); photoIn.click(); }, "ghost");

    const tag = () => prefix.value + num.value.trim();
    function updTag() {
      if (!num.value.trim()) { tagHint.textContent = ""; return; }
      const exists = Store.byEtag.has(U(tag()));
      tagHint.textContent = exists ? `${tag()} already exists` : `${tag()} is free`; tagHint.className = "hint " + (exists ? "bad" : "ok");
    }
    function updClass() {
      if (!desc.value) { classHint.textContent = ""; return; }
      const t = Store.assetType(desc.value);
      classHint.textContent = t ? `${t.system} (${t.systemCode}) · ${t.category} (${t.categoryCode})` : "Not in Class&Units: SS Code NCA, Class not assigned";
      classHint.className = "hint " + (t ? "ok" : "bad");
    }
    num.addEventListener("input", updTag); prefix.addEventListener("change", updTag);

    async function save() {
      const a = { prefix: prefix.value, number: num.value, description: desc.value, extraDesc: extra.value, manufacturer: mfg.value, model: model.value,
        serial: serial.value, receivedFrom: recv.value, flCode: loc.value, qty: qty.value, acqDate: isoToDmy(acq.value), validTo: isoToDmy(valid.value),
        acqValue: acqVal.value, capacityUnit: unit.value, capacityValue: cap.value, condition: cond.value, assetOrItem: kind.value,
        purchDoc: purch.value, replFor: repl.value, warranty: wrty.value, warrantyStart: isoToDmy(wStart.value), warrantyEnd: isoToDmy(wEnd.value),
        supplier: supplier.value, siteVisitDate: isoToDmy(site.value), hasPhoto: !!photoBlob };
      const err = L.validateAsset(a, (t) => Store.byEtag.has(U(t)), (f) => Store.byFl.has(U(f)));
      if (err) return modal("Cannot save", err);
      const location = Store.ref(Store.byFl.get(U(a.flCode)));
      const row = L.assetRow(a, Store.assetType(a.description), location, s.facility, s.user, today(), (c) => Store.descForFinal(c));
      await Store.addAsset(row, photoBlob);
      // SaveComboValues
      await Store.addListValue("manufacturer", row[2]); await Store.addListValue("model", row[3]);
      await Store.addListValue("received", row[7]); await Store.addListValue("unit", row[14]);
      await Store.saveSession({ ...s, lastSiteDate: a.siteVisitDate });
      const n = a.number.trim(); let next = "";
      if (/^\d+$/.test(n)) { next = String(Number(n) + 1).padStart(n.length, "0"); if (Store.byEtag.has(U(a.prefix + next))) next = ""; }
      toast(`Saved ${row[0]} · ${row[1]}`);
      stack.pop();
      go(viewAssetForm, { flCode: a.flCode, highlight: U(row[0]), scope: curScope(),
        carry: { prefix: a.prefix, next, received: a.receivedFrom, site: a.siteVisitDate, condition: a.condition, warranty: a.warranty } });
      setTimeout(() => { const el = document.querySelector("#asset-num"); el && el.focus(); }, 60);
    }

    const table = savedTable({
      title: "Saved assets", highlight, scopeId: scope,
      scopes: [
        { id: "today", label: "Saved today", rows: () => Store.facilityAssets(s.facility).filter((a) => a.origin === 1 && a.createdAt >= startOfToday()).sort((x, y) => y.createdAt - x.createdAt) },
        { id: "loc", label: "At this location", empty: "Pick a functional location to see the assets already there.",
          rows: () => (loc.value ? Store.facilityAssets(s.facility).filter((a) => U(a.row[8]) === U(loc.value)).sort((x, y) => (y.createdAt - x.createdAt) || x.row[0].localeCompare(y.row[0])) : []) },
        { id: "device", label: "All on this device", rows: () => Store.assets.filter((a) => a.origin === 1).sort((x, y) => y.createdAt - x.createdAt) },
      ],
      cols: [
        { h: "Etag", v: (r) => r.row[0], cls: "code" },
        { h: "Description", v: (r) => r.row[1] },
        { h: "Functional Location", v: (r) => r.row[9], cls: "c-opt" },
        { h: "Manufacturer", v: (r) => r.row[2], cls: "c-opt" },
        { h: "Model", v: (r) => r.row[3], cls: "c-opt" },
        { h: "Cond.", v: (r) => r.row[21], cls: "c-opt" },
        { h: "Photo", v: (r) => (r.hasPhoto ? "Yes" : ""), cls: "c-opt" },
        { h: "Status", v: statusCell },
        { h: "Time", v: (r) => (r.createdAt ? hhmm(r.createdAt) : r.row[19]), cls: "c-opt" },
      ],
      open: (r) => assetDetail(r),
    });
    const curScope = () => { const on = table.el.querySelector(".seg .on"); return on ? ({ "Saved today": "today", "At this location": "loc", "All on this device": "device" })[on.textContent] : ""; };
    num.id = "asset-num";

    screen("New asset", {},
      h("section", { class: "card form wide" },
        h("div", { class: "grp", text: "Tag" }),
        field("Asset Prefix", prefix, { req: true }), field("Etag number", num, { req: true, hint: tagHint }),
        h("div", { class: "w2" }, desc.el, classHint), field("Additional description", extra, { full: true }),
        h("div", { class: "grp", text: "Location" }),
        loc.el,
        h("div", { class: "grp", text: "Make & condition" }),
        mfg.el, model.el, field("Serial number", serial), recv.el,
        field("Quantity", qty), unit.el, field("Capacity value", cap), field("Equipment condition", cond),
        field("Asset / Item", kind), field("Site visit date (CrtdOn)", site, { req: true }),
        h("div", { class: "grp", text: "Purchase & warranty" }),
        field("Vendor warranty", wrty, { req: true }), field("Warranty start", wStart), field("Warranty end", wEnd), field("Supplier", supplier),
        field("Acquisition date", acq), field("Valid to", valid), field("Acquisition value", acqVal), field("Purchase document", purch),
        field("Replacement for", repl),
        h("div", { class: "grp", text: "Photo" }),
        h("div", { class: "btns" }, photoBtn), img, photoIn),
      table.el);
    actions(btn("Save asset", save));
    updTag(); updClass();
  }

  /** Downscale a camera photo to max 1600px JPEG to keep storage small. */
  function shrink(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.82);
      };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode")); };
      im.src = url;
    });
  }

  // ---------------- hierarchy tree (USF3 TreeView: locations with their assets as leaves)
  const treeOpen = new Set();
  function viewTree() {
    const fac = Store.session.facility;
    const locs = Store.facilityLocs(fac);
    const inFac = new Set(locs.map((l) => U(l.row[14])));
    const kids = new Map(); const roots = [];
    for (const l of locs) {
      const p = U(l.row[12]);
      if (!p || !inFac.has(p)) roots.push(l);
      else { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(l); }
    }
    const byFl = new Map();
    for (const a of Store.facilityAssets(fac)) { const k = U(a.row[8]); if (!byFl.has(k)) byFl.set(k, []); byFl.get(k).push(a); }
    const subtreeAssets = new Map();
    const countAll = (l) => {
      const k = U(l.row[14]); if (subtreeAssets.has(k)) return subtreeAssets.get(k);
      let n = (byFl.get(l.key) || []).length; for (const c of kids.get(k) || []) n += countAll(c);
      subtreeAssets.set(k, n); return n;
    };
    if (!treeOpen.size) roots.forEach((r) => treeOpen.add(r.key));

    const q = input({ type: "search", placeholder: "Search code, FL, name, Etag", autocomplete: "off" });
    const box = h("div", { class: "tree", role: "tree" });
    const count = h("p", { class: "hint" });
    const badge = (r) => { const [t, c] = statusOf(r); return t === "Workbook" ? null : h("span", { class: "badge " + c, text: t.toLowerCase() }); };

    function nodeRow(l, depth) {
      const k = U(l.row[14]); const ch = kids.get(k) || []; const as = byFl.get(l.key) || [];
      const open = treeOpen.has(l.key); const has = ch.length + as.length > 0;
      const row = h("div", { class: "tn", role: "treeitem", "aria-expanded": has ? String(open) : null, style: `--d:${depth}` },
        h("button", { class: "tw" + (has ? "" : " leaf"), type: "button", "aria-label": open ? "Collapse" : "Expand", text: has ? (open ? "▾" : "▸") : "",
          onclick: () => { if (!has) return; open ? treeOpen.delete(l.key) : treeOpen.add(l.key); render(); } }),
        h("button", { class: "tl", type: "button", onclick: () => locDetail(l) },
          h("span", { class: "tc" }, L.ownSuffix(l.row[14]), badge(l)),
          h("span", { class: "td", text: `${l.row[1]} ${l.row[2]}`.trim() }),
          h("span", { class: "tf", text: l.row[0] })),
        countAll(l) ? h("span", { class: "tcount", title: "Assets in this branch", text: countAll(l) }) : null);
      const out = [row];
      if (open) {
        ch.sort((a, b) => a.row[14].localeCompare(b.row[14])).forEach((c) => out.push(...nodeRow(c, depth + 1)));
        as.sort((a, b) => a.row[0].localeCompare(b.row[0])).forEach((a) => out.push(
          h("div", { class: "tn asset", role: "treeitem", style: `--d:${depth + 1}` }, h("span", { class: "tw leaf" }),
            h("button", { class: "tl", type: "button", onclick: () => assetDetail(a) },
              h("span", { class: "tc" }, a.row[0], badge(a)), h("span", { class: "td", text: a.row[1] })))));
      }
      return out;
    }
    function render() {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) {
        const rows = []; roots.sort((a, b) => a.row[14].localeCompare(b.row[14])).forEach((r) => rows.push(...nodeRow(r, 0)));
        count.textContent = `${locs.length} locations · ${Store.facilityAssets(fac).length} assets`;
        box.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty", text: "No locations yet. Start with Create Location → Facility." })]));
        return;
      }
      // search: matching locations and assets, shown with their full path; tap opens them
      const hitL = locs.filter((l) => { const t = [l.row[0], l.row[1], l.row[2], l.row[14]].join(" ").toLowerCase(); return words.every((w) => t.includes(w)); });
      const hitA = Store.facilityAssets(fac).filter((a) => { const t = [a.row[0], a.row[1]].join(" ").toLowerCase(); return words.every((w) => t.includes(w)); });
      count.textContent = `${hitL.length} locations · ${hitA.length} assets match`;
      const rows = [
        ...hitL.slice(0, 150).map((l) => h("div", { class: "tn", style: "--d:0" }, h("span", { class: "tw leaf" }),
          h("button", { class: "tl", type: "button", onclick: () => { revealPath(l); q.value = ""; render(); } },
            h("span", { class: "tc" }, l.row[14], badge(l)), h("span", { class: "td", text: `${l.row[0]} · ${l.row[1]} ${l.row[2]}` })))),
        ...hitA.slice(0, 150).map((a) => h("div", { class: "tn asset", style: "--d:0" }, h("span", { class: "tw leaf" }),
          h("button", { class: "tl", type: "button", onclick: () => assetDetail(a) },
            h("span", { class: "tc" }, a.row[0], badge(a)), h("span", { class: "td", text: `${a.row[1]} · ${a.row[9]}` }))))];
      box.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty", text: "No match." })]));
    }
    /** Open every ancestor so the location becomes visible in the tree, then scroll to it. */
    function revealPath(l) {
      for (const code of L.partialCodes(l.row[14])) { const a = Store.byFinal.get(U(code)); if (a) treeOpen.add(a.key); }
      setTimeout(() => { const el = [...box.querySelectorAll(".tf")].find((e) => e.textContent === l.row[0]); el && el.closest(".tn").scrollIntoView({ block: "center" }); el && el.closest(".tn").classList.add("hl"); }, 30);
    }
    q.addEventListener("input", render);
    screen("Location Hierarchy", {},
      h("div", { class: "search" }, q),
      h("div", { class: "tree-tools" }, count,
        h("button", { class: "linkbtn", type: "button", text: "Expand all", onclick: () => { locs.forEach((l) => treeOpen.add(l.key)); render(); } }),
        h("button", { class: "linkbtn", type: "button", text: "Collapse all", onclick: () => { treeOpen.clear(); roots.forEach((r) => treeOpen.add(r.key)); render(); } })),
      box);
    if (canEdit()) actions(btn("Create location", () => go(viewLocForm, {})));
    render();
  }

  // ---------------- browse
  function viewBrowse(mode, flFilter, action) {
    const fac = Store.session.facility;
    const q = input({ type: "search", placeholder: mode === "loc" ? "Search code, FL, name" : "Search tag, description, code", autocomplete: "off" });
    const count = h("p", { class: "hint" });
    const list = h("div", { class: "list" });
    const badge = (r) => { const [t, c] = statusOf(r); return t === "Workbook" ? null : h("span", { class: "badge " + c, text: t.toLowerCase() }); };
    function render() {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      const src = mode === "loc" ? Store.facilityLocs(fac) : Store.facilityAssets(fac).filter((a) => !flFilter || U(a.row[8]) === U(flFilter)).sort((a, b) => (a.row[9] + a.row[0]).localeCompare(b.row[9] + b.row[0]));
      const hits = words.length ? src.filter((r) => { const hay = (mode === "loc" ? [r.row[0], r.row[1], r.row[2], r.row[14]] : [r.row[0], r.row[1], r.row[9]]).join(" ").toLowerCase(); return words.every((w) => hay.includes(w)); }) : src;
      count.textContent = `${hits.length} of ${src.length}`;
      const items = hits.slice(0, 300).map((r) => mode === "loc"
        ? h("button", { class: "item", type: "button", onclick: () => locDetail(r) }, h("span", { class: "t" }, r.row[14], badge(r)), h("span", { class: "s", text: `${r.row[0]} · ${r.row[1]} ${r.row[2]}`.trim() }))
        : h("button", { class: "item", type: "button", onclick: async () => {
            if (!action) return assetDetail(r);
            if (U(r.row[40]) === "DISPOSED") return modal("Already disposed", `${r.row[0]} is disposed and cannot be ${action === "move" ? "transferred" : "disposed again"}.`);
            if (await (action === "move" ? transferDialog : disposeDialog)(r)) render();
          } }, h("span", { class: "t" }, r.row[0], badge(r)), h("span", { class: "s", text: `${r.row[1]} · ${r.row[9]}` })));
      if (hits.length > 300) items.push(h("div", { class: "more", text: "Showing 300. Search to narrow." }));
      list.replaceChildren(...(items.length ? items : [h("div", { class: "empty", text: "Nothing here yet." })]));
    }
    q.addEventListener("input", render);
    screen(action === "move" ? "Transfer Asset" : action === "disp" ? "Dispose Asset" : mode === "loc" ? "Locations" : flFilter ? `Assets at ${flFilter}` : "Assets", {},
      action ? h("div", { class: "banner info", text: action === "move" ? "Search the Etag, then tap the asset to transfer it." : "Search the Etag, then tap the asset to dispose it." }) : null,
      h("div", { class: "search" }, q), count, list);
    if (action) setTimeout(() => q.focus(), 50);
    render();
  }

  const kv = (headers, row) => h("dl", { class: "kv" }, headers.flatMap((t, i) => (row[i] ? [h("dt", { text: t }), h("dd", { text: row[i] })] : [])));

  async function locDetail(r) {
    const kids = (Store.kids.get(U(r.row[14])) || []).length;
    const nAssets = Store.assets.filter((a) => U(a.row[8]) === r.key).length;
    const btns = canEdit() ? [["Add child location", "child", ""], ["Add asset here", "asset", "ghost"]] : [];
    if (nAssets) btns.push([`Assets here (${nAssets})`, "list", "ghost"]);
    if (canEdit() && r.origin === 1) btns.push(["Delete", "del", "danger"]);
    btns.push(["Close", null, "ghost"]);
    const v = await modal(r.row[14], h("div", { style: "display:grid;gap:10px" }, kv(L.LOCATION_HEADERS, r.row), h("p", { class: "hint", text: `Child locations: ${kids} · Assets: ${nAssets}` })), btns);
    if (v === "child") go(viewLocForm, { parentFl: r.row[0] });
    else if (v === "asset") go(viewAssetForm, { flCode: r.row[0] });
    else if (v === "list") go(viewBrowse, "asset", r.row[0]);
    else if (v === "del") {
      if (kids) return modal("Delete", `Remove its ${kids} child location(s) first.`);
      if (nAssets) return modal("Delete", "Remove its assets first.");
      if (r.exported) return modal("Delete", "Already exported to Excel. Delete it in the workbook instead.");
      if (await modal("Delete location", `Delete ${r.row[0]} ${r.row[14]}?`, [["Delete", true, "danger"], ["Cancel", false, "ghost"]])) { await Store.deleteLocation(r); const top = stack[stack.length - 1]; top[0](...top[1]); }
    }
  }

  async function assetDetail(r) {
    const body = h("div", { style: "display:grid;gap:10px" });
    const disposed = U(r.row[40]) === "DISPOSED";
    if (disposed) body.append(h("div", { class: "banner err", text: "This asset is disposed. It stays in the register for history." }));
    if (r.hasPhoto) { const b = await Store.photo(r.key); if (b) body.append(h("img", { class: "photo", alt: r.row[0], src: URL.createObjectURL(b) })); }
    const hist = Store.changesFor(r.row[0]);
    if (hist.length) body.append(h("div", { class: "hist" }, h("strong", { text: "History on this device" }),
      hist.map((c) => h("div", { class: "hist-row" }, h("span", { class: "badge " + (c.type === "DISPOSE" ? "disp" : "new"), text: c.type === "DISPOSE" ? "Disposed" : "Transfer" }),
        h("span", { text: c.type === "DISPOSE" ? `${c.date} · ${c.reason}${c.ref ? " · " + c.ref : ""}` : `${c.date} · ${c.fromCode} → ${c.toCode} · ${c.reason}` }),
        h("span", { class: "hint", text: c.exported ? "exported" : "not exported" })))));
    body.append(kv(L.ASSET_HEADERS, r.row));
    const btns = [];
    if (canEdit() && !disposed) btns.push(["Transfer", "move", ""], ["Dispose", "disp", "danger"]);
    if (canEdit() && r.origin === 1 && !r.exported && !hist.length) btns.push(["Delete", "del", "ghost"]);
    btns.push(["Close", null, "ghost"]);
    const v = await modal(r.row[0] + " · " + r.row[1], body, btns);
    const refresh = () => { const top = stack[stack.length - 1]; if (top) top[0](...top[1]); };
    if (v === "move") { if (await transferDialog(r)) refresh(); }
    else if (v === "disp") { if (await disposeDialog(r)) refresh(); }
    else if (v === "del" && await modal("Delete asset", `Delete ${r.row[0]}?`, [["Delete", true, "danger"], ["Cancel", false, "ghost"]])) { await Store.deleteAsset(r); refresh(); }
  }

  /** Asset transfer (shifting) to another functional location. */
  async function transferDialog(r) {
    const to = picker({ label: "New functional location", req: true, options: () => locOptions().filter((o) => U(o.value) !== U(r.row[8])), display: locDisplay });
    const date = dateInput(today());
    const reason = select(L.TRANSFER_REASONS.map((x) => [x, x]));
    const ref = input({ placeholder: "e.g. TRN / work order no.", autocomplete: "off" });
    const remarks = input({ autocomplete: "off" });
    const body = h("div", { class: "dlg-form" },
      h("div", { class: "plate" }, h("small", { text: "From" }), h("code", { text: r.row[9] || "-" }), h("span", { class: "meta", text: locDisplay(r.row[8]) })),
      to.el, field("Transfer date", date, { req: true }), field("Reason", reason, { req: true }), field("Reference", ref), field("Remarks", remarks));
    for (;;) {
      const ok = await modal(`Transfer ${r.row[0]}`, body, [["Transfer", true, ""], ["Cancel", false, "ghost"]]);
      if (!ok) return false;
      const err = !to.value ? "Choose the new functional location." : !Store.byFl.has(U(to.value)) ? "That location is not in this facility." : !date.value ? "Enter the transfer date." : null;
      if (err) { await modal("Transfer", err); continue; }
      const ch = await Store.recordChange("TRANSFER", r, { toFl: to.value, date: isoToDmy(date.value), reason: reason.value, ref: ref.value, remarks: remarks.value });
      toast(`${r.row[0]} moved to ${ch.toCode}`); return true;
    }
  }

  /** Asset disposal: Status = Disposed; record kept. */
  async function disposeDialog(r) {
    const date = dateInput(today());
    const reason = select([["", "Select reason"], ...L.DISPOSAL_REASONS.map((x) => [x, x])]);
    const ref = input({ placeholder: "Approval / PR / disposal form no.", autocomplete: "off" });
    const remarks = input({ autocomplete: "off" });
    const body = h("div", { class: "dlg-form" },
      h("div", { class: "banner err", text: `${r.row[0]} · ${r.row[1]}\nat ${r.row[9]}` }),
      field("Disposal date", date, { req: true }), field("Reason", reason, { req: true }), field("Reference", ref), field("Remarks", remarks));
    for (;;) {
      const ok = await modal(`Dispose ${r.row[0]}`, body, [["Dispose", true, "danger"], ["Cancel", false, "ghost"]]);
      if (!ok) return false;
      const err = !date.value ? "Enter the disposal date." : !reason.value ? "Choose a reason." : null;
      if (err) { await modal("Dispose", err); continue; }
      await Store.recordChange("DISPOSE", r, { date: isoToDmy(date.value), reason: reason.value, ref: ref.value, remarks: remarks.value });
      toast(`${r.row[0]} disposed`); return true;
    }
  }

  // ---------------- sync
  let downloadsCap = null;
  if (window.claude && window.claude.use) window.claude.use("downloads").then((d) => { downloadsCap = d; }).catch(() => {});

  const blobToBase64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(b); });

  /** Hand the ZIP to the user: native app share → Claude viewer save → phone share sheet → browser download. */
  async function deliver(blob, name) {
    const cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins.Filesystem && cap.Plugins.Share) {
      const w = await cap.Plugins.Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: "CACHE" });
      await cap.Plugins.Share.share({ title: name, url: w.uri, dialogTitle: "Save or send export" });
      return true;
    }
    if (downloadsCap) { await downloadsCap.save({ filename: name, data: blob }); return true; }
    const file = new File([blob], name, { type: "application/zip" });
    const touch = window.matchMedia && matchMedia("(pointer: coarse)").matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
    const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
    return true;
  }

  function viewSync() {
    setBusy = (t) => { if (t) toast(t); };
    const incl = h("input", { type: "checkbox" });
    const status = h("div", { class: "plate" });
    const out = h("div", { class: "btns" });
    let prepared = null;
    const counts = () => {
      const pl = Store.locs.filter((l) => l.origin === 1 && !l.exported).length, pa = Store.assets.filter((a) => a.origin === 1 && !a.exported).length;
      const el = Store.locs.filter((l) => l.origin === 1 && l.exported).length, ea = Store.assets.filter((a) => a.origin === 1 && a.exported).length;
      const pc = Store.changes.filter((c) => !c.exported).length, ec = Store.changes.filter((c) => c.exported).length;
      if (!canEdit()) { status.replaceChildren(h("small", { text: "Data on this device" }), h("code", { text: `Master ${Store.master.version || "-"}` }), h("span", { class: "meta", text: "View only. Load the latest workbook to see today's changes." })); return; }
      status.replaceChildren(h("small", { text: "Made on this device" }), h("code", { text: `${pl} locations · ${pa} assets · ${pc} transfers/disposals to export` }),
        h("span", { class: "meta", text: `${el} locations · ${ea} assets · ${ec} changes exported, waiting for the next workbook load` }));
    };
    async function prepare() {
      const locs = Store.locs.filter((l) => l.origin === 1 && (incl.checked || !l.exported)).sort((a, b) => a.createdAt - b.createdAt);
      const assets = Store.assets.filter((a) => a.origin === 1 && (incl.checked || !a.exported)).sort((a, b) => a.createdAt - b.createdAt);
      const changes = Store.changes.filter((c) => incl.checked || !c.exported).sort((a, b) => a.ts - b.ts);
      if (!locs.length && !assets.length && !changes.length) { out.replaceChildren(); return modal("Export", "Nothing to export."); }
      const enc = new TextEncoder(); const files = [
        { name: "Location.csv", data: enc.encode(L.csv(L.LOCATION_HEADERS, locs.map((l) => l.row))) },
        { name: "Asset.csv", data: enc.encode(L.csv(L.ASSET_HEADERS, assets.map((a) => a.row))) },
        { name: "Changes.csv", data: enc.encode(L.csv(L.CHANGE_HEADERS, changes.map(L.changeRow))) }];
      let photos = 0;
      for (const a of assets) if (a.hasPhoto) { const b = await Store.photo(a.key); if (b) { files.push({ name: `photos/${a.row[0]}.jpg`, data: new Uint8Array(await b.arrayBuffer()) }); photos++; } }
      files.push({ name: "export_info.txt", data: enc.encode(`Exported by ${Store.session.user} on ${today()}\r\nLocations: ${locs.length}\r\nAssets: ${assets.length}\r\nTransfers/disposals: ${changes.length}\r\nPhotos: ${photos}\r\nMaster version: ${Store.master.version}\r\n`) });
      const name = `AssetApp_${Store.session.user}_${stamp()}.zip`.replace(/\s+/g, "_");
      prepared = { blob: new Blob([L.zip(files)], { type: "application/zip" }), name, locs, assets, changes };
      out.replaceChildren(
        h("p", { class: "lede", text: `${name}\n${locs.length} locations · ${assets.length} assets · ${changes.length} transfers/disposals · ${photos} photos` }),
        btn("Save / share ZIP", async () => {
          try { await deliver(prepared.blob, prepared.name); await Store.markExported(prepared.locs, prepared.assets, prepared.changes); counts(); out.replaceChildren(); toast("Exported. Run ImportFromApp in Excel."); }
          catch (e) { if (!/declin|cancel|abort/i.test(String((e && (e.code || e.name || e.message)) || ""))) modal("Export", "The file was not saved. " + (e.message || e.code || "")); }
        }));
    }
    const file = h("input", { type: "file", hidden: true, onchange: async () => {
      const f = file.files[0]; if (!f) return;
      try {
        const s = await Store.importMaster(await readMasterFile(f, setBusy)); counts();
        modal("Master data imported", `Version ${s.version}\n${s.locations} locations · ${s.assets} assets\nDevice records now in the workbook: ${s.syncedL} locations · ${s.syncedA} assets · ${s.syncedC} transfers/disposals` + (s.conflicts.length ? "\n\nCheck:\n" + s.conflicts.slice(0, 20).join("\n") : ""));
      } catch (e) { modal("Import failed", e.message || String(e)); }
      file.value = "";
    } });
    screen(canEdit() ? "Sync with Excel" : "Refresh data", {},
      status,
      canEdit() ? h("div", { class: "section", text: "1 · Phone to Excel" }) : null,
      !canEdit() ? null : h("section", { class: "card" },
        h("p", { class: "lede", text: "Builds a ZIP with Location.csv, Asset.csv and Changes.csv (transfers and disposals) plus photos. In Excel run ImportFromApp and pick the ZIP." }),
        h("label", { class: "check" }, incl, "Include records exported before"),
        btn("Prepare export", prepare), out),
      h("div", { class: "section", text: canEdit() ? "2 · Excel to phone" : "Load the latest workbook" }),
      h("section", { class: "card" },
        h("p", { class: "lede", text: "Pick the latest Asset_Record.xlsm (or the .json from ExportMasterForApp). Workbook records are replaced; records made on this device stay until the workbook has them." }),
        btn("Load Asset_Record.xlsm…", () => file.click(), "ghost"), file));
    counts();
  }

  // ------------------------------------------------------------------ boot
  (async function boot() {
    await Store.init();
    if (!Store.master) go(viewSetup);
    else if (!Store.session) go(viewLogin);
    else home();
  })();
})();
