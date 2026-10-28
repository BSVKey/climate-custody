// Re-derive a credit claim from the signed measurements under it, and check that each tonne was
// issued and retired once.
//
// Every check here is about what was signed, by whom and when. A PASS means the claimed tonnes
// follow from readings that were fixed at measurement time by a registered device under a valid
// calibration, using the stated method. It does NOT mean the method, the baseline or the
// project itself is sound; those are judgement calls this code cannot make.
import { verifyRecord } from "../lib/record.mjs";
import { rootOfPackage } from "./records.mjs";

const signedBy = (r, pub) => { const v = verifyRecord(r); return !v.ok ? v.reason : v.signer !== pub ? "signer_not_pinned_key" : null; };

// Calculation methods by name. Each returns grams CO2e for one reading, rounding down.
// illustrative-lfg/1 is a simplified landfill-gas flare calculation for the demo, NOT a
// registry methodology: CH4 mass = flow x CH4 fraction x density; credited only while the flare
// is hot enough to be burning; CO2e = CH4 x GWP x destruction efficiency.
export const METHODS = {
  "illustrative-lfg/1": (r, p) => {
    if (r.flareC < p.minFlareC) return 0;
    const gCh4 = Math.floor((r.flowL * r.ch4Bp * p.densityGPerNm3) / (1000 * 10000));
    return Math.floor((gCh4 * p.gwp * p.destructionBp) / 10000);
  },
};

// Verify one claim against its windows.
//   windows:      Map claimId -> climate.window/1 record (everything the device published)
//   packages:     Map window claimId -> disclosure package (readings with salts)
//   devices:      registry() of device keys (lib/record.mjs), checked at each window's recordedAt
//   calibrations: climate.calibration/1 records; labPub: the lab key the verifier trusts
//   gaps:         climate.gap/1 records; gatewayPub: the key allowed to sign them
//   maxLagMs:     a window signed later than this after it closed is "back-filled": its numbers
//                 were not fixed at measurement time, so by default it earns nothing
export function verifyClaim(c, { developerPub, windows, packages, devices, calibrations = [], labPub, gaps = [], gatewayPub, maxLagMs = 2 * 3600000, creditBackfilled = false }) {
  const problems = [];
  const s = signedBy(c, developerPub);
  if (s) return { ok: false, problems: [{ reason: "claim_" + s }], recomputedG: 0, claimedG: c.claimedG, windows: [] };
  const method = METHODS[c.method];
  if (!method) return { ok: false, problems: [{ reason: "unknown_method", method: c.method }], recomputedG: 0, claimedG: c.claimedG, windows: [] };

  const cals = calibrations.filter((k) => !signedBy(k, labPub));
  const calibrated = (device, t) => cals.some((k) => k.device === device && k.validFrom <= t && t < k.validTo);
  const gapsOk = gaps.filter((g) => !signedBy(g, gatewayPub));

  const rows = [];
  const lastByDevice = new Map();
  const wins = c.windows.map((id) => windows.get(id) || { missingId: id }).sort((a, b) => (a.device ?? "").localeCompare(b.device ?? "") || (a.seq ?? 0) - (b.seq ?? 0));
  for (const w of wins) {
    if (w.missingId) { problems.push({ reason: "window_not_published", window: w.missingId }); continue; }
    const row = { window: w.claimId, device: w.device, from: w.from, to: w.to, readings: 0, missing: 0, uncalibrated: 0, flareOff: 0, creditedG: 0, status: "ok" };
    rows.push(row);
    const v = verifyRecord(w);
    if (!v.ok) { row.status = "invalid"; problems.push({ reason: "window_" + v.reason, window: w.claimId }); continue; }
    const k = devices.check(w.device, w.signerPub, w.recordedAt);
    if (k) { row.status = "invalid"; problems.push({ reason: "window_" + k, window: w.claimId }); continue; }
    if (w.from < c.vintage.from || w.to > c.vintage.to) { row.status = "outside_vintage"; problems.push({ reason: "window_outside_vintage", window: w.claimId }); continue; }
    const last = lastByDevice.get(w.device);
    if (last && (w.prev !== last.claimId || w.seq !== last.seq + 1)) problems.push({ reason: "device_chain_break", window: w.claimId });
    lastByDevice.set(w.device, w);

    const pkg = packages.get(w.claimId);
    if (!pkg) { row.status = "undisclosed"; problems.push({ reason: "readings_not_disclosed", window: w.claimId }); continue; }
    if (pkg.length !== w.count || rootOfPackage(pkg) !== w.readingsRoot) { row.status = "readings_altered"; problems.push({ reason: "readings_do_not_match_signed_root", window: w.claimId }); continue; }
    if (pkg.some((r) => r.t < w.from || r.t >= w.to)) { row.status = "readings_altered"; problems.push({ reason: "reading_outside_window", window: w.claimId }); continue; }

    row.lagMs = w.recordedAt - w.to;
    if (row.lagMs > maxLagMs) { row.status = "backfilled"; problems.push({ reason: "window_backfilled", window: w.claimId, lagHours: Math.round(row.lagMs / 3600000) }); }

    row.readings = pkg.length;
    row.missing = w.expected - pkg.length;
    if (row.missing > 0 && !gapsOk.some((g) => g.device === w.device && g.from < w.to && g.to > w.from)) problems.push({ reason: "missing_readings_not_recorded", window: w.claimId, missing: row.missing });
    let g = 0;
    for (const r of pkg) {
      if (!calibrated(w.device, r.t)) { row.uncalibrated++; continue; }
      const x = method(r, c.params);
      if (x === 0 && r.flareC < c.params.minFlareC) row.flareOff++;
      g += x;
    }
    if (row.uncalibrated) problems.push({ reason: "readings_outside_calibration", window: w.claimId, readings: row.uncalibrated });
    row.creditedG = row.status === "backfilled" && !creditBackfilled ? 0 : g;
  }

  const recomputedG = rows.reduce((a, r) => a + r.creditedG, 0);
  const overclaimG = Math.max(0, c.claimedG - recomputedG);
  if (overclaimG > 0) problems.push({ reason: "claim_exceeds_recomputed", claimedG: c.claimedG, recomputedG, overclaimG });
  return { ok: problems.length === 0, problems, recomputedG, claimedG: c.claimedG, overclaimG, creditableTonnes: Math.floor(Math.min(c.claimedG, recomputedG) / 1e6), windows: rows };
}

// Which claim version did the verifier actually sign off? A claim revised after verification is
// reported, not hidden.
export function verifyOpinion(versions, opinions, { verifierPub }) {
  const sorted = [...versions].sort((a, b) => a.signedAt - b.signedAt);
  const latest = sorted.at(-1);
  const ok = opinions.filter((o) => !signedBy(o, verifierPub));
  const hit = sorted.map((v) => ok.find((o) => o.claimRef === v.claimId)).map((o, i) => (o ? i : -1)).filter((i) => i >= 0);
  const verifiedIndex = hit.length ? hit.at(-1) : -1;
  return {
    latest: latest.claimId,
    versions: sorted.length,
    verifiedVersion: verifiedIndex,
    latestVerified: verifiedIndex === sorted.length - 1,
    revisedAfterVerification: verifiedIndex >= 0 && verifiedIndex < sorted.length - 1,
    claimedChange: verifiedIndex >= 0 ? latest.claimedG - sorted[verifiedIndex].claimedG : null,
  };
}

// The same measurement window under two claims is the same tonne counted twice.
export function windowsCountedTwice(claims) {
  const seen = new Map(), dup = [];
  for (const c of claims) for (const w of c.windows) {
    if (seen.has(w) && seen.get(w) !== c.claimId) dup.push({ window: w, claims: [seen.get(w), c.claimId] });
    else seen.set(w, c.claimId);
  }
  return dup;
}

// Issuance and retirement across one or more registries.
//   creditable: Map claimId -> whole tonnes the claim supports (verifyClaim().creditableTonnes)
//   registries: Map registry name -> pub
// Serial numbers are scoped per registry and project.
export function checkLedger({ issuances, retirements, creditable, registries }) {
  const problems = [];
  const valid = (r) => { const pub = registries.get(r.registry); const s = pub ? signedBy(r, pub) : "registry_unknown"; if (s) problems.push({ reason: `${r.kind.split("/")[0].split(".")[1]}_${s}`, registry: r.registry }); return !s; };
  const iss = issuances.filter(valid), ret = retirements.filter(valid);

  const perClaim = new Map();
  for (const i of iss) perClaim.set(i.claimRef, [...(perClaim.get(i.claimRef) || []), i]);
  for (const [claimId, list] of perClaim) {
    const units = list.reduce((a, i) => a + i.units, 0), cap = creditable.get(claimId) ?? 0;
    const regs = [...new Set(list.map((i) => i.registry))];
    if (regs.length > 1) problems.push({ reason: "issued_at_two_registries", claimId, registries: regs, units });
    if (units > cap) problems.push({ reason: "issued_more_than_measured", claimId, units, creditable: cap });
  }

  const scope = (r) => `${r.registry}|${r.project}`;
  const issuedIn = (r) => iss.some((i) => scope(i) === scope(r) && i.serialFrom <= r.serialFrom && r.serialTo <= i.serialTo);
  const byScope = new Map();
  for (const r of ret) {
    if (!issuedIn(r)) problems.push({ reason: "retired_not_issued", registry: r.registry, serialFrom: r.serialFrom, serialTo: r.serialTo });
    const prior = byScope.get(scope(r)) || [];
    const clash = prior.find((p) => p.serialFrom <= r.serialTo && r.serialFrom <= p.serialTo);
    if (clash) problems.push({ reason: "retired_twice", registry: r.registry, serials: [Math.max(clash.serialFrom, r.serialFrom), Math.min(clash.serialTo, r.serialTo)], beneficiaries: [clash.beneficiary, r.beneficiary] });
    byScope.set(scope(r), [...prior, r]);
  }
  return { ok: problems.length === 0, problems, issuedUnits: iss.reduce((a, i) => a + i.units, 0), retiredUnits: ret.reduce((a, r) => a + r.units, 0) };
}
