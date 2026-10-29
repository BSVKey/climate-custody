import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../lib/keys.mjs";
import { registry, contentOf, signRecord } from "../lib/record.mjs";
import { window, gap } from "../src/records.mjs";
import { commitEnergy, energyProof, energyIncluded, checkCertificates, fromEnergyTagBundle, fromProjectOriginIssued } from "../src/granular.mjs";

const H = 3600000, Q = 900000;
const T0 = Date.UTC(2026, 6, 1, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// A solar device: one signed window per hour, four 15-minute readings each.
function meterData({ hours = 6, lagMs = 60000, whOf = (h, q) => 10000 + h * 1000 + q * 10, skip = [] } = {}) {
  const meter = genKeypair();
  const windows = [], packages = new Map();
  let prev = null;
  for (let h = 0; h < hours; h++) {
    const from = T0 + h * H;
    const readings = [0, 1, 2, 3].filter((q) => !skip.includes(`${h}.${q}`)).map((q) => ({ t: from + q * Q, wh: whOf(h, q) }));
    const c = commitEnergy(readings);
    const w = window(meter, { device: "solar-1", project: "farm", from, to: from + H, intervalMs: Q, seq: h, prev, c, recordedAt: from + H + lagMs });
    windows.push(w);
    packages.set(w.claimId, c.package);
    prev = w.claimId;
  }
  return { meter, windows, packages, devices: registry([{ id: "solar-1", pub: meter.pub }]) };
}
const meteredInHour = (d, h) => d.packages.get(d.windows[h].claimId).reduce((s, r) => s + r.wh, 0);

// EnergyTag bundles of 1 Wh certificates, one per hour, numbered consecutively.
function bundles(d, { whFor = (h) => meteredInHour(d, h), hours = 6, start = 1 } = {}) {
  let next = start;
  return Array.from({ length: hours }, (_, h) => {
    const q = whFor(h);
    const b = { issuance_id: `GC-${h}`, device_id: 7, face_value: 1, bundle_quantity: q, certificate_bundle_id_range_start: next, certificate_bundle_id_range_end: next + q - 1, production_starting_interval: iso(T0 + h * H), production_ending_interval: iso(T0 + (h + 1) * H), certificate_bundle_status: "Active" };
    next += q;
    return fromEnergyTagBundle(b, { registry: "gc-test", deviceOf: () => "solar-1" });
  });
}
const reasons = (r) => r.problems.map((p) => p.reason);

test("certificates matching the signed meter pass", () => {
  const d = meterData();
  const r = checkCertificates({ certificates: bundles(d), ...d });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.periods.length, 6);
  assert.equal(r.certifiedWh, r.supportedWh);
  assert.ok(r.periods.every((p) => p.headroomWh === 0));
});

test("more certified than metered in one hour is caught, with the excess", () => {
  const d = meterData();
  const r = checkCertificates({ certificates: bundles(d, { whFor: (h) => meteredInHour(d, h) + (h === 3 ? 2500 : 0) }), ...d });
  const p = r.problems.find((x) => x.reason === "certified_more_than_metered");
  assert.equal(p.overWh, 2500);
  assert.equal(p.from, T0 + 3 * H);
  assert.equal(r.unsupportedWh, 2500);
});

test("the same certificate ids issued twice are caught", () => {
  const d = meterData();
  const certs = bundles(d);
  certs.push({ ...certs[2], id: "GC-2-again", from: T0 + 7 * H, to: T0 + 8 * H });
  assert.ok(reasons(checkCertificates({ certificates: certs, ...d })).includes("certificate_ids_issued_twice"));
});

test("a bundle whose id range does not match its quantity is caught", () => {
  const d = meterData();
  const certs = bundles(d);
  certs[0] = { ...certs[0], count: certs[0].count + 1 };
  assert.ok(reasons(checkCertificates({ certificates: certs, ...d })).includes("bundle_quantity_does_not_match_id_range"));
});

test("a certificate for an hour with no signed meter data is not supported", () => {
  const d = meterData({ hours: 5 });
  const r = checkCertificates({ certificates: bundles(d, { hours: 5 }).concat(bundles(d, { hours: 1, start: 1e6 }).map((c) => ({ ...c, id: "late", from: T0 + 9 * H, to: T0 + 10 * H }))), ...d });
  assert.ok(reasons(r).includes("certificate_period_not_metered"));
  assert.equal(r.periods.find((p) => p.from === T0 + 9 * H).status, "not_metered");
});

test("meter data signed long after the hour (back-filled) supports nothing", () => {
  const d = meterData({ lagMs: 30 * H });
  const r = checkCertificates({ certificates: bundles(d), ...d });
  assert.ok(reasons(r).includes("window_backfilled"));
  assert.equal(r.supportedWh, 0);
  assert.equal(checkCertificates({ certificates: bundles(d), ...d, creditBackfilled: true }).supportedWh, r.certifiedWh);
});

test("a reading edited after signing is caught and its hour unsupported", () => {
  const d = meterData();
  const id = d.windows[2].claimId;
  d.packages.set(id, d.packages.get(id).map((x, i) => (i === 0 ? { ...x, wh: x.wh + 5000 } : x)));
  const r = checkCertificates({ certificates: bundles(d), ...d });
  assert.ok(reasons(r).includes("readings_do_not_match_signed_root"));
  assert.equal(r.periods[2].status, "not_metered");
});

test("a window signed by an unregistered key or rewritten is caught", () => {
  const d = meterData();
  const other = genKeypair();
  d.windows[1] = signRecord(other, contentOf(d.windows[1]));
  const r = checkCertificates({ certificates: bundles(d), ...d });
  assert.ok(reasons(r).includes("window_signer_not_registered_key"));
  assert.ok(reasons(r).includes("device_chain_break"));
});

test("missing readings need a signed gap record", () => {
  const d = meterData({ skip: ["4.2"] });
  const certs = bundles(d);
  assert.ok(reasons(checkCertificates({ certificates: certs, ...d })).includes("missing_readings_not_recorded"));
  const gw = genKeypair();
  const g = gap(gw, { service: "gateway", device: "solar-1", from: T0 + 4 * H + 2 * Q, to: T0 + 4 * H + 3 * Q, reason: "inverter comms lost", noticedAt: T0 + 5 * H });
  assert.equal(checkCertificates({ certificates: certs, ...d, gaps: [g], gatewayPub: gw.pub }).ok, true);
});

test("certificate periods that overlap differently are refused", () => {
  const d = meterData();
  const certs = bundles(d);
  certs[1] = { ...certs[1], from: certs[1].from - Q };
  const r = checkCertificates({ certificates: certs, ...d });
  assert.ok(reasons(r).includes("certificate_periods_overlap"));
});

test("withdrawn certificates do not count; claimed (Cancelled) ones do", () => {
  const d = meterData();
  const extra = { ...bundles(d, { hours: 1, start: 1e6 })[0], id: "extra" };
  assert.equal(checkCertificates({ certificates: [...bundles(d), { ...extra, status: "Withdrawn" }], ...d }).ok, true);
  assert.ok(reasons(checkCertificates({ certificates: [...bundles(d), { ...extra, status: "Cancelled" }], ...d })).includes("certified_more_than_metered"));
});

test("Project Origin issued events are checked with the opened quantity", () => {
  const d = meterData({ hours: 1 });
  const event = { certificate_id: { registry: "energinet.dk", stream_id: { value: "6f0b..." } }, type: 2, period: { start: { seconds: T0 / 1000 }, end: { seconds: (T0 + H) / 1000 } }, grid_area: "DK1", asset_id_hash: "a1b2" };
  const ok = fromProjectOriginIssued(event, { quantityWh: meteredInHour(d, 0), deviceOf: () => "solar-1" });
  assert.equal(ok.registry, "energinet.dk");
  assert.equal(checkCertificates({ certificates: [ok], ...d }).ok, true);
  const over = fromProjectOriginIssued(event, { quantityWh: meteredInHour(d, 0) + 1, deviceOf: () => "solar-1" });
  assert.ok(reasons(checkCertificates({ certificates: [over], ...d })).includes("certified_more_than_metered"));
});

test("one reading can be proven to a buyer without showing the others", () => {
  const readings = [0, 1, 2, 3].map((q) => ({ t: T0 + q * Q, wh: 1000 + q }));
  const c = commitEnergy(readings);
  const w = window(genKeypair(), { device: "solar-1", project: "farm", from: T0, to: T0 + H, intervalMs: Q, seq: 0, prev: null, c, recordedAt: T0 + H });
  const p = energyProof(c, readings[2]);
  assert.equal(energyIncluded(w, readings[2], p), true);
  assert.equal(energyIncluded(w, { ...readings[2], wh: readings[2].wh + 1 }, p), false);
});
