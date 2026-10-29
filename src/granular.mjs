// Granular (hourly) energy certificates checked against signed meter data.
//
// Hourly certificate registries (EnergyTag-style Granular Certificates, e.g. the open-source
// Future Energy Associates registry; Energinet's Project Origin) issue certificates from
// metered production. In both, the registry takes the meter data on trust: a CSV upload or
// an issuing body's word. Here the meter (or its gateway) signs each window of energy
// readings when the window closes (climate.window/1, salted Merkle root, chained), and anyone
// holding the readings can check every certificate against them:
//
//   - a certificate period with no signed meter data behind it
//   - more energy certified for a device and period than the signed meter recorded
//   - the same certificate ids issued twice
//   - meter data signed long after the hour (back-filled), edited after signing, missing
//     without a recorded gap, or with a broken window chain
//
// Evidence only. A PASS says the certificates do not exceed what a registered meter signed
// at measurement time; it says nothing about the meter's accuracy beyond its calibration
// records, the device's eligibility, or the registry's other rules.
import { verifyRecord } from "../lib/record.mjs";
import { commitReadings, rootOfPackage, readingProof, readingIncluded } from "./records.mjs";

// Energy readings: { t (interval start, ms), wh (integer Wh produced in the interval) }.
export const energyKey = (r) => `${r.t}|${r.wh}`;
export const commitEnergy = (readings, opts = {}) => commitReadings(readings, { ...opts, keyOf: energyKey });
export const energyRoot = (pkg) => rootOfPackage(pkg, energyKey);
export const energyProof = (c, r) => readingProof(c, r, energyKey);
export const energyIncluded = (win, r, p) => readingIncluded(win, r, p, energyKey);

// Certificates are compared in one normalized shape:
//   { registry, id, device, from, to, wh, ids?: [first, last], status? , source }
// with adapters for the registries' own shapes.

// EnergyTag / Future Energy Associates GranularCertificateBundle (gc_registry/certificate):
// face_value is Wh per certificate; bundle_quantity certificates numbered
// certificate_bundle_id_range_start..end. deviceOf maps device_id to the meter's device name.
export function fromEnergyTagBundle(b, { registry, deviceOf = (id) => String(id) } = {}) {
  return {
    registry,
    id: b.issuance_id ?? `${b.certificate_bundle_id_range_start}-${b.certificate_bundle_id_range_end}`,
    device: deviceOf(b.device_id),
    from: Date.parse(b.production_starting_interval),
    to: Date.parse(b.production_ending_interval),
    wh: b.bundle_quantity * b.face_value,
    ids: [b.certificate_bundle_id_range_start, b.certificate_bundle_id_range_end],
    count: b.bundle_quantity,
    status: b.certificate_bundle_status,
    source: "energytag",
  };
}

// Project Origin electricity IssuedEvent (protos/electricity.proto). The quantity is hidden in
// a Pedersen commitment; whoever audits must be given the opening (the quantity and its
// r value). quantityWh is that opened quantity. This adapter does NOT check the opening
// against the commitment; that needs Project Origin's own library.
export function fromProjectOriginIssued(e, { registry = "project-origin", quantityWh, deviceOf = (h) => h } = {}) {
  const ts = (x) => (typeof x === "string" ? Date.parse(x) : Number(x.seconds) * 1000 + Math.floor((x.nanos ?? 0) / 1e6));
  return {
    registry: e.certificate_id?.registry ?? registry,
    id: e.certificate_id?.stream_id?.value ?? e.certificate_id,
    device: deviceOf(e.asset_id_hash),
    from: ts(e.period.start),
    to: ts(e.period.end),
    wh: quantityWh,
    source: "project-origin",
    type: e.type,
  };
}

const signedBy = (r, pub) => { const v = verifyRecord(r); return !v.ok ? v.reason : v.signer !== pub ? "signer_not_pinned_key" : null; };

// Check certificates against signed energy windows.
//   certificates: normalized certificates (see the adapters above)
//   windows:      climate.window/1 records from the meters (readings committed with commitEnergy)
//   packages:     Map window claimId -> disclosure package ({ t, wh, salt } readings)
//   devices:      registry() of meter keys (lib/record.mjs), checked at each window's recordedAt
//   gaps:         climate.gap/1 records; gatewayPub: the key allowed to sign them
//   maxLagMs:     meter data signed later than this after its window closed is back-filled and
//                 counts for nothing by default (creditBackfilled to override)
export function checkCertificates({ certificates, windows, packages, devices, gaps = [], gatewayPub, maxLagMs = 2 * 3600000, creditBackfilled = false }) {
  const problems = [];
  const gapsOk = gaps.filter((g) => gatewayPub && !signedBy(g, gatewayPub));

  // 1. Which signed readings count, per device.
  const readingsByDevice = new Map(); // device -> Map(t -> { wh, intervalMs })
  const coverage = new Map(); // device -> [{ from, to, intervalMs }] of windows that count
  const byDevice = new Map();
  for (const w of windows) byDevice.set(w.device, [...(byDevice.get(w.device) || []), w]);
  const windowRows = [];
  for (const [device, list] of byDevice) {
    list.sort((a, b) => a.seq - b.seq);
    let last = null;
    for (const w of list) {
      const row = { window: w.claimId, device, from: w.from, to: w.to, status: "ok" };
      windowRows.push(row);
      const v = verifyRecord(w);
      if (!v.ok) { row.status = "invalid"; problems.push({ reason: "window_" + v.reason, window: w.claimId }); continue; }
      const k = devices.check(device, w.signerPub, w.recordedAt);
      if (k) { row.status = "invalid"; problems.push({ reason: "window_" + k, window: w.claimId }); continue; }
      if (last && (w.prev !== last.claimId || w.seq !== last.seq + 1)) problems.push({ reason: "device_chain_break", window: w.claimId, device });
      last = w;
      const pkg = packages.get(w.claimId);
      if (!pkg) { row.status = "undisclosed"; problems.push({ reason: "readings_not_disclosed", window: w.claimId }); continue; }
      if (pkg.length !== w.count || energyRoot(pkg) !== w.readingsRoot) { row.status = "readings_altered"; problems.push({ reason: "readings_do_not_match_signed_root", window: w.claimId }); continue; }
      if (pkg.some((r) => r.t < w.from || r.t >= w.to || !Number.isInteger(r.wh) || r.wh < 0)) { row.status = "readings_altered"; problems.push({ reason: "reading_outside_window_or_invalid", window: w.claimId }); continue; }
      if (w.recordedAt - w.to > maxLagMs) {
        row.status = "backfilled";
        problems.push({ reason: "window_backfilled", window: w.claimId, lagHours: Math.round((w.recordedAt - w.to) / 3600000) });
        if (!creditBackfilled) continue;
      }
      const missing = w.expected - pkg.length;
      if (missing > 0 && !gapsOk.some((g) => g.device === device && g.from < w.to && g.to > w.from)) problems.push({ reason: "missing_readings_not_recorded", window: w.claimId, missing });
      const m = readingsByDevice.get(device) || new Map();
      for (const r of pkg) m.set(r.t, { wh: r.wh, intervalMs: w.intervalMs });
      readingsByDevice.set(device, m);
      coverage.set(device, [...(coverage.get(device) || []), { from: w.from, to: w.to }]);
    }
  }

  // 2. Certificate ids issued twice (per registry).
  const ranged = certificates.filter((c) => c.ids).sort((a, b) => a.registry.localeCompare(b.registry) || a.ids[0] - b.ids[0]);
  for (const c of ranged) if (c.count !== undefined && c.ids[1] - c.ids[0] + 1 !== c.count) problems.push({ reason: "bundle_quantity_does_not_match_id_range", certificate: c.id });
  for (let i = 1; i < ranged.length; i++) {
    const a = ranged[i - 1], b = ranged[i];
    if (a.registry === b.registry && b.ids[0] <= a.ids[1]) problems.push({ reason: "certificate_ids_issued_twice", registry: a.registry, ids: [b.ids[0], Math.min(a.ids[1], b.ids[1])], certificates: [a.id, b.id] });
  }

  // 3. Certified energy against metered energy, per device and period. Certificates for one
  //    device must share a period exactly or not overlap, or the energy cannot be attributed.
  // Withdrawn certificates no longer exist. Cancelled (claimed by a consumer) ones still
  // count: the energy was certified, then used.
  const live = certificates.filter((c) => c.status !== "Withdrawn");
  const groups = new Map();
  for (const c of live) {
    if (!(c.to > c.from) || !Number.isFinite(c.wh) || c.wh < 0) { problems.push({ reason: "certificate_unreadable", certificate: c.id }); continue; }
    const key = `${c.device}|${c.from}|${c.to}`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  const periods = [...groups.values()].map((list) => ({ device: list[0].device, from: list[0].from, to: list[0].to, certificates: list }));
  periods.sort((a, b) => a.device.localeCompare(b.device) || a.from - b.from);
  for (let i = 1; i < periods.length; i++) {
    const a = periods[i - 1], b = periods[i];
    if (a.device === b.device && b.from < a.to) problems.push({ reason: "certificate_periods_overlap", device: a.device, periods: [[a.from, a.to], [b.from, b.to]] });
  }
  const rows = periods.map((p) => {
    const certifiedWh = p.certificates.reduce((s, c) => s + c.wh, 0);
    const readings = readingsByDevice.get(p.device) || new Map();
    const covered = (coverage.get(p.device) || []).some((w) => w.from <= p.from && p.to <= w.to)
      || coveredBySeveral(coverage.get(p.device) || [], p.from, p.to);
    let meteredWh = 0, partial = 0;
    for (const [t, r] of readings) {
      const end = t + r.intervalMs;
      if (t >= p.from && end <= p.to) meteredWh += r.wh;
      else if (t < p.to && end > p.from) partial++;
    }
    const row = { device: p.device, from: p.from, to: p.to, certifiedWh, meteredWh, headroomWh: meteredWh - certifiedWh, certificates: p.certificates.map((c) => c.id), status: "ok" };
    if (!covered) { row.status = "not_metered"; problems.push({ reason: "certificate_period_not_metered", device: p.device, from: p.from, to: p.to, certifiedWh }); }
    else if (certifiedWh > meteredWh) { row.status = "over_issued"; problems.push({ reason: "certified_more_than_metered", device: p.device, from: p.from, to: p.to, certifiedWh, meteredWh, overWh: certifiedWh - meteredWh }); }
    if (partial) problems.push({ reason: "readings_straddle_certificate_period", device: p.device, from: p.from, to: p.to, readings: partial });
    return row;
  });

  const certifiedWh = rows.reduce((s, r) => s + r.certifiedWh, 0);
  const supportedWh = rows.reduce((s, r) => s + (r.status === "ok" ? r.certifiedWh : r.status === "over_issued" ? r.meteredWh : 0), 0);
  return { ok: problems.length === 0, problems, periods: rows, windows: windowRows, certifiedWh, supportedWh, unsupportedWh: certifiedWh - supportedWh };
}

// True when windows that count cover [from, to) without a hole.
function coveredBySeveral(list, from, to) {
  let at = from;
  for (const w of [...list].sort((a, b) => a.from - b.from)) {
    if (w.from > at) break;
    if (w.to > at) at = w.to;
    if (at >= to) return true;
  }
  return false;
}
