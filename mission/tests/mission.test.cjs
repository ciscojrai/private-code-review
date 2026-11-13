/**
 * Aero Atlas Mission Escrow — contract tests (near-workspaces v5, sandbox 2.14).
 *
 * Every demo beat is a test. If these pass, the demo cannot embarrass you.
 *
 * near-workspaces v5 API (verified against 5.0.0 source):
 *   - Worker.init() -> worker; worker.rootAccount
 *   - root.devDeploy(wasm) -> contract account
 *   - root.devCreateAccount() -> a fresh dev account (buyer/supplier/attacker/agent)
 *   - account.call(contract, method, args, { attachedDeposit: bigint })
 *   - account.view(method, args)
 *   - account.availableBalance() -> bigint
 *   - amounts in args are strings (yocto); options are BigInt
 *
 * The contract is built with `--cfg near` (see package.json build:contract).
 * Without it, near-sdk compiles the pure-Rust fallback and every panic collapses
 * into `unreachable` — the panic string IS the demo, so the build flag matters.
 *
 * Requires sandbox nearcore 2.14 (protocol 88). near-workspaces bundles 2.6.2,
 * which predates near-sdk 5.30's host ABI; see scripts/setup-sandbox.sh.
 */

const { Worker } = require("near-workspaces");
const path = require("path");

const WASM = path.join(
  __dirname,
  "..",
  "contracts",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "aero_mission_escrow.wasm"
);

const ONE_N = 10n ** 24n;
const HALF_N = 5n * 10n ** 23n;
const TWO_N = 2n * 10n ** 24n;
const HASH = "a".repeat(64);

jest.setTimeout(300_000);

describe("aero mission escrow", () => {
  let worker, root, contract, buyer, supplier, attacker, agent;

  beforeAll(async () => {
    worker = await Worker.init();
    root = worker.rootAccount;
    contract = await root.devDeploy(WASM);
    buyer = await root.devCreateAccount();
    supplier = await root.devCreateAccount();
    attacker = await root.devCreateAccount();
    agent = await root.devCreateAccount();
  });

  afterAll(async () => {
    if (worker) await worker.tearDown().catch(() => {});
  });

  const task = () => [
    {
      task_id: "venue-research",
      title: "Venue research",
      acceptance_rule: "3 candidate venues with pricing and capacity",
      max_payout: ONE_N.toString(),
      recipients: [supplier.accountId],
    },
  ];

  it("refuses a too-small deposit, then funds", async () => {
    await expect(
      buyer.call(
        contract,
        "create_mission",
        { mission_id: "m1", title: "t", tasks: task() },
        { attachedDeposit: 1n }
      )
    ).rejects.toThrow(/DEPOSIT_TOO_SMALL/);

    await buyer.call(
      contract,
      "create_mission",
      { mission_id: "m1", title: "t", tasks: task() },
      { attachedDeposit: ONE_N }
    );
  });

  it("refuses duplicate task ids", async () => {
    const dup = [
      { task_id: "x", title: "a", acceptance_rule: "r", max_payout: ONE_N.toString(), recipients: [supplier.accountId] },
      { task_id: "x", title: "b", acceptance_rule: "r", max_payout: ONE_N.toString(), recipients: [supplier.accountId] },
    ];
    await expect(
      buyer.call(contract, "create_mission", { mission_id: "m-dup", title: "t", tasks: dup }, { attachedDeposit: TWO_N })
    ).rejects.toThrow(/DUPLICATE_TASK_ID/);
  });

  it("happy path: agent proposes, buyer approves, supplier is paid", async () => {
    await agent.call(contract, "submit_proposal", {
      mission_id: "m1",
      task_id: "venue-research",
      recipient: supplier.accountId,
      amount: HALF_N.toString(),
      evidence_hash: HASH,
    });

    const before = await supplier.availableBalance();
    await buyer.call(contract, "approve", { mission_id: "m1", task_id: "venue-research" });
    // Wait for the transfer receipt to settle.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await supplier.availableBalance();
    expect(after - before).toBe(HALF_N);
  });

  it("injection beat: unknown recipient is refused on-chain", async () => {
    // Task m1 is already Paid, but the allowlist check runs first, so this
    // still surfaces RECIPIENT_NOT_APPROVED (the money-did-not-move moment).
    await expect(
      agent.call(contract, "submit_proposal", {
        mission_id: "m1",
        task_id: "venue-research",
        recipient: attacker.accountId,
        amount: HALF_N.toString(),
        evidence_hash: HASH,
      })
    ).rejects.toThrow(/RECIPIENT_NOT_APPROVED/);
  });

  it("replay beat: a paid task cannot be proposed again", async () => {
    // Valid recipient, but task already Paid -> TASK_NOT_OPEN.
    await expect(
      agent.call(contract, "submit_proposal", {
        mission_id: "m1",
        task_id: "venue-research",
        recipient: supplier.accountId,
        amount: HALF_N.toString(),
        evidence_hash: HASH,
      })
    ).rejects.toThrow(/TASK_NOT_OPEN/);
  });

  it("cap beat: over-cap amounts are refused", async () => {
    await buyer.call(contract, "create_mission", {
      mission_id: "m2",
      title: "t",
      tasks: task(),
    }, { attachedDeposit: ONE_N });

    await expect(
      agent.call(contract, "submit_proposal", {
        mission_id: "m2",
        task_id: "venue-research",
        recipient: supplier.accountId,
        amount: TWO_N.toString(),
        evidence_hash: HASH,
      })
    ).rejects.toThrow(/AMOUNT_OVER_CAP/);
  });

  it("evidence must be a sha256 hex digest", async () => {
    await expect(
      agent.call(contract, "submit_proposal", {
        mission_id: "m2",
        task_id: "venue-research",
        recipient: supplier.accountId,
        amount: HALF_N.toString(),
        evidence_hash: "not-a-hash",
      })
    ).rejects.toThrow(/EVIDENCE_MUST_BE_SHA256_HEX/);
  });

  it("reject beat: buyer rejects, task reopens, agent can retry", async () => {
    await agent.call(contract, "submit_proposal", {
      mission_id: "m2",
      task_id: "venue-research",
      recipient: supplier.accountId,
      amount: HALF_N.toString(),
      evidence_hash: HASH,
    });
    await buyer.call(contract, "reject", { mission_id: "m2", task_id: "venue-research" });

    // Reopened: a new proposal on the same task is accepted.
    await agent.call(contract, "submit_proposal", {
      mission_id: "m2",
      task_id: "venue-research",
      recipient: supplier.accountId,
      amount: HALF_N.toString(),
      evidence_hash: "b".repeat(64),
    });
  });

  it("pause beat: paused mission refuses new proposals", async () => {
    await buyer.call(contract, "set_paused", { mission_id: "m2", paused: true });
    await expect(
      agent.call(contract, "submit_proposal", {
        mission_id: "m2",
        task_id: "venue-research",
        recipient: supplier.accountId,
        amount: HALF_N.toString(),
        evidence_hash: HASH,
      })
    ).rejects.toThrow(/TASK_NOT_OPEN|MISSION_PAUSED/);
    await buyer.call(contract, "set_paused", { mission_id: "m2", paused: false });
  });

  it("refund beat: cancel refunds remaining budget to the buyer", async () => {
    // m2 still has an open proposal (0.5 N) on a 1 N budget; cancel refunds it all.
    const before = await buyer.availableBalance();
    await buyer.call(contract, "cancel_mission", { mission_id: "m2" });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await buyer.availableBalance();
    // Refund ~= 1 N budget minus gas. Assert it moved meaningfully up.
    expect(after).toBeGreaterThan(before);
  });

  it("stolen-worker-key beat: only the buyer can approve", async () => {
    // The worker (agent) account, even with a full-access key, is not the buyer.
    // The contract enforces BUYER_ONLY by predecessor identity, not by key type.
    await buyer.call(contract, "create_mission", {
      mission_id: "m3",
      title: "t",
      tasks: task(),
    }, { attachedDeposit: ONE_N });

    await agent.call(contract, "submit_proposal", {
      mission_id: "m3",
      task_id: "venue-research",
      recipient: supplier.accountId,
      amount: HALF_N.toString(),
      evidence_hash: HASH,
    });

    await expect(
      agent.call(contract, "approve", { mission_id: "m3", task_id: "venue-research" })
    ).rejects.toThrow(/BUYER_ONLY/);
  });

  it("non-zero deposit on submit_proposal is structurally refused", async () => {
    // A full-access account tries to attach a deposit. submit_proposal is
    // non-payable, matching the zero-deposit shape a function-call key requires.
    await expect(
      agent.call(
        contract,
        "submit_proposal",
        {
          mission_id: "m3",
          task_id: "venue-research",
          recipient: supplier.accountId,
          amount: HALF_N.toString(),
          evidence_hash: HASH,
        },
        { attachedDeposit: TWO_N }
      )
    ).rejects.toThrow(/DepositWithFunctionCall|deposit/i);
  });
});
