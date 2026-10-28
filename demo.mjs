#!/usr/bin/env node
// A sample landfill-gas flare over September 2026. The flare station's meter signs one window of
// 15-minute readings (gas flow, CH4 content, flare temperature) at the end of each day. Along the
// way: a comms outage the gateway records, three hours with the flare out, one day's window
// signed three days late, and a calibration certificate that lapses for three days. The
// developer claims the tonnes; the claim is re-derived from the signed readings; the verifier's
// sign-off is matched to the exact claim version; then the credits are issued and retired at two
// registries, with the double-counting cases caught. Every name, number and key is sample data,
// and the calculation is a simplified illustration, not a registry methodology.
//   node demo.mjs
import { genKeypair } from "./lib/keys.mjs";
import { registry, contentOf, signRecord } from "./lib/record.mjs";
import { commitReadings, readingProof, readingIncluded, window, calibration, claim, verification, issuance, retirement, gap } from "./src/records.mjs";
import { METHODS, verifyClaim, verifyOpinion, windowsCountedTwice, checkLedger } from "./src/verify.mjs";

const H = 3600000, DAY = 24 * H, Q = 15 * 60000, T0 = Date.parse("2026-09-01T00:00:00Z");
const d = (t) => new Date(t).toISOString().slice(0, 10);
const dt = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const t = (g) => (g / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 });
const [meter, gateway, lab, developer, verifier, regA, regB, forger] = Array.from({ length: 8 }, genKeypair);
const devices = registry([{ id: "sample-flare-01", pub: meter.pub, validFrom: T0 - DAY }]);

// Deterministic sample readings.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const reading = (ts) => {
  const flareOut = ts >= T0 + 12 * DAY + 2 * H && ts < T0 + 12 * DAY + 5 * H;
  return { t: ts, ch4Bp: 4800 + Math.floor(rnd() * 400), flowL: 120000 + Math.floor(rnd() * 15000), flareC: flareOut ? 60 + Math.floor(rnd() * 40) : 780 + Math.floor(rnd() * 120) };
};
const outage = [T0 + 7 * DAY + 9 * H, T0 + 7 * DAY + 15 * H];

const windows = new Map(), packages = new Map(), commits = new Map(), ids = [];
let prev = null;
for (let day = 0; day < 30; day++) {
  const from = T0 + day * DAY, to = from + DAY;
  const rs = [];
  for (let ts = from; ts < to; ts += Q) if (!(ts >= outage[0] && ts < outage[1])) rs.push(reading(ts));
  const c = commitReadings(rs);
  const recordedAt = day === 18 ? to + 3 * DAY : to + 4 * 60000;     // day 19 signed three days late
  prev = window(meter, { device: "sample-flare-01", project: "sample-landfill", from, to, intervalMs: Q, seq: prev ? prev.seq + 1 : 0, prev: prev?.claimId ?? null, c, recordedAt });
  windows.set(prev.claimId, prev); packages.set(prev.claimId, c.package); commits.set(prev.claimId, c); ids.push(prev.claimId);
}
const gaps = [gap(gateway, { service: "sample-gateway", device: "sample-flare-01", from: outage[0], to: outage[1], reason: "cellular link down", noticedAt: outage[0] + 20 * 60000 })];
const calibrations = [
  calibration(lab, { lab: "sample-lab", device: "sample-flare-01", cert: "CAL-2026-0311", validFrom: T0 - 180 * DAY, validTo: T0 + 24 * DAY, signedAt: T0 - 180 * DAY }),
  calibration(lab, { lab: "sample-lab", device: "sample-flare-01", cert: "CAL-2026-0927", validFrom: T0 + 27 * DAY, validTo: T0 + 207 * DAY, signedAt: T0 + 27 * DAY }),
];

// The developer claims the naive total: every reading credited, late window and lapsed
// calibration included.
const params = { gwp: 28, destructionBp: 9950, minFlareC: 500, densityGPerNm3: 716 };
const naiveG = [...packages.values()].flat().reduce((a, r) => a + METHODS["illustrative-lfg/1"]({ ...r, flareC: 999 }, params), 0);
const vintage = { from: T0, to: T0 + 30 * DAY };
const v1 = claim(developer, { project: "sample-landfill", developer: "sample-developer", vintage, windows: ids, method: "illustrative-lfg/1", params, claimedG: naiveG, signedAt: T0 + 31 * DAY });
const opts = { developerPub: developer.pub, windows, packages, devices, calibrations, labPub: lab.pub, gaps, gatewayPub: gateway.pub };
const r1 = verifyClaim(v1, opts);

console.log(`Sample landfill flare, ${d(T0)} to ${d(T0 + 29 * DAY)}: ${ids.length} daily windows, ${[...packages.values()].flat().length} signed readings`);
console.log(`Developer claims ${t(v1.claimedG)} t CO2e`);
console.log(`Re-derived from the signed readings: ${t(r1.recomputedG)} t CO2e (${t(r1.overclaimG)} t over-claimed)`);
for (const w of r1.windows.filter((w) => w.status !== "ok" || w.missing || w.flareOff || w.uncalibrated)) {
  const notes = [];
  if (w.status === "backfilled") notes.push(`signed ${Math.round(w.lagMs / H)} h after the window closed: BACK-FILLED, not credited`);
  if (w.missing) notes.push(`${w.missing} readings missing (gap recorded by gateway)`);
  if (w.flareOff) notes.push(`${w.flareOff} readings with the flare out, no destruction credited`);
  if (w.uncalibrated) notes.push(`${w.uncalibrated} readings outside any calibration certificate, not credited`);
  console.log(`  ${d(w.from)}  ${t(w.creditedG).padStart(6)} t  ${notes.join("; ")}`);
}
console.log(`Problems: ${[...new Set(r1.problems.map((p) => p.reason))].join(", ")}`);

// A corrected claim, verified; then the developer quietly revises it upward afterwards.
const v2 = claim(developer, { ...contentOf(v1), claimedG: r1.recomputedG, signedAt: T0 + 33 * DAY });
const r2 = verifyClaim(v2, opts);
const op = verification(verifier, { claimRef: v2.claimId, verifier: "sample-verifier", opinion: "positive", at: T0 + 40 * DAY });
const v3 = claim(developer, { ...contentOf(v2), claimedG: Math.floor(v2.claimedG * 1.06), signedAt: T0 + 45 * DAY });
const o = verifyOpinion([v1, v2, v3], [op], { verifierPub: verifier.pub });
console.log(`\nCorrected claim ${t(v2.claimedG)} t re-derives: ${r2.problems.every((p) => p.reason !== "claim_exceeds_recomputed") ? "PASS (no over-claim)" : "FAIL"}`);
console.log(`Verifier signed version ${o.verifiedVersion + 1} of ${o.versions}; latest version verified: ${o.latestVerified}; revised after verification: ${o.revisedAfterVerification} (+${t(o.claimedChange)} t)`);

// A buyer checks one reading without seeing the rest of the month.
const w10 = windows.get(ids[9]), c10 = commits.get(ids[9]), one = c10.package[17];
console.log(`\nA buyer checks one reading (${dt(one.t)}Z, flow ${one.flowL} L, CH4 ${one.ch4Bp / 100}%) against the meter's signed root: ${readingIncluded(w10, one, readingProof(c10, one))}`);
console.log(`  the same reading with flow raised 10%: ${readingIncluded(w10, { ...one, flowL: Math.floor(one.flowL * 1.1) }, readingProof(c10, one))}`);

// Issuance and retirement.
const tonnes = r2.creditableTonnes;
const creditable = new Map([[v2.claimId, tonnes]]);
const regs = new Map([["sample-registry-a", regA.pub], ["sample-registry-b", regB.pub]]);
const iA = issuance(regA, { registry: "sample-registry-a", claimRef: v2.claimId, project: "sample-landfill", serialFrom: 1, serialTo: tonnes, at: T0 + 50 * DAY });
const clean = checkLedger({ issuances: [iA], retirements: [retirement(regA, { registry: "sample-registry-a", project: "sample-landfill", serialFrom: 1, serialTo: 500, beneficiary: "sample-airline", at: T0 + 60 * DAY })], creditable, registries: regs });
console.log(`\nIssued ${tonnes} credits at one registry, 500 retired: ${clean.ok ? "PASS" : "FAIL " + JSON.stringify(clean.problems)}`);

console.log(`\nTamper and double-counting cases:`);
// Only problems beyond those already reported for the corrected claim count as caught.
const known = new Set(r2.problems.map((p) => p.reason));
const show = (label, problems) => { const fresh = [...new Set(problems.map((p) => p.reason))].filter((r) => !known.has(r)); console.log(`  ${label.padEnd(58)} ${fresh.length ? "CAUGHT: " + fresh.join(", ") : "NOT CAUGHT"}`); };
{ const pk = new Map(packages); pk.set(ids[4], pk.get(ids[4]).map((r, i) => (i === 3 ? { ...r, flowL: r.flowL * 2 } : r))); show("one reading's flow doubled after the meter signed", verifyClaim(v2, { ...opts, packages: pk }).problems); }
{ const dv = registry([{ id: "sample-flare-01", pub: meter.pub, validFrom: T0 - DAY, revokedAt: T0 + 20 * DAY }]); show("meter key revoked on 21 Sep (stolen), windows after it", verifyClaim(v2, { ...opts, devices: dv }).problems); }
{ const dv = registry([{ id: "sample-flare-01", pub: meter.pub, validFrom: T0 - DAY }, { id: "sample-flare-02", pub: forger.pub }]);
  const fake = signRecord(forger, contentOf(windows.get(ids[0]))); const ws = new Map(windows); ws.set(fake.claimId, fake); packages.set(fake.claimId, packages.get(ids[0]));
  show("window signed by a different device's key", verifyClaim(claim(developer, { ...contentOf(v2), windows: [fake.claimId] }), { ...opts, devices: dv, windows: ws }).problems); }
{ const c4 = claim(developer, { ...contentOf(v2), project: "sample-landfill-phase-2", windows: ids.slice(20, 25), signedAt: T0 + 70 * DAY }); show("same windows sold again under a second project", windowsCountedTwice([v2, c4]).map(() => ({ reason: "window_counted_twice" }))); }
{ const iB = issuance(regB, { registry: "sample-registry-b", claimRef: v2.claimId, project: "sample-landfill", serialFrom: 1, serialTo: tonnes, at: T0 + 55 * DAY }); show("same claim issued at a second registry", checkLedger({ issuances: [iA, iB], retirements: [], creditable, registries: regs }).problems); }
{ const ret = [retirement(regA, { registry: "sample-registry-a", project: "sample-landfill", serialFrom: 1, serialTo: 500, beneficiary: "sample-airline", at: T0 + 60 * DAY }), retirement(regA, { registry: "sample-registry-a", project: "sample-landfill", serialFrom: 401, serialTo: 900, beneficiary: "sample-retailer", at: T0 + 61 * DAY })];
  show("serials 401-500 retired for two different buyers", checkLedger({ issuances: [iA], retirements: ret, creditable, registries: regs }).problems); }
{ const big = issuance(regA, { registry: "sample-registry-a", claimRef: v2.claimId, project: "sample-landfill", serialFrom: 1, serialTo: tonnes + 400, at: T0 + 50 * DAY }); show("registry issues 400 more credits than were measured", checkLedger({ issuances: [big], retirements: [], creditable, registries: regs }).problems); }
{ const fake = issuance(forger, { registry: "sample-registry-a", claimRef: v2.claimId, project: "sample-landfill", serialFrom: 1, serialTo: 100, at: T0 + 50 * DAY }); show("issuance record forged in a registry's name", checkLedger({ issuances: [fake], retirements: [], creditable, registries: regs }).problems); }

console.log(`\nWhat this does not check: whether the baseline, additionality, permanence or leakage`);
console.log(`assumptions behind the method are honest. Those are judgement calls, see README.`);
