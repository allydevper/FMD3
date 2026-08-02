//! Holds the plan built by `check` so `apply` needs no network round trip.
//!
//! The old flow re-probed GitHub on every leg (check → confirm → apply), which
//! cost six API calls out of a 60/hour budget before a single byte moved.

use super::model::SyncPlan;
use super::state::now_unix;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// A confirmation dialog the user leaves open for longer than this is stale;
/// applying it would download a revision that may have moved.
const TTL_SECS: i64 = 600;

struct Pending {
    token: String,
    plan: SyncPlan,
    created_at: i64,
}

static PENDING: Lazy<Mutex<Option<Pending>>> = Lazy::new(|| Mutex::new(None));
static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn put(plan: SyncPlan) -> String {
    let token = format!(
        "{}-{}",
        now_unix(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    );
    *PENDING.lock() = Some(Pending {
        token: token.clone(),
        plan,
        created_at: now_unix(),
    });
    token
}

/// Consume the stored plan. `None` when the token is missing, wrong or expired,
/// in which case the caller re-checks instead of guessing.
pub fn take(token: Option<&str>) -> Option<SyncPlan> {
    let token = token?;
    let mut guard = PENDING.lock();
    let pending = guard.take()?;
    if pending.token != token {
        // Someone else's token: keep the stored plan for its rightful owner.
        *guard = Some(pending);
        return None;
    }
    if now_unix() - pending.created_at > TTL_SECS {
        return None;
    }
    Some(pending.plan)
}

/// Read the stored plan without consuming it.
pub fn peek(token: &str) -> Option<SyncPlan> {
    let guard = PENDING.lock();
    let pending = guard.as_ref()?;
    if pending.token != token || now_unix() - pending.created_at > TTL_SECS {
        return None;
    }
    Some(pending.plan.clone())
}

pub fn clear() {
    *PENDING.lock() = None;
}
