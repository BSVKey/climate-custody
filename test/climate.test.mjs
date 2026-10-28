import test from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../lib/keys.mjs";
import { registry, contentOf, signRecord } from "../lib/record.mjs";
import { commitReadings, rootOfPackage, readingProof, readingIncluded, window, calibration, claim, verification, issuance, retirement, gap } from "../src/records.mjs";
import { METHODS, verifyClaim, verifyOpinion, windowsCountedTwice, checkLedger } from "../src/verify.mjs";

const H = 3600000, DAY = 24 * H, Q = 15 * 60000, T0 = Date.parse("2026-09-01T00:00:00Z");
const params = { gwp: 28, destructionBp: 9950, minFlareC: 500, densityGPerNm3: 716 };
const rd = (t, flareC = 800) => ({ t, ch4Bp: 5000, flowL: 125000, flareC });

// Three daily windows from one meter; options let a test skip readings or sign a window late.
function setup({ skip = () => false, lateDay = -1, flareOut = () => false } = {}) {
  const [meter, lab, dev, gw] = [genKeypair(), genKeypair(), genKeypair(), genKeypair()];
  const windows = new Map(), packages = new Map(), ids = [];
  let prev = null;
  for (let day = 0; day < 3; day++) {
    const from = T0 + day * DAY, to = from + DAY, rs = [];
    for (let t = from; t < to; t += Q) if (!skip(t)) rs.push(rd(t, flareOut(t) ? 50 : 800));
    const c = commitReadings(rs);
    prev = window(meter, { device: "m1", project: "p", from, to, intervalMs: Q, seq: prev ? prev.seq + 1 : 0, prev: prev?.claimId ?? null, c, recordedAt: day === lateDay ? to + 2 * DAY : to + 60000 });
    windows.set(prev.claimId, prev); packages.set(prev.claimId, c.package); ids.push(prev.claimId);
  }
  const cal = calibration(lab, { lab: "lab", device: "m1", cert: "C1", validFrom: T0 - DAY, validTo: T0 + 10 * DAY, signedAt: T0 - DAY });
  const opts = { developerPub: dev.pub, windows, packages, devices: registry([{ id: "m1", pub: meter.pub }]), calibrations: [cal], labPub: lab.pub, gaps: [], gatewayPub: gw.pub };
  const mk = (claimedG, extra = {}) => claim(dev, { project: "p", developer: "d", vintage: { from: T0, to: T0 + 3 * DAY }, windows: ids, method: "illustrative-lfg/1", params, claimedG, signedAt: T0 + 4 * DAY, ...extra });
  return { meter, lab, dev, gw, windows, packages, ids, opts, mk };
}
const perReading = METHODS["illustrative-lfg/1"](rd(0), params);

test("method: CH4 mass x GWP x destruction, nothing when the flare is out", () => {
  // 125 Nm3 x 50% x 716 g = 44,750 g CH4; x 28 x 0.995 = 1,246,735 g CO2e
  assert.equal(perReading, 1246735);
  assert.equal(METHODS["illustrative-lfg/1"](rd(0, 100), params), 0);
});

test("root from disclosure package; one reading proven alone; duplicates refused", () => {
  const rs = [rd(T0), rd(T0 + Q), rd(T0 + 2 * Q)];
  const c = commitReadings(rs);
  assert.equal(rootOfPackage(c.package), c.root);
  const w = window(genKeypair(), { device: "m", project: "p", from: T0, to: T0 + 3 * Q, intervalMs: Q, seq: 0, prev: null, c, recordedAt: T0 + 3 * Q });
  assert.equal(readingIncluded(w, rs[1], readingProof(c, rs[1])), true);
  assert.equal(readingIncluded(w, { ...rs[1], ch4Bp: 5001 }, readingProof(c, rs[1])), false);
  assert.throws(() => commitReadings([rs[0], rs[0]]), /duplicate/);
});

test("honest claim re-derives exactly", () => {
  const s = setup();
  const exact = 3 * 96 * perReading;
  const r = verifyClaim(s.mk(exact), s.opts);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.recomputedG, exact);
  assert.equal(r.creditableTonnes, Math.floor(exact / 1e6));
  const over = verifyClaim(s.mk(exact + 1), s.opts);
  assert.deepEqual(over.problems.map((p) => p.reason), ["claim_exceeds_recomputed"]);
});

test("flare out earns nothing; unrecorded missing readings flagged, recorded ones not", () => {
  const out = (t) => t >= T0 + H && t < T0 + 2 * H;
  const s = setup({ skip: out });
  const r = verifyClaim(s.mk(0), s.opts);
  assert.deepEqual(r.problems.map((p) => p.reason), ["missing_readings_not_recorded"]);
  assert.equal(r.windows[0].missing, 4);
  const g = gap(s.gw, { service: "gw", device: "m1", from: T0 + H, to: T0 + 2 * H, reason: "power", noticedAt: T0 + 2 * H });
  assert.equal(verifyClaim(s.mk(0), { ...s.opts, gaps: [g] }).ok, true);
  const f = setup({ flareOut: out });
  const rf = verifyClaim(f.mk(0), f.opts);
  assert.equal(rf.windows[0].flareOff, 4);
  assert.equal(rf.recomputedG, (3 * 96 - 4) * perReading);
});

test("back-filled window earns nothing by default", () => {
  const s = setup({ lateDay: 1 });
  const r = verifyClaim(s.mk(0), s.opts);
  assert.equal(r.windows[1].status, "backfilled");
  assert.equal(r.windows[1].creditedG, 0);
  assert.equal(r.recomputedG, 2 * 96 * perReading);
  assert.equal(verifyClaim(s.mk(0), { ...s.opts, creditBackfilled: true }).recomputedG, 3 * 96 * perReading);
});

test("readings outside calibration, edited readings, wrong or revoked device key", () => {
  const s = setup();
  const cal = calibration(s.lab, { lab: "lab", device: "m1", cert: "C0", validFrom: T0 - DAY, validTo: T0 + DAY, signedAt: T0 - DAY });
  const rc = verifyClaim(s.mk(0), { ...s.opts, calibrations: [cal] });
  assert.equal(rc.recomputedG, 96 * perReading);
  assert.ok(rc.problems.some((p) => p.reason === "readings_outside_calibration"));
  const forgedLab = calibration(genKeypair(), { ...contentOf(cal), validTo: T0 + 10 * DAY });
  assert.equal(verifyClaim(s.mk(0), { ...s.opts, calibrations: [forgedLab] }).recomputedG, 0);

  const pk = new Map(s.packages); pk.set(s.ids[0], pk.get(s.ids[0]).map((r, i) => (i ? r : { ...r, flowL: r.flowL + 1 })));
  assert.ok(verifyClaim(s.mk(0), { ...s.opts, packages: pk }).problems.some((p) => p.reason === "readings_do_not_match_signed_root"));

  const revoked = registry([{ id: "m1", pub: s.meter.pub, revokedAt: T0 + DAY + 2 * 60000 }]);
  assert.deepEqual(verifyClaim(s.mk(0), { ...s.opts, devices: revoked }).problems.map((p) => p.reason), ["window_key_revoked", "window_key_revoked"]);
  const other = genKeypair(), ws = new Map(s.windows), fake = signRecord(other, contentOf(s.windows.get(s.ids[0])));
  ws.set(fake.claimId, fake);
  assert.ok(verifyClaim(s.mk(0), { ...s.opts, windows: ws }).problems.some((p) => p.reason === "window_signer_not_registered_key"));
});

test("window dropped from the chain, unpublished window, unknown method, forged claim", () => {
  const s = setup();
  const gapChain = verifyClaim(s.mk(0, { windows: [s.ids[0], s.ids[2]] }), s.opts);
  assert.deepEqual(gapChain.problems.map((p) => p.reason), ["device_chain_break"]);
  assert.deepEqual(verifyClaim(s.mk(0, { windows: ["0xdead"] }), s.opts).problems.map((p) => p.reason), ["window_not_published"]);
  assert.deepEqual(verifyClaim(s.mk(0, { method: "made-up/1" }), s.opts).problems.map((p) => p.reason), ["unknown_method"]);
  const forged = signRecord(genKeypair(), contentOf(s.mk(0)));
  assert.deepEqual(verifyClaim(forged, s.opts).problems.map((p) => p.reason), ["claim_signer_not_pinned_key"]);
});

test("verifier opinion is bound to one claim version", () => {
  const s = setup(), v = genKeypair();
  const c1 = s.mk(100, { signedAt: T0 + 4 * DAY }), c2 = s.mk(150, { signedAt: T0 + 6 * DAY });
  const op = verification(v, { claimRef: c1.claimId, verifier: "v", opinion: "positive", at: T0 + 5 * DAY });
  const o = verifyOpinion([c2, c1], [op], { verifierPub: v.pub });
  assert.deepEqual([o.verifiedVersion, o.latestVerified, o.revisedAfterVerification, o.claimedChange], [0, false, true, 50]);
  const forged = verification(genKeypair(), { claimRef: c2.claimId, verifier: "v", opinion: "positive", at: T0 + 7 * DAY });
  assert.equal(verifyOpinion([c1, c2], [op, forged], { verifierPub: v.pub }).latestVerified, false);
});

test("double counting: windows reused, double issuance, over-issuance, double retirement", () => {
  const s = setup();
  const a = s.mk(0), b = s.mk(0, { project: "p2", windows: [s.ids[2]] });
  assert.deepEqual(windowsCountedTwice([a, b]).map((x) => x.window), [s.ids[2]]);

  const [ra, rb] = [genKeypair(), genKeypair()];
  const regs = new Map([["A", ra.pub], ["B", rb.pub]]), creditable = new Map([[a.claimId, 100]]);
  const iA = issuance(ra, { registry: "A", claimRef: a.claimId, project: "p", serialFrom: 1, serialTo: 100, at: 1 });
  const ret = (from, to, who, k = ra, reg = "A") => retirement(k, { registry: reg, project: "p", serialFrom: from, serialTo: to, beneficiary: who, at: 2 });
  assert.equal(checkLedger({ issuances: [iA], retirements: [ret(1, 50, "x"), ret(51, 100, "y")], creditable, registries: regs }).ok, true);

  const reasons = (o) => checkLedger({ issuances: [iA], retirements: [], creditable, registries: regs, ...o }).problems.map((p) => p.reason);
  assert.deepEqual(reasons({ issuances: [iA, issuance(rb, { registry: "B", claimRef: a.claimId, project: "p", serialFrom: 1, serialTo: 100, at: 1 })] }), ["issued_at_two_registries", "issued_more_than_measured"]);
  assert.deepEqual(reasons({ issuances: [issuance(ra, { registry: "A", claimRef: a.claimId, project: "p", serialFrom: 1, serialTo: 101, at: 1 })] }), ["issued_more_than_measured"]);
  assert.deepEqual(reasons({ retirements: [ret(1, 50, "x"), ret(50, 60, "y")] }), ["retired_twice"]);
  assert.deepEqual(reasons({ retirements: [ret(90, 110, "x")] }), ["retired_not_issued"]);
  assert.deepEqual(reasons({ retirements: [ret(1, 5, "x", rb)] }), ["retirement_signer_not_pinned_key"]);
  assert.deepEqual(reasons({ retirements: [ret(1, 5, "x", ra, "Z")] }), ["retirement_registry_unknown"]);
});
