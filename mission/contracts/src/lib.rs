//! Aero Atlas Mission Escrow — NEAR testnet hackathon build.
//!
//! Trust model, in one line: the agent proposes, the contract enforces,
//! the buyer approves. The LLM never holds a key.
//!
//! Policy checks live here on purpose — a compromised worker or server
//! cannot exceed caps, change recipients, or pay twice.

use std::collections::HashSet;

use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

pub type MissionId = String;

/// All amounts are integer yoctoNEAR (`u128`). We convert to/from `NearToken`
/// only at the SDK boundary (`attached_deposit`, `Promise::transfer`).
pub type Balance = u128;

/// A task as sent by the buyer when the mission is created.
#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct TaskSpec {
    pub task_id: String,
    pub title: String,
    pub acceptance_rule: String,
    /// Per-task payout cap, in yoctoNEAR, serialized as a string.
    pub max_payout: U128,
    /// Approved recipients. The contract refuses anyone else.
    pub recipients: Vec<AccountId>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub enum TaskState {
    Open,
    Proposed,
    Paid,
    Cancelled,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Proposal {
    pub recipient: AccountId,
    pub amount: Balance,
    /// sha256 (64 lowercase hex) of the deliverable, computed by the server.
    pub evidence_hash: String,
    pub proposed_by: AccountId,
    pub proposed_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Mission {
    pub id: MissionId,
    pub buyer: AccountId,
    pub title: String,
    pub budget_total: Balance,
    pub budget_remaining: Balance,
    pub paused: bool,
    pub cancelled: bool,
    pub task_ids: Vec<String>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Task {
    pub mission_id: MissionId,
    pub task_id: String,
    pub title: String,
    pub acceptance_rule: String,
    pub max_payout: Balance,
    pub recipients: Vec<AccountId>,
    pub state: TaskState,
    pub proposal: Option<Proposal>,
}

// ---- View shapes returned to the server ----

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalView {
    pub recipient: AccountId,
    pub amount: U128,
    pub evidence_hash: String,
    pub proposed_by: AccountId,
    pub proposed_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TaskView {
    pub task_id: String,
    pub title: String,
    pub acceptance_rule: String,
    pub max_payout: U128,
    pub recipients: Vec<AccountId>,
    pub state: TaskState,
    pub proposal: Option<ProposalView>,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MissionView {
    pub id: String,
    pub buyer: AccountId,
    pub title: String,
    pub budget_total: U128,
    pub budget_remaining: U128,
    pub paused: bool,
    pub cancelled: bool,
    pub tasks: Vec<TaskView>,
}

#[near(contract_state)]
pub struct Contract {
    missions: LookupMap<MissionId, Mission>,
    tasks: LookupMap<(MissionId, String), Task>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            missions: LookupMap::new(b"m"),
            tasks: LookupMap::new(b"t"),
        }
    }
}

fn log_event(event: &str, mission_id: &str, extra: &str) {
    // NEP-297 style event. Literal braces are doubled for format!.
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"aero-mission\",\"version\":\"1.0.0\",\"event\":\"{}\",\"mission_id\":\"{}\"{}}}",
        event, mission_id, extra
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self::default()
    }

    /// Buyer funds a mission. The attached deposit becomes the escrow budget and
    /// must cover the sum of all per-task caps. A surplus above the caps is kept
    /// as a gas reserve: the contract pays transfer gas from its own balance, so
    /// an exact-match budget would fail on the final payment of a multi-task
    /// mission. Any unused reserve is refunded on cancel.
    #[payable]
    pub fn create_mission(
        &mut self,
        mission_id: String,
        title: String,
        tasks: Vec<TaskSpec>,
    ) -> MissionView {
        require!(!tasks.is_empty(), "MISSION_NEEDS_TASKS");
        require!(!self.missions.contains_key(&mission_id), "MISSION_ID_TAKEN");
        let buyer = env::predecessor_account_id();
        let deposit: Balance = env::attached_deposit().as_yoctonear();
        let caps_total: Balance = tasks.iter().map(|t| t.max_payout.0).sum();
        require!(
            deposit >= caps_total,
            format!("DEPOSIT_TOO_SMALL: {} required", caps_total)
        );

        // Reject duplicate task ids up front so no task silently overwrites another.
        let mut seen = HashSet::with_capacity(tasks.len());
        for spec in &tasks {
            require!(
                seen.insert(spec.task_id.clone()),
                format!("DUPLICATE_TASK_ID: {}", spec.task_id)
            );
        }

        let mut task_ids = Vec::with_capacity(tasks.len());
        for spec in tasks {
            require!(!spec.recipients.is_empty(), format!("TASK_NEEDS_RECIPIENTS: {}", spec.task_id));
            require!(
                spec.max_payout.0 > 0,
                format!("TASK_CAP_MUST_BE_POSITIVE: {}", spec.task_id)
            );
            let task = Task {
                mission_id: mission_id.clone(),
                task_id: spec.task_id.clone(),
                title: spec.title,
                acceptance_rule: spec.acceptance_rule,
                max_payout: spec.max_payout.0,
                recipients: spec.recipients,
                state: TaskState::Open,
                proposal: None,
            };
            self.tasks.insert(&(mission_id.clone(), spec.task_id.clone()), &task);
            task_ids.push(spec.task_id);
        }

        let mission = Mission {
            id: mission_id.clone(),
            buyer,
            title,
            budget_total: deposit,
            budget_remaining: deposit,
            paused: false,
            cancelled: false,
            task_ids,
        };
        self.missions.insert(&mission_id, &mission);
        log_event("mission_created", &mission_id, &format!(",\"budget\":\"{}\"", deposit));
        self.mission_state(mission_id)
    }

    /// The agent's one power: propose. Every rule below is enforced on-chain,
    /// so a persuaded or compromised model still cannot move funds.
    ///
    /// Non-payable on purpose: function-call access keys cannot attach deposits
    /// (the protocol rejects DepositWithFunctionCall), and the contract
    /// structurally rejects deposits from anyone else too.
    ///
    /// Panic strings are the demo: they appear verbatim on the BLOCK card.
    pub fn submit_proposal(
        &mut self,
        mission_id: String,
        task_id: String,
        recipient: AccountId,
        amount: U128,
        evidence_hash: String,
    ) -> ProposalView {
        let worker = env::predecessor_account_id();
        let mission = self.get_mission(&mission_id);
        require!(!mission.cancelled, "MISSION_CANCELLED");
        require!(!mission.paused, "MISSION_PAUSED");

        let task = self.get_task(&mission_id, &task_id);
        let amt = amount.0;

        // Check the allowlist FIRST, before the task-state check. The injection
        // beat must show RECIPIENT_NOT_APPROVED even if the task is already paid,
        // because that is the "money did not move" moment.
        require!(
            task.recipients.contains(&recipient),
            format!("RECIPIENT_NOT_APPROVED: {}", recipient)
        );
        require!(task.state == TaskState::Open, "TASK_NOT_OPEN");
        require!(amt > 0, "AMOUNT_MUST_BE_POSITIVE");
        require!(amt <= task.max_payout, format!("AMOUNT_OVER_CAP: max={}", task.max_payout));
        require!(
            amt <= mission.budget_remaining,
            format!("BUDGET_EXHAUSTED: remaining={}", mission.budget_remaining)
        );
        require!(
            is_sha256_hex(&evidence_hash),
            "EVIDENCE_MUST_BE_SHA256_HEX"
        );

        let proposal = Proposal {
            recipient,
            amount: amt,
            evidence_hash,
            proposed_by: worker,
            proposed_at: env::block_timestamp_ms(),
        };
        let mut task = task;
        task.proposal = Some(proposal.clone());
        task.state = TaskState::Proposed;
        self.tasks.insert(&(mission_id.clone(), task_id.clone()), &task);

        log_event(
            "proposal_submitted",
            &mission_id,
            &format!(
                ",\"task_id\":\"{}\",\"recipient\":\"{}\",\"amount\":\"{}\",\"evidence_hash\":\"{}\"",
                task_id, proposal.recipient, proposal.amount, proposal.evidence_hash
            ),
        );
        ProposalView {
            recipient: proposal.recipient,
            amount: U128(proposal.amount),
            evidence_hash: proposal.evidence_hash,
            proposed_by: proposal.proposed_by,
            proposed_at: proposal.proposed_at,
        }
    }

    /// Buyer approves the pending proposal; the contract pays the recipient.
    pub fn approve(&mut self, mission_id: String, task_id: String) -> Promise {
        let mut mission = self.get_mission(&mission_id);
        require!(env::predecessor_account_id() == mission.buyer, "BUYER_ONLY");
        require!(!mission.paused, "MISSION_PAUSED");
        require!(!mission.cancelled, "MISSION_CANCELLED");

        let mut task = self.get_task(&mission_id, &task_id);
        require!(task.state == TaskState::Proposed, "TASK_NOT_PROPOSED");
        let proposal = match task.proposal.clone() {
            Some(p) => p,
            None => env::panic_str("NO_PROPOSAL"),
        };

        mission.budget_remaining -= proposal.amount;
        task.state = TaskState::Paid;
        task.proposal = None;
        self.tasks.insert(&(mission_id.clone(), task_id.clone()), &task);
        self.missions.insert(&mission_id, &mission);

        log_event(
            "payment_released",
            &mission_id,
            &format!(
                ",\"task_id\":\"{}\",\"recipient\":\"{}\",\"amount\":\"{}\",\"evidence_hash\":\"{}\"",
                task_id, proposal.recipient, proposal.amount, proposal.evidence_hash
            ),
        );
        Promise::new(proposal.recipient).transfer(NearToken::from_yoctonear(proposal.amount))
    }

    /// Buyer rejects the deliverable; the task reopens for another attempt.
    pub fn reject(&mut self, mission_id: String, task_id: String) {
        let mission = self.get_mission(&mission_id);
        require!(env::predecessor_account_id() == mission.buyer, "BUYER_ONLY");

        let mut task = self.get_task(&mission_id, &task_id);
        require!(task.state == TaskState::Proposed, "TASK_NOT_PROPOSED");
        task.state = TaskState::Open;
        task.proposal = None;
        self.tasks.insert(&(mission_id.clone(), task_id.clone()), &task);

        log_event("proposal_rejected", &mission_id, &format!(",\"task_id\":\"{}\"", task_id));
    }

    /// Buyer pause switch: blocks new proposals and approvals while on.
    pub fn set_paused(&mut self, mission_id: String, paused: bool) {
        let mut mission = self.get_mission(&mission_id);
        require!(env::predecessor_account_id() == mission.buyer, "BUYER_ONLY");
        mission.paused = paused;
        self.missions.insert(&mission_id, &mission);
        log_event(
            if paused { "mission_paused" } else { "mission_resumed" },
            &mission_id,
            "",
        );
    }

    /// Buyer cancels the mission; remaining budget is refunded and open
    /// or proposed tasks are closed. Paid tasks stay paid.
    pub fn cancel_mission(&mut self, mission_id: String) -> Promise {
        let mut mission = self.get_mission(&mission_id);
        require!(env::predecessor_account_id() == mission.buyer, "BUYER_ONLY");
        require!(!mission.cancelled, "MISSION_ALREADY_CANCELLED");

        mission.cancelled = true;
        let refund = mission.budget_remaining;
        mission.budget_remaining = 0;

        for task_id in mission.task_ids.clone() {
            let mut task = self.get_task(&mission_id, &task_id);
            if task.state == TaskState::Open || task.state == TaskState::Proposed {
                task.state = TaskState::Cancelled;
                task.proposal = None;
                self.tasks.insert(&(mission_id.clone(), task_id.clone()), &task);
            }
        }
        self.missions.insert(&mission_id, &mission);

        log_event("mission_cancelled", &mission_id, &format!(",\"refund\":\"{}\"", refund));
        Promise::new(mission.buyer).transfer(NearToken::from_yoctonear(refund))
    }

    /// Read-only view the server policy gate and the UI both use.
    pub fn mission_state(&self, mission_id: String) -> MissionView {
        let mission = self.get_mission(&mission_id);
        let tasks = mission
            .task_ids
            .iter()
            .map(|tid| {
                let t = self.get_task(&mission_id, tid);
                TaskView {
                    task_id: t.task_id,
                    title: t.title,
                    acceptance_rule: t.acceptance_rule,
                    max_payout: U128(t.max_payout),
                    recipients: t.recipients,
                    state: t.state,
                    proposal: t.proposal.map(|p| ProposalView {
                        recipient: p.recipient,
                        amount: U128(p.amount),
                        evidence_hash: p.evidence_hash,
                        proposed_by: p.proposed_by,
                        proposed_at: p.proposed_at,
                    }),
                }
            })
            .collect();
        MissionView {
            id: mission.id,
            buyer: mission.buyer,
            title: mission.title,
            budget_total: U128(mission.budget_total),
            budget_remaining: U128(mission.budget_remaining),
            paused: mission.paused,
            cancelled: mission.cancelled,
            tasks,
        }
    }

    // ---- internal helpers (not exposed) ----

    fn get_mission(&self, mission_id: &MissionId) -> Mission {
        self.missions.get(mission_id).unwrap_or_else(|| env::panic_str("MISSION_NOT_FOUND"))
    }

    fn get_task(&self, mission_id: &MissionId, task_id: &String) -> Task {
        self.tasks
            .get(&(mission_id.clone(), task_id.clone()))
            .unwrap_or_else(|| env::panic_str("TASK_NOT_FOUND"))
    }
}

/// Returns true if `s` is exactly 64 lowercase hex characters (a sha256 digest
/// as the server computes it).
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
