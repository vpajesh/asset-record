/*
 * Asset Record – creation rules (JS port of app/src/main/java/com/assetrecord/app/CodeGen.kt,
 * itself a port of USF1.SaveLocationRow, Module3.GetNextFLCode, USF1.WriteAssetDataToRow).
 * Pure functions: no DOM, no storage. Runs in the browser (window.ARLogic) and in Node (tests).
 */
(function (root) {
  "use strict";

  const LOCATION_HEADERS = ["FLCode", "FLDescription", "FLLocalID", "FLParent", "FLFacility", "FLSurveyer", "FLDate",
    "Location Class", "Location Code", "Location 1", "location 2", "location 3", "LocationParent",
    "LoocationNew", "LocationCodeFinal", "Locationcount", "Level"];

  const ASSET_HEADERS = ["EquipTagNo", "TechDesc", "MfgAsset", "ModelNo", "SerialNo", "SS Code", "Subsystem",
    "Received From", "FuncLoc", "FuncLocDesc", "QtyEquip", "AcqDate", "ValidTo", "AcqValue",
    "Capacity", "CapUnit", "ChgBy", "ChgOn", "CrtdBy", "CrtdOn", "Category", "EquipCond", "Asset",
    "FL1Code", "FL2Code", "FL3Code", "FL4Code", "FL5Code", "FL6Code",
    "FL1Desc", "FL2Desc", "FL3Desc", "FL4Desc", "FL5Desc", "FL6Desc",
    "PurchDoc", "ReplFor", "VenWrty", "WrtyStart", "WrtyEnd", "Status", "Facility", "Picture",
    "C Code", "Supplier"];

  const ASSET_PREFIXES = [["EQP", "Equipment"], ["MAC", "Machine"], ["FUR", "Furniture"], ["FFE", "Fixture"],
    ["OSE", "Operational Equipment"], ["AVT", "AVT"], ["VEH", "Vehicle"]];
  const CONDITIONS = ["New", "Good", "Fair", "Poor"];
  const ASSET_OR_ITEM = ["Asset", "Item"];
  const DEFAULT_VALID_TO = "31.12.9999";
  const FACILITY_PARENT_FL = "F100001";
  const MAX_LEVELS = 6;
  const NOT_COUNTABLE = new Set(["BF", "FL", "FF", "GF", "RF"]);

  const s = (v) => (v == null ? "" : String(v));
  const up = (v) => s(v).toUpperCase();
  const stripTrailingDigits = (t) => s(t).replace(/[0-9]+$/, "");

  /** VBA Val(): leading digits (spaces ignored), 0 if none. */
  function vbVal(t) {
    let out = "";
    for (const c of s(t)) {
      if (c === " ") continue;
      if (c >= "0" && c <= "9") out += c; else break;
    }
    return out ? Number(out.slice(0, 15)) : 0;
  }

  /** GetNextFLCode */
  function nextFlCode(existing) {
    let max = 0;
    for (const raw of existing) {
      const t = s(raw).trim();
      if (t.startsWith("F")) { const n = vbVal(t.slice(1)); if (n > max) max = n; }
    }
    return "F" + String(max + 1).padStart(6, "0");
  }

  /** GetFacilityOnlyCode: "F20 U1402" -> "U1402" */
  function facilityOnlyCode(f) {
    const t = s(f).trim(); const i = t.lastIndexOf(" ");
    return i >= 0 ? t.slice(i + 1).trim() : t;
  }

  function isFacilityClass(desc, cls) {
    const d = up(desc), c = cls ? up(cls.cls) : "";
    return d === "FACILITY" || d === "FACILITY FM" || c === "FACILITY" || c === "FACILITY FM" || c === "FACILITYFM";
  }

  /** GetOwnLocationSuffix */
  function ownSuffix(finalCode) {
    const t = s(finalCode).trim(); const i = t.lastIndexOf("-");
    return i >= 0 ? t.slice(i + 1) : t;
  }

  /** ExtractSuffixNumber */
  function suffixNumber(sfx) {
    const d = s(sfx).replace(/[^0-9]/g, "");
    return d ? parseInt(d.slice(0, 9), 10) : 1;
  }

  /**
   * SaveLocationRow code generation.
   * index: { byFl(fl)->ref|null, byFinal(code)->ref|null, children(parentCode)->[finalCode] }
   * ref:   { fl, description, localId, parentCode, finalCode }
   * returns { ok:true, finalCode, parentCode, seq, level, isFacility } | { ok:false, error }
   */
  function buildLocation(index, flCode, desc, cls, parentFl, facility) {
    const err = (e) => ({ ok: false, error: e });
    flCode = s(flCode).trim(); desc = s(desc).trim(); parentFl = s(parentFl).trim();
    if (!flCode) return err("Enter FL Code.");
    if (!desc) return err("Select Location Description.");
    const facCode = facilityOnlyCode(facility);
    if (!facCode) return err("Facility value is missing.");
    if (index.byFl(flCode)) return err("FL Code already exists: " + flCode);
    if (!cls) return err("Class not found in Class&Units Column B:\n" + desc);

    const isFacility = isFacilityClass(desc, cls);
    if (!isFacility) {
      if (!cls.locCode) return err("LocCode missing in Class&Units Column D for:\n" + desc);
      if (!cls.secondCode) return err("SecondLoc missing in Class&Units Column E for:\n" + desc);
    }
    const countable = !NOT_COUNTABLE.has(up(cls.locCode));

    let finalCode, parentCode, seq;
    if (isFacility) {
      parentCode = ""; finalCode = facCode; seq = 1;
      // Guard added in the apps (workbook has none): one root per facility code.
      if (index.byFinal(finalCode)) return err("Facility root already exists:\n" + finalCode);
    } else {
      if (!parentFl) return err("Select parent location.");
      const parent = index.byFl(parentFl);
      if (!parent) return err("Parent not found: " + parentFl);
      parentCode = s(parent.finalCode);
      if (!parentCode) return err("Parent final code is blank.");
      const prefix = stripTrailingDigits(cls.secondCode);
      if (!prefix) return err("Unable to identify code prefix from:\n" + cls.secondCode);

      if (countable) {
        let max = 0;
        for (const child of index.children(parentCode)) {
          const sfx = ownSuffix(child);
          if (up(stripTrailingDigits(sfx)) === up(prefix)) { const n = suffixNumber(sfx); if (n > max) max = n; }
        }
        seq = max + 1;
      } else seq = 1;

      let suffix;
      if (!countable) suffix = cls.secondCode;
      else {
        const width = (up(prefix) === "SA" || up(prefix) === "B") ? 3 : 2;
        suffix = prefix + String(seq).padStart(width, "0");
      }
      finalCode = parentCode + "-" + suffix;
      if (index.byFinal(finalCode)) return err("LocationCodeFinal already exists:\n" + finalCode);
    }
    const level = finalCode.split("-").length;
    if (level > MAX_LEVELS) return err("Maximum " + MAX_LEVELS + " levels allowed.");
    return { ok: true, finalCode, parentCode, seq, level, isFacility };
  }

  /** Location row A:Q exactly as SaveLocationRow writes it. */
  function locationRow(flCode, desc, localId, parentFl, facility, createdBy, date, cls, g) {
    return [s(flCode).trim(), desc, s(localId).trim(), g.isFacility ? FACILITY_PARENT_FL : s(parentFl).trim(),
      facility, createdBy, date, cls.locCode, cls.secondCode, cls.g, cls.a, cls.g,
      g.parentCode, cls.cls, g.finalCode, String(g.seq), String(g.level)];
  }

  /** JoinPartial, max 6 levels */
  function partialCodes(finalCode) {
    if (!s(finalCode).trim()) return [];
    const p = s(finalCode).split("-"); const out = [];
    for (let i = 0; i < Math.min(p.length, MAX_LEVELS); i++) out.push(p.slice(0, i + 1).join("-"));
    return out;
  }

  /** CMD_SAVE_ASSET_Click validation -> error text or null */
  function validateAsset(a, etagExists, flExists) {
    if (!s(a.number).trim()) return "Enter Etag";
    if (!a.prefix) return "Select Asset Prefix";
    if (!s(a.description).trim()) return "Select Etag Description";
    if (!a.flCode) return "Select Functional Location";
    if (!a.warranty) return "Select Warranty Yes/No";
    const full = a.prefix + s(a.number).trim();
    if (etagExists(full)) return "Etag already exists: " + full;
    if (!flExists(a.flCode)) return "FL Code not found: " + a.flCode;
    if (!s(a.siteVisitDate).trim()) return "Enter the site visit date (Created On).";
    return null;
  }

  /** Asset row A:AS as WriteAssetDataToRow + Update_FL_Desc_OneRow write it. */
  function assetRow(a, type, loc, facility, user, today, descForFinal) {
    const r = new Array(ASSET_HEADERS.length).fill("");
    const extra = s(a.extraDesc).trim();
    r[0] = a.prefix + s(a.number).trim();
    r[1] = extra ? a.description + " " + extra : a.description;
    r[2] = up(s(a.manufacturer).trim());
    r[3] = up(s(a.model).trim());
    r[4] = s(a.serial).trim();
    r[5] = type ? type.systemCode : "NCA";
    r[6] = type ? type.system : "Class not assigned";
    r[7] = s(a.receivedFrom).trim();
    r[8] = loc.fl;
    r[9] = loc.finalCode;
    r[10] = s(a.qty).trim() || "1";
    r[11] = s(a.acqDate);
    r[12] = s(a.validTo).trim() || DEFAULT_VALID_TO;
    r[13] = s(a.acqValue).trim();
    r[14] = s(a.capacityUnit).trim();
    r[15] = s(a.capacityValue).trim();
    r[16] = user; r[17] = today; r[18] = user;
    r[19] = s(a.siteVisitDate);
    r[20] = type ? type.category : "Class not assigned";
    r[21] = a.condition; r[22] = a.assetOrItem;
    partialCodes(loc.finalCode).forEach((code, i) => { r[23 + i] = code; r[29 + i] = descForFinal(code) || ""; });
    r[35] = s(a.purchDoc).trim(); r[36] = s(a.replFor).trim(); r[37] = a.warranty;
    r[38] = s(a.warrantyStart); r[39] = s(a.warrantyEnd); r[40] = "In Use"; r[41] = facility;
    r[42] = a.hasPhoto ? "File" : ""; r[43] = type ? type.categoryCode : "NCA"; r[44] = s(a.supplier).trim();
    return r;
  }

  /** RFC-4180 CSV, UTF-8 BOM, CRLF (same as the Android export). */
  function csv(headers, rows) {
    const q = (v) => { v = s(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return "\uFEFF" + [headers, ...rows].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
  }

  /** Minimal ZIP writer (STORE, no compression). files: [{name, data:Uint8Array}] -> Uint8Array */
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files, date) {
    const enc = new TextEncoder(); const d = date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = []; const central = []; let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name); const data = f.data; const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0)); let o = 0;
    for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  /**
   * Build the master object straight from Asset_Record.xlsm (same result as tools/extract_seed.py
   * and the VBA ExportMasterForApp). sheet(name) -> 2-D array of cell values (row 0 = header) or null.
   */
  function masterFromSheets(sheet, version) {
    const txt = (v) => {
      if (v == null) return "";
      if (v instanceof Date) return `${String(v.getDate()).padStart(2, "0")}.${String(v.getMonth() + 1).padStart(2, "0")}.${v.getFullYear()}`;
      if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
      return String(v).trim();
    };
    const rows = (name, n) => {
      const d = sheet(name); if (!d) throw new Error(`Sheet "${name}" not found. Is this Asset_Record.xlsm?`);
      return d.slice(1).map((r) => Array.from({ length: n }, (_, i) => txt(r[i])));
    };
    const cu = rows("Class&Units", 45);
    const uniq = (i) => { const seen = new Set(), out = []; for (const r of cu) { const v = r[i]; if (v && !seen.has(v.toUpperCase())) { seen.add(v.toUpperCase()); out.push(v); } } return out; };
    const locClasses = [], seenC = new Set();
    for (const r of cu) if (r[1] && !seenC.has(r[1].toUpperCase())) { seenC.add(r[1].toUpperCase()); locClasses.push({ name: r[1], cls: r[2], locCode: r[3], secondCode: r[4], a: r[0], g: r[6] }); }
    const assetTypes = [], seenT = new Set();
    for (const r of cu) if (r[20] && !seenT.has(r[20])) { seenT.add(r[20]); assetTypes.push({ name: r[20], system: r[21], systemCode: r[22], category: r[23], categoryCode: r[24] }); }
    return {
      version: version || "", users: rows("Admin", 13).filter((r) => r[9]).map((r) => ({ name: r[9], id: r[10], password: r[11], role: r[12] })),
      facilities: rows("F-Facility", 2).filter((r) => r[0]).map((r) => ({ code: r[0], name: r[1] })),
      locClasses, assetTypes, units: uniq(14), manufacturers: uniq(34), models: uniq(35), receivedFrom: uniq(18),
      locations: rows("Location", 17).filter((r) => r[0]), assets: rows("Asset", 45).filter((r) => r[0]),
    };
  }


  // ---------------------------------------------------------------- transfer / disposal (admin only)
  const CHANGE_HEADERS = ["ChangeId", "Type", "EquipTagNo", "Date", "FromFuncLoc", "FromCode", "ToFuncLoc", "ToCode",
    "Reason", "Reference", "Remarks", "User", "Recorded"];
  const TRANSFER_REASONS = ["Relocation", "Department change", "Sent for repair", "Moved to store", "Returned from repair", "Other"];
  const DISPOSAL_REASONS = ["Damaged beyond repair", "Obsolete", "Lost / stolen", "Sold", "Scrapped", "Donated", "Other"];
  const DISPOSED = "Disposed";

  /** A user may edit when they are Admin, or when no user in the Admin sheet has a role yet (backward compatible). */
  function isAdmin(users, name) {
    const anyRole = (users || []).some((u) => s(u.role).trim());
    if (!anyRole) return true;
    const u = (users || []).find((x) => up(x.name) === up(name));
    return !!u && up(u.role) === "ADMIN";
  }

  /** Move an asset row to another location: FuncLoc, FuncLocDesc, FL1..6 codes + descriptions, ChgBy/ChgOn. */
  function applyTransfer(row, toLoc, user, date, descForFinal) {
    const r = row.slice();
    r[8] = toLoc.fl; r[9] = toLoc.finalCode;
    for (let i = 23; i <= 34; i++) r[i] = "";
    partialCodes(toLoc.finalCode).forEach((code, i) => { r[23 + i] = code; r[29 + i] = descForFinal(code) || ""; });
    r[16] = user; r[17] = date;
    return r;
  }
  /** Retire an asset: Status = Disposed, ChgBy/ChgOn. The row is kept, never deleted. */
  function applyDispose(row, user, date) { const r = row.slice(); r[40] = DISPOSED; r[16] = user; r[17] = date; return r; }
  /** Is the change already visible in this (workbook) row? */
  function isReflected(ch, row) {
    if (!row) return false;
    if (ch.type === "TRANSFER") return up(row[8]) === up(ch.toFl);
    if (ch.type === "DISPOSE") return up(row[40]) === up(DISPOSED);
    return false;
  }
  function changeRow(c) { return [c.id, c.type, c.etag, c.date, c.fromFl, c.fromCode, c.toFl || "", c.toCode || "", c.reason, c.ref || "", c.remarks || "", c.user, c.recorded]; }

  const api = { CHANGE_HEADERS, TRANSFER_REASONS, DISPOSAL_REASONS, DISPOSED, isAdmin, applyTransfer, applyDispose, isReflected, changeRow, masterFromSheets, LOCATION_HEADERS, ASSET_HEADERS, ASSET_PREFIXES, CONDITIONS, ASSET_OR_ITEM, DEFAULT_VALID_TO,
    FACILITY_PARENT_FL, MAX_LEVELS, nextFlCode, facilityOnlyCode, isFacilityClass, ownSuffix, suffixNumber,
    buildLocation, locationRow, partialCodes, validateAsset, assetRow, csv, zip, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ARLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
