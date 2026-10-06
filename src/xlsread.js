/* Reads Asset_Record.xlsm in the browser with SheetJS (window.XLSX) -> rows per sheet.
   Dates are converted from the Excel serial number (no time-zone shift). Shared by app.js and tests. */
(function (root) {
  function workbookSheets(XLSX, data) {
    const wb = XLSX.read(data, { type: data instanceof ArrayBuffer ? "array" : "buffer", cellDates: false, cellNF: true, cellFormula: false, cellHTML: false, cellStyles: false });
    const p2 = (n) => String(n).padStart(2, "0");
    return function sheet(name) {
      const ws = wb.Sheets[name]; if (!ws) return null;
      let maxR = 0, maxC = 0;
      for (const k of Object.keys(ws)) {
        if (k[0] === "!") continue;
        const a = XLSX.utils.decode_cell(k); if (a.r > maxR) maxR = a.r; if (a.c > maxC) maxC = a.c;
        const c = ws[k];
        if (c.t === "n" && c.z && XLSX.SSF.is_date(c.z)) {
          const d = XLSX.SSF.parse_date_code(c.v);
          if (d) { c.t = "s"; c.v = `${p2(d.d)}.${p2(d.m)}.${d.y}`; }
        }
      }
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
      return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { workbookSheets }; else root.ARXlsx = { workbookSheets };
})(typeof window !== "undefined" ? window : globalThis);
