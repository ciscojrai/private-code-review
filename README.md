# Private Code Review — a NEAR-verified TEE agent

**Paste a private diff. Get a code review from a model that can't retain it — with a Verification Center receipt proving which model ran.**

The review runs on **NEAR AI Cloud** (`z-ai/glm-5.3-flash` in a Trusted Execution Environment) with end-to-end encryption on and the response signature checked via `verifyResponse()` before the answer is shown. This is Illia Polosukhin's own suggested idea — ["code review that is fully private"](https://x.com/ilblackdragon/status/2106269343881519444) (2026-10-03). The server keeps nothing — no database, no logs, no retention of the pasted diff.

> Built for [NEAR HACKATHON: Build Beyond Boundaries](https://nearhackathon.com). Track: **Privacy & Private AI**.

---

## Do X, see Y

```bash
npm install                      # openai + @nearai/inference-sdk (Node >= 24.22.1)
cp .env.example .env             # set NEARAI_API_KEY (https://cloud.near.ai → API Keys)
npm start                        # -> http://127.0.0.1:8787
```

1. Open the page and paste any diff (or private code) into the box.
2. Click **Review privately**.
3. **See** the review, plus a three-tier badge:

| Badge | Meaning |
|---|---|
| **✓ VERIFIED — provider_tee** | `verifyResponse()` checked a `provider_tee` signature: the model ran in a NEAR TEE. Carries an **Open Verification Center receipt ↗** link. |
| **⚠ PARTIALLY VERIFIED — gateway** | Only a `gateway` signature: "Gateway signature verified; model TEE execution not proven." |
| **✗ UNVERIFIED — LOCAL MLX FALLBACK** | No funded key (HTTP 402) → local MLX. **No attestation, no receipt — fail closed.** |

The three-tier honesty is the point: a response without a signature is *not* response-verified, and the UI never dresses up the fallback as verified.

**No key?** The page still runs and honestly shows **UNVERIFIED** (set `MLX_URL` to a local OpenAI-compatible server, or just read the label).

## Why this stands out

The "verified/unverified ledger" separation — `provider_tee` is the only tier that may carry *verified* unqualified; a `gateway` signature is only *partially* verified; a local fallback is *never* verified and trust actions fail closed.

## How it works

| File | Role |
|---|---|
| `server.mjs` | Minimal HTTP server: `/api/review`, `/api/engine`, static files |
| `mission/server/near-inference.mjs` | The attested worker: `InferenceClient` (e2ee) + `verifyResponse`; 402 → MLX fallback |
| `mission/server/review.mjs` | `reviewDiff` + the three-tier labeling |
| `mission/server/attestation.mjs` | Records the proof; builds the Verification Center receipt |
| `public/` | The review UI |

## Honest limits

- **Attestation does not grade review quality.** It proves *which verified model* produced the output, not that the review is correct.
- **A `gateway` signature is not a TEE proof** — it only binds the response to the attested gateway.
- **The local fallback has zero attestation.** It's resilience (the demo keeps running at $0 credits), not security.
- The 402 is observed behavior (`no_limit_configured`), not documented by NEAR; the raw reason is surfaced in the banner.

---

## Secondary artifact: Aero Atlas Mission Escrow

A bounded-payment escrow contract showing the same verified-inference worker bound to money: an agent proposes, a Rust contract enforces (recipient allowlist, per-task caps, replay lock, buyer-only approval), a human approves. The LLM never holds a key.

```bash
npm run build:contract            # Rust, wasm32, --cfg near (the flag that keeps panic strings alive)
npm run test:contract             # near-workspaces sandbox (see scripts/setup-sandbox.sh for 2.14)
```

- Contract: `mission/contracts/src/lib.rs`
- Tests: `mission/tests/mission.test.cjs` (12 adversarial beats)

### Hackathon disclosure

Written during the hackathon window (Nov 2026) with AI coding assistance. The escrow contract predates the review agent on this branch; both were built within the window. No keys are committed.
