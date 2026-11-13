/**
 * Private PR-review agent — the submission's headline.
 *
 * Paste a diff; the attested worker reviews it in a NEAR-verified TEE model and
 * returns the review plus a three-tier honesty label:
 *
 *   verified     provider_tee signature checked via verifyResponse()
 *   partial      gateway signature only — model TEE execution NOT proven
 *   unverified   local MLX fallback after a 402 — no attestation, no receipt
 *
 * The tier is derived from the actual proof, never asserted. Only "verified"
 * and "partial" carry a Verification Center receipt link; "unverified" fails
 * closed with no receipt.
 *
 * This is Illia Polosukhin's own suggested idea ("code review that is fully
 * private"), and the worker is the whole backend — no contract, no payments.
 */

import { runAttested } from "./near-inference.mjs";
import { getAttestation, receiptUrl } from "./attestation.mjs";

export const TIER_LABELS = {
  verified: "VERIFIED — provider_tee signature checked via verifyResponse()",
  partial: "PARTIALLY VERIFIED — gateway signature; model TEE execution not proven",
  unverified: "UNVERIFIED — LOCAL MLX FALLBACK (no attestation, no receipt)",
};

export function tierFor(source, signatureKind) {
  if (source === "tee") {
    return signatureKind === "provider_tee" ? "verified" : "partial";
  }
  return "unverified";
}

/** Review a diff with the attested worker and return the review + proof tier. */
export async function reviewDiff(diff) {
  const prompt = [
    "You are a senior code reviewer. Review the following diff for correctness and security.",
    "Report each finding as: severity (high/medium/low), file:line, the problem, and a concrete fix.",
    "Be specific and concise. Do not pad.",
    "",
    "```diff",
    String(diff || "").slice(0, 40_000),
    "```",
  ].join("\n");

  const result = await runAttested({ messages: [{ role: "user", content: prompt }] });
  const tier = tierFor(result.source, result.proof?.signatureKind);
  const att = getAttestation();
  const review = result.completion?.choices?.[0]?.message?.content || "";

  return {
    review: review || (tier === "unverified"
      ? "No inference backend is configured — set NEARAI_API_KEY for the verified TEE path, or run a local MLX server for the fallback."
      : ""),
    tier,
    tierLabel: TIER_LABELS[tier],
    signatureKind: result.proof?.signatureKind || null,
    model: result.proof?.model || "local-mlx (fallback)",
    completionId: result.proof?.completionId || null,
    receiptUrl: tier === "unverified" ? null : receiptUrl(att),
    upstream: result.source === "mlx" ? result.fallbackReason || "HTTP 402" : null,
  };
}
