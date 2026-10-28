// Signed, content-addressed records and a registry of the keys allowed to sign them.
// Every record is content-addressed (claimId = sha256 of its canonical content) and signed;
// a verifier recomputes the id and checks the signature under the carried public key
// (production recovers the signer from a Bitcoin Signed Message envelope instead).
import { contentId } from "./canonical.mjs";
import { signClaim, verifySig } from "./keys.mjs";

export function signRecord(kp, content) {
  const claimId = contentId(content);
  return { ...content, claimId, sig: signClaim(kp.priv, claimId), signerPub: kp.pub };
}

// { ok:true, signer } / { ok:false, reason }
export function verifyRecord(rec) {
  if (rec === null || typeof rec !== "object") return { ok: false, reason: "not_an_object" };
  if (contentId(rec).toLowerCase() !== String(rec.claimId).toLowerCase()) return { ok: false, reason: "claimId_mismatch" };
  if (!rec.signerPub || !rec.sig) return { ok: false, reason: "missing_credential" };
  if (!verifySig(rec.signerPub, rec.claimId, rec.sig)) return { ok: false, reason: "signature_invalid" };
  return { ok: true, signer: rec.signerPub };
}

// Strip the credential fields so a record can be edited and re-signed (used by demos and
// tests to model a party forging or rewriting its own records).
export const contentOf = ({ claimId, sig, signerPub, ...c }) => c;

// Key registry: who may sign, with which key, over which period.
//   entries: [{ id, pub, validFrom?, revokedAt?, ...attributes }]
// A record signed at time `at` is accepted for `id` only if the key was valid then. An id
// may have several entries over time (key rotation).
export function registry(entries) {
  const byId = new Map();
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) || []), e]);
  return {
    has: (id) => byId.has(id),
    attrs: (id) => byId.get(id)?.[0],
    // null when accepted, otherwise the reason it is not.
    check(id, pub, at) {
      const list = byId.get(id);
      if (!list) return "signer_not_registered";
      const e = list.find((x) => x.pub === pub);
      if (!e) return "signer_not_registered_key";
      if (e.validFrom !== undefined && at < e.validFrom) return "key_not_yet_valid";
      if (e.revokedAt !== undefined && at >= e.revokedAt) return "key_revoked";
      return null;
    },
  };
}
