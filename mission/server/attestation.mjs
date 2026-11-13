/**
 * Aero Atlas Mission Escrow — attestation recording + Verification Center bridge.
 *
 * The mission agent runs on NEAR AI Cloud (TEE-served model). After the agent's
 * deliverable-producing turn, the server calls `InferenceClient.verifyResponse`
 * and records the result here. `propose_payment` then gates on a recorded
 * verified attestation, and the proposal card renders:
 *
 *   1. a "verified" badge (provider_tee / gateway),
 *   2. a reply receipt link for https://cloud.near.ai/verify (the browser
 *      re-checks the signature against fresh evidence), and
 *   3. an embedded Verification Center iframe (HTTPS required) that renders the
 *      VerificationReport[] below.
 *
 * The contract enforces spend only; attestation is verified OFF-CHAIN and
 * displayed, never claimed as an on-chain check.
 *
 * Field shapes mirror the @nearai/inference-sdk `verifyResponse` result and the
 * docs at https://docs.near.ai/cloud/verification (Embedded + Response
 * Signatures pages).
 */

/**
 * The verified attestation for the current deliverable. Populated from the
 * @nearai/inference-sdk `verifyResponse(id)` result.
 *
 * @typedef {object} Attestation
 * @property {string} completionId   response id (the CHAT_ID)
 * @property {string} model          canonical model id, e.g. "z-ai/glm-5.3-flash"
 * @property {"provider_tee"|"gateway"} signatureKind
 * @property {"ed25519"|"ecdsa"} signingAlgo
 * @property {string} signingAddress signer address (ecdsa) or hex pubkey (ed25519)
 * @property {string} signedText     "<MODEL_ID>:<request_hash>:<response_hash>" or "<request_hash>:<response_hash>"
 * @property {string} signature      signature over signedText
 * @property {number} verifiedAt     epoch ms when the app verified it
 */

let current = null;

/** Record the verified attestation for the latest deliverable turn. */
export function recordAttestation(att) {
  current = normalize(att);
  return current;
}

/** Return the recorded attestation, or null if nothing is verified yet. */
export function getAttestation() {
  return current;
}

export function clearAttestation() {
  current = null;
}

function normalize(att) {
  if (!att || typeof att !== "object") return null;
  // Accept both the raw SDK result and an already-normalized object.
  const signature = att.signature || {};
  const signer = signature.signer || att.signer || {};
  return {
    completionId: String(att.completionId || att.id || ""),
    model: String(att.model || ""),
    signatureKind: att.signatureKind === "gateway" ? "gateway" : "provider_tee",
    signingAlgo: signer.signingAlgo === "ecdsa" ? "ecdsa" : "ed25519",
    signingAddress: String(signer.signingAddress || ""),
    signedText: String(signature.signedText || att.signedText || ""),
    signature: String(signature.signature || att.signature || ""),
    verifiedAt: Number(att.verifiedAt || Date.now()),
  };
}

/**
 * Build the base64url JSON receipt for the Verification Center URL fragment:
 *   https://cloud.near.ai/verify?model=<MODEL>#receipt=<BASE64URL_JSON>
 * The receipt travels in the fragment, so it never leaves the browser.
 */
export function receiptPayload(att) {
  const a = normalize(att);
  if (!a) return null;
  return {
    completionId: a.completionId,
    model: a.model,
    signatureKind: a.signatureKind,
    signingAlgo: a.signingAlgo,
    signingAddress: a.signingAddress,
    signedText: a.signedText,
    signature: a.signature,
    verifiedAt: a.verifiedAt,
  };
}

export function receiptUrl(att, base = "https://cloud.near.ai/verify") {
  const a = normalize(att);
  if (!a) return null;
  const json = JSON.stringify(receiptPayload(a));
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const model = encodeURIComponent(a.model);
  return `${base}?model=${model}#receipt=${b64}`;
}

/**
 * Build the VerificationReport[] for the embedded Verification Center iframe.
 * Field names and constraints follow the Embedded page:
 *   - model scope requires `provider_tee`, gpuEvidence, status "verified"
 *   - gateway scope requires `tlsBinding`, status "partial"
 *   - whitelist fields only — never send chat content, raw SDK results, keys.
 */
export function buildReports(att) {
  const a = normalize(att);
  if (!a) return [];
  const isModel = a.signatureKind === "provider_tee";
  const report = {
    schemaVersion: 1,
    kind: "response",
    completionId: a.completionId,
    model: a.model,
    scope: isModel ? "model" : "gateway",
    status: isModel ? "verified" : "partial",
    signature: {
      kind: a.signatureKind,
      signer: { signingAlgo: a.signingAlgo, signingAddress: a.signingAddress },
      signedText: a.signedText,
      signature: a.signature,
    },
  };
  // The iframe needs an `attestation` block with a matching signer identity.
  // We carry a minimal summary; the live path can enrich this from the SDK's
  // VerifiedModelAttestation (tcbStatus, deployment, gpuEvidence) before
  // recording. Absent that, the viewer will show "partial" rather than lie.
  report.attestation = {
    signer: { signingAlgo: a.signingAlgo, signingAddress: a.signingAddress },
    tcbStatus: "Unknown",
    advisoryIds: [],
    deploymentProvenance: "not_checked",
    deployment: { runtimeMeasurements: null },
    gpuEvidence: isModel ? "not_provided" : undefined,
    signingPublicKey: a.signingAddress,
  };
  return [report];
}
