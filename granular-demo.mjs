// Hourly clean-energy certificates checked against a solar meter's signed readings.
//   node granular-demo.mjs
import { genKeypair } from "./lib/keys.mjs";
import { registry } from "./lib/record.mjs";
import { window, gap } from "./src/records.mjs";
import { commitEnergy, energyProof, energyIncluded, checkCertificates, fromEnergyTagBundle } from "./src/granular.mjs";

const H = 3600000, Q = 900000;
const day = Date.UTC(2026, 6, 1);
const meter = genKeypair(), gateway = genKeypair();
const devices = registry([{ id: "solar-farm-7", pub: meter.pub }]);

// A 5 MW solar farm on a clear day: 15-minute Wh readings from 06:00 to 20:00 UTC.
const whAt = (t) => {
  const h = (t - day) / H;
  return h < 6 || h >= 20 ? 0 : Math.round(5e6 * 0.25 * Math.sin(((h - 6) / 14) * Math.PI) ** 1.5);
};
const windows = [], packages = new Map(), committed = new Map();
let prev = null;
for (let h = 6; h < 20; h++) {
  const from = day + h * H;
  // 13:00 lost two readings to an inverter comms fault (the gateway records it);
  // 16:00 was signed the next morning, after someone "fixed" the data.
  const readings = [0, 1, 2, 3].map((q) => ({ t: from + q * Q, wh: whAt(from + q * Q) })).filter((r, q) => !(h === 13 && q >= 2));
  const c = commitEnergy(readings);
  const w = window(meter, { device: "solar-farm-7", project: "farm-7", from, to: from + H, intervalMs: Q, seq: h - 6, prev, c, recordedAt: h === 16 ? from + 18 * H : from + H + 60000 });
  windows.push(w); packages.set(w.claimId, c.package); committed.set(h, { c, w }); prev = w.claimId;
}
const gaps = [gap(gateway, { service: "gateway", device: "solar-farm-7", from: day + 13 * H + 2 * Q, to: day + 14 * H, reason: "inverter comms fault", noticedAt: day + 14 * H })];

// The registry issues 1 Wh certificates per hour. Hours 11 and 12 were issued from a
// forecast instead of the meter (+8%), and 21:00 from nothing at all.
const metered = (h) => packages.get(committed.get(h).w.claimId).reduce((s, r) => s + r.wh, 0);
let next = 1;
const issue = (h, wh) => {
  const b = { issuance_id: `GC-${h}`, device_id: 7, face_value: 1, bundle_quantity: wh, certificate_bundle_id_range_start: next, certificate_bundle_id_range_end: next + wh - 1, production_starting_interval: new Date(day + h * H).toISOString(), production_ending_interval: new Date(day + (h + 1) * H).toISOString(), certificate_bundle_status: "Active" };
  next += wh;
  return fromEnergyTagBundle(b, { registry: "demo-gc-registry", deviceOf: () => "solar-farm-7" });
};
const certificates = [];
for (let h = 6; h < 20; h++) certificates.push(issue(h, h === 11 || h === 12 ? Math.round(metered(h) * 1.08) : metered(h)));
certificates.push(issue(21, 150000));

const r = checkCertificates({ certificates, windows, packages, devices, gaps, gatewayPub: gateway.pub });
const kwh = (wh) => (wh / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }).padStart(9);
console.log("Solar farm 7, 2026-07-01: 14 hourly windows signed by the meter, 15 hourly certificate bundles");
console.log("hour (UTC)  certified kWh  metered kWh  status");
for (const p of r.periods) console.log(`${new Date(p.from).toISOString().slice(11, 16)}       ${kwh(p.certifiedWh)}    ${kwh(p.meteredWh)}  ${p.status}`);
console.log(`\nCertified ${kwh(r.certifiedWh).trim()} kWh; supported by signed meter data ${kwh(r.supportedWh).trim()} kWh; unsupported ${kwh(r.unsupportedWh).trim()} kWh`);
console.log("Problems:");
for (const p of r.problems) console.log(" ", p.reason, p.from ? new Date(p.from).toISOString().slice(11, 16) : "", p.overWh ? `+${(p.overWh / 1000).toFixed(1)} kWh` : "", p.lagHours ? `${p.lagHours} h late` : "");

const { c, w } = committed.get(12);
const one = c.package[1];
console.log(`\nA buyer checks one 15-minute reading (12:15, ${one.wh} Wh) against the meter's signed root: ${energyIncluded(w, one, energyProof(c, one))}`);
console.log(`  the same reading raised 5%: ${energyIncluded(w, { ...one, wh: Math.round(one.wh * 1.05) }, energyProof(c, one))}`);
