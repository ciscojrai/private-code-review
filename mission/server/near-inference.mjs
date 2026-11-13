/**
 * Aero Atlas Mission Escrow — attested inference worker (NEAR AI Cloud).
 *
 * Every mission-agent AI decision goes through here. Two modes:
 *
 *   1. TEE (live)  — @nearai/inference-sdk InferenceClient with e2ee: true.
 *      The SDK verifies the gateway AND the model attestation before sending,
 *      then we call verifyResponse(completion.id) after to check the signature.
 *      proof.signatureKind === "provider_tee" means the model ran in a NEAR TEE.
 *
 *   2. MLX (dev)   — when NEARAI_API_KEY has $0.00 credits (HTTP 402), we route
 *      to a local Apple-Silicon MLX server (OpenAI-compatible, localhost) so the
 *      demo keeps working. The moment credits land, the next call goes back to
 *      the private TEE automatically (the fallback only triggers on 402).
 *
 * Returns { completion, proof, source } where proof carries signatureKind,
 * model, completionId and the signer identity; the caller turns that into a
 * "Verified in TEE" badge on the HUD. The attestation is also recorded via
 * attestation.mjs so propose_payment can gate on it.
 *
 * Requires Node >= 24.22.1 (met). Verify within 60 minutes; if streaming, read
 * the whole stream before verifyResponse.
 */

import { InferenceClient } from "@nearai/inference-sdk/node";
import OpenAI from "openai";
import { recordAttestation, clearAttestation } from "./attestation.mjs";

const TEE_MODEL = process.env.NEARAI_MODEL || "z-ai/glm-5.3-flash";
const MLX_URL = process.env.MLX_URL || "http://127.0.0.1:8080/v1";
const MLX_MODEL = process.env.MLX_MODEL || "local-mlx";

let teeClient = null;
function tee() {
  if (!teeClient) {
    teeClient = new InferenceClient({ apiKey: process.env.NEARAI_API_KEY, e2ee: true });
  }
  return teeClient;
}

function isNoCredits(err) {
  return err?.status === 402 || /spend limit|402/i.test(String(err?.message || ""));
}

/** Normalize the verified proof into a compact, badge-ready shape. */
function proofShape(completion, proof) {
  const signature = proof?.signature || {};
  const signer = signature.signer || {};
  return {
    signatureKind: proof?.signatureKind || null,
    model: TEE_MODEL,
    completionId: completion?.id || "",
    signingAlgo: signer.signingAlgo || null,
    signingAddress: signer.signingAddress || "",
    verifiedAt: Date.now(),
  };
}

/**
 * Run one attested chat completion.
 *
 * @param {object} request  { messages, tools?, ... } (OpenAI Chat Completions)
 * @returns {Promise<{ completion, proof, source: "tee"|"mlx" }>}
 */
export async function runAttested(request) {
  const useTee = Boolean(process.env.NEARAI_API_KEY);

  if (useTee) {
    try {
      const client = tee();
      const completion = await client.chat.completions.create({ model: TEE_MODEL, ...request });
      // verifyResponse must run on the SAME client instance that made the call.
      const proof = await client.verifyResponse(completion.id);
      recordAttestation({
        completionId: completion.id,
        model: TEE_MODEL,
        signatureKind: proof?.signatureKind,
        signer: proof?.signature?.signer,
        signedText: proof?.signature?.signedText,
        signature: proof?.signature?.signature,
        verifiedAt: Date.now(),
      });
      return { completion, proof: proofShape(completion, proof), source: "tee" };
    } catch (err) {
      if (isNoCredits(err)) {
        const reason = (err?.error?.code || err?.error?.message || err?.message || "HTTP 402").slice(0, 120);
        console.log(`[near-inference] NEAR AI credits unavailable (402 ${reason}) — routing to local MLX.`);
        return runMlx(request, `402 ${reason}`);
      }
      throw err;
    }
  }

  return runMlx(request, "no NEARAI_API_KEY configured");
}

async function runMlx(request, fallbackReason) {
  clearAttestation();
  const client = new OpenAI({ baseURL: MLX_URL, apiKey: "local" });
  try {
    const completion = await client.chat.completions.create({ model: MLX_MODEL, ...request });
    return { completion, proof: null, source: "mlx", fallbackReason };
  } catch (err) {
    // No local MLX server either. Fail closed with a clean UNVERIFIED result,
    // never a raw connection error — the tier label must still render honestly.
    const reason = `${fallbackReason || "no backend"} · MLX not reachable at ${MLX_URL}`.slice(0, 160);
    return {
      completion: { choices: [{ message: { content: "" } }] },
      proof: null,
      source: "mlx",
      fallbackReason: reason,
    };
  }
}

/** Whether the last run was TEE-verified (for the frontend badge). */
export function teeStatus() {
  return { model: TEE_MODEL, mlxUrl: MLX_URL, mlxModel: MLX_MODEL, keyPresent: Boolean(process.env.NEARAI_API_KEY) };
}
