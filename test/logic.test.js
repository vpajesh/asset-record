// node test/logic.test.js <seed.json>  — replays the workbook's locations through buildLocation
const L = require("../src/logic.js");
const assert = require("assert");
const fs = require("fs");

function index(rows) {
  const byFl = new Map(), byFinal = new Map(), kids = new Map();
  for (const r of rows) {
    const ref = { fl: r[0], description: r[1], localId: r[2], parentCode: r[12], finalCode: r[14] };
    if (!byFl.has(r[0].toUpperCase())) byFl.set(r[0].toUpperCase(), ref);
    if (r[14] && !byFinal.has(r[14].toUpperCase())) byFinal.set(r[14].toUpperCase(), ref);
    const k = r[12].toUpperCase(); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(r[14]);
  }
  return { byFl: (f) => byFl.get(f.toUpperCase()) || null, byFinal: (c) => byFinal.get(c.toUpperCase()) || null,
           children: (p) => kids.get(p.toUpperCase()) || [] };
}

const seed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const cls = new Map(seed.locClasses.map((c) => [c.name.toUpperCase(), c]));
let ok = 0, bad = 0;
const locs = seed.locations;
for (let i = 0; i < locs.length; i++) {
  const r = locs[i];
  const g = L.buildLocation(index(locs.slice(0, i)), r[0], r[1], cls.get(r[1].toUpperCase()), r[3], r[4]);
  if (g.ok && g.finalCode === r[14]) ok++; else bad++;
}
console.log(`replay ok=${ok} bad=${bad}`);
assert.strictEqual(ok, 956, "must match Kotlin/VBA replay (956)");

const all = index(locs);
const gen = (d, p, fl = "F999999") => L.buildLocation(all, fl, d, cls.get(d.toUpperCase()), p, "F20 U1402");
const fl = (code) => locs.find((r) => r[14] === code)[0];
assert.strictEqual(gen("Building", fl("U1402-SA001")).finalCode, "U1402-SA001-B009");
assert.match(gen("Ground Floor", fl("U1402-SA001-B001")).error, /already exists/);
assert.strictEqual(gen("Room", fl("U1402-SA001-B001-GF00")).finalCode, "U1402-SA001-B001-GF00-RM01");
assert.match(gen("Facility", "").error, /Facility root already exists/);
assert.strictEqual(L.nextFlCode(locs.map((r) => r[0])), "F401248");
assert.strictEqual(L.nextFlCode(["F9", "x123", "f500"]), "F000010");
assert.deepStrictEqual(L.partialCodes("A-B-C"), ["A", "A-B", "A-B-C"]);

// asset row layout
const loc = all.byFl(fl("U1402-SA001-B001-GF00"));
const a = { prefix: "EQP", number: "105507", description: "Isolator Panel", extraDesc: "5", manufacturer: "alfanar",
  model: "x1", serial: "", receivedFrom: "Site Survey", flCode: loc.fl, qty: "", acqDate: "", validTo: "", acqValue: "",
  capacityUnit: "Ampere", capacityValue: "200", condition: "Good", assetOrItem: "Asset", purchDoc: "", replFor: "",
  warranty: "No", warrantyStart: "", warrantyEnd: "", supplier: "", siteVisitDate: "10.06.2026", hasPhoto: true };
const row = L.assetRow(a, null, loc, "F20 U1402", "Ajesh", "11.06.2026", (c) => "d:" + c);
assert.strictEqual(row.length, 45);
assert.deepStrictEqual([row[0], row[1], row[2], row[5], row[6], row[10], row[12], row[40], row[42], row[43]],
  ["EQP105507", "Isolator Panel 5", "ALFANAR", "NCA", "Class not assigned", "1", "31.12.9999", "In Use", "File", "NCA"]);
assert.strictEqual(row[26], "U1402-SA001-B001-GF00"); assert.strictEqual(row[32], "d:U1402-SA001-B001-GF00");
assert.strictEqual(L.validateAsset({ ...a, warranty: "" }, () => false, () => true), "Select Warranty Yes/No");

// csv + zip integrity (python verifies the zip separately)
assert.strictEqual(L.csv(["a", "b"], [["x,y", 'q"']]), '﻿a,b\r\n"x,y","q"""\r\n');
const z = L.zip([{ name: "Location.csv", data: new TextEncoder().encode("hi") }, { name: "photos/E1.jpg", data: new Uint8Array([1, 2, 3]) }]);
fs.writeFileSync(process.argv[3] || "/tmp/t.zip", z);
console.log("all logic tests passed");

// transfer / dispose / roles
{
  const all2 = index(locs);
  const fromLoc = all2.byFl(fl("U1402-SA001-B001-GF00"));
  const toLoc = all2.byFl(fl("U1402-SA001-B002"));
  const a0 = L.assetRow({ ...a, flCode: fromLoc.fl }, null, fromLoc, "F20 U1402", "Ajesh", "01.10.2026", (c) => "d:" + c);
  const t = L.applyTransfer(a0, toLoc, "Ajesh", "06.10.2026", (c) => "d:" + c);
  assert.deepStrictEqual([t[8], t[9], t[23], t[25], t[26], t[29], t[31], t[32], t[16], t[17]],
    [toLoc.fl, "U1402-SA001-B002", "U1402", "U1402-SA001-B002", "", "d:U1402", "d:U1402-SA001-B002", "", "Ajesh", "06.10.2026"]);
  assert.strictEqual(a0[26], "U1402-SA001-B001-GF00");           // original untouched
  assert.ok(L.isReflected({ type: "TRANSFER", toFl: toLoc.fl }, t) && !L.isReflected({ type: "TRANSFER", toFl: toLoc.fl }, a0));
  const d = L.applyDispose(t, "Ajesh", "07.10.2026");
  assert.strictEqual(d[40], "Disposed"); assert.ok(L.isReflected({ type: "DISPOSE" }, d));
  assert.ok(L.isAdmin([{ name: "A" }, { name: "B" }], "B"));     // no roles set -> everyone edits
  assert.ok(L.isAdmin([{ name: "Ajesh", role: "Admin" }, { name: "B", role: "" }], "ajesh"));
  assert.ok(!L.isAdmin([{ name: "Ajesh", role: "Admin" }, { name: "B", role: "Viewer" }], "B"));
  console.log("transfer/dispose/role tests passed");
}
