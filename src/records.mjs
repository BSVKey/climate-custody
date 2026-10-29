// Signed records for proof of measurement behind climate money (carbon credits, methane
// reductions, renewable energy certificates). Evidence only: a record proves what its signer
// stated, and when, not that it is true. What the records CAN show is whether the numbers a
// credit rests on were fixed at the time they were measured, by a known device, under a valid
// calibration, and whether the same tonne was issued or retired twice.
//
//   climate.window/1       signed by the DEVICE key (in the meter or its gateway) at the end of
//                          each measurement window: one Merkle root over every reading, the
//                          count, the expected count, and when it was signed (recordedAt).
//                          Chained window to window per device.
//   climate.calibration/1  signed by a CALIBRATION LAB: device, certificate, valid from/to.
//   climate.claim/1        signed by the PROJECT DEVELOPER: the tonnes claimed for a vintage,
//                          the windows they rest on, and the calculation method + parameters.
//   climate.verification/1 signed by the third-party VERIFIER: names one exact claim version.
//   climate.issuance/1     signed by a REGISTRY: a serial range issued against one claim.
//   climate.retirement/1   signed by a REGISTRY: a serial range retired for a beneficiary.
//   climate.gap/1          signed by the device gateway or the witness service: an expected
//                          window did not arrive (power cut, comms loss), with the reason given.
//
// Readings are integers: CH4 in basis points of volume (5012 = 50.12%), gas flow in litres at
// normal conditions per interval, flare temperature in whole degrees C.
import { randomBytes } from "node:crypto";
import { signRecord } from "../lib/record.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

// Leaves are salted (salted-leaf/1), as in the other BSVKey custody cores: 16 random bytes per
// reading, leaves ordered by salted hash, so one reading's proof cannot be used to guess its
// neighbours. The full disclosure package (readings + salts) goes to the verifier; a single
// reading can be proven to anyone else on its own.
export const LEAF_SCHEME = "salted-leaf/1";
const SALT_RE = /^[0-9a-f]{32}$/;
const randomSalt = () => randomBytes(16).toString("hex");
const saltedLeaf = (salt, s) => leafHash(Buffer.from(`${salt}|${s}`, "utf8"));
export const readingKey = (r) => `${r.t}|${r.ch4Bp}|${r.flowL}|${r.flareC}`;

// Commit one window of readings. Returns the root plus the disclosure package.
// keyOf turns a reading into its leaf text; the default is the flare reading above, and
// src/granular.mjs passes energyKey for metered energy.
export function commitReadings(readings, { saltOf = randomSalt, keyOf = readingKey } = {}) {
  const entries = readings.map((r) => {
    const key = keyOf(r);
    const salt = saltOf(key);
    if (!SALT_RE.test(salt)) throw new Error("salt must be 32 lowercase hex characters");
    return { r, key, salt, leaf: saltedLeaf(salt, key) };
  });
  if (new Set(entries.map((e) => e.key)).size !== entries.length) throw new Error("commitReadings: duplicate reading");
  entries.sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));
  const tree = buildTree(entries.map((e) => e.leaf));
  return { root: tree.root, count: entries.length, scheme: LEAF_SCHEME, package: entries.map((e) => ({ ...e.r, salt: e.salt })), tree, keys: entries.map((e) => e.key) };
}

// Recompute a window root from a disclosure package (readings with their salts).
export function rootOfPackage(pkg, keyOf = readingKey) {
  const leaves = pkg.map((p) => saltedLeaf(p.salt, keyOf(p))).sort();
  return leaves.length ? buildTree(leaves).root : null;
}

export function readingProof(c, r, keyOf = readingKey) {
  const i = c.keys.indexOf(keyOf(r));
  return i < 0 ? null : { index: i, salt: c.package[i].salt, branch: proof(c.tree, i) };
}
export const readingIncluded = (win, r, p, keyOf = readingKey) =>
  !!p && SALT_RE.test(p.salt) && p.index >= 0 && p.index < win.count && verifyProof(saltedLeaf(p.salt, keyOf(r)), p.branch, p.index, win.readingsRoot);

export const window = (kp, { device, project, from, to, intervalMs, seq, prev, c, recordedAt }) =>
  signRecord(kp, { kind: "climate.window/1", device, project, from, to, intervalMs, expected: Math.round((to - from) / intervalMs), seq, prev, readingsRoot: c.root, count: c.count, scheme: c.scheme, recordedAt });

export const calibration = (kp, { lab, device, cert, validFrom, validTo, signedAt }) =>
  signRecord(kp, { kind: "climate.calibration/1", lab, device, cert, validFrom, validTo, signedAt });

export const claim = (kp, { project, developer, vintage, windows, method, params, claimedG, signedAt }) =>
  signRecord(kp, { kind: "climate.claim/1", project, developer, vintage, windows, method, params, claimedG, signedAt });

export const verification = (kp, { claimRef, verifier, opinion, at }) =>
  signRecord(kp, { kind: "climate.verification/1", claimRef, verifier, opinion, at });

export const issuance = (kp, { registry, claimRef, project, serialFrom, serialTo, at }) =>
  signRecord(kp, { kind: "climate.issuance/1", registry, claimRef, project, serialFrom, serialTo, units: serialTo - serialFrom + 1, at });

export const retirement = (kp, { registry, project, serialFrom, serialTo, beneficiary, at }) =>
  signRecord(kp, { kind: "climate.retirement/1", registry, project, serialFrom, serialTo, units: serialTo - serialFrom + 1, beneficiary, at });

export const gap = (kp, { service, device, from, to, reason, noticedAt }) =>
  signRecord(kp, { kind: "climate.gap/1", service, device, from, to, reason, noticedAt });
