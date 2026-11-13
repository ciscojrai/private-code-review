// Private Code Review — minimal client. One POST, render the three-tier badge.
const run = document.getElementById("run");
const diff = document.getElementById("diff");
const result = document.getElementById("result");
const badge = document.getElementById("badge");
const receipt = document.getElementById("receipt");
const text = document.getElementById("text");
const engine = document.getElementById("engine");

const tierClass = { verified: "tee", partial: "gateway", unverified: "fallback" };

fetch("/api/engine")
  .then((r) => r.json())
  .catch(() => ({}))
  .then((s) => {
    if (!s || !s.model) return;
    engine.textContent = s.keyPresent ? `engine: ${s.model} (TEE)` : "engine: offline (no key)";
  });

run.onclick = async () => {
  const d = diff.value.trim();
  if (!d) return;
  run.disabled = true;
  badge.textContent = "reviewing… (verifying signature)";
  badge.className = "badge";
  result.hidden = false;
  receipt.hidden = true;
  text.textContent = "";
  try {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diff: d }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Review failed.");
    badge.textContent = body.tierLabel;
    badge.className = "badge " + (tierClass[body.tier] || "");
    text.textContent = body.review || "(empty)";
    engine.textContent = "engine: " + body.model + (body.upstream ? " · " + body.upstream : "");
    if (body.receiptUrl) {
      receipt.href = body.receiptUrl;
      receipt.hidden = false;
    }
  } catch (err) {
    badge.textContent = "ERROR";
    badge.className = "badge fallback";
    text.textContent = err.message || "Review failed.";
  } finally {
    run.disabled = false;
  }
};
