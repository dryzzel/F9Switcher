// ============================================================
// Job Queue — Rate-Limited Queue for Number Switch Operations
//
// Defenses:
//   1. Sliding window budget check (heavy calls in last 60s)
//   2. RC header integration (X-Rate-Limit-Remaining)
//   3. Proactive pause when remaining ≤ 1
//   4. Per-call 429 retry (in ringcentral.js)
//   5. Queue-level 429 requeue + 60s pause
// ============================================================
const crypto = require('crypto');

// ── Job ID generator (safe for all Node versions) ──
function generateJobId() {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString('hex');
  }
}

class SwitchQueue {
  constructor() {
    this.jobs = new Map();        // jobId → job object
    this.pending = [];            // ordered array of pending jobIds
    this.isProcessing = false;

    // ── Sliding window: track timestamps of heavy API calls ──
    this.heavyCallTimestamps = [];

    // ── Rate limit config (RC Heavy group) ──
    this.HEAVY_LIMIT = 10;
    this.HEAVY_WINDOW_MS = 60000;    // 60 seconds
    this.SAFE_MARGIN = 2;            // reserve 2 calls as buffer
    this.HEAVY_CALLS_PER_SWITCH = 2; // replace + delete

    // ── Pause state ──
    this.pausedUntil = 0;

    // ── Live rate limit info from RC headers ──
    this.rcRemaining = this.HEAVY_LIMIT;
    this.rcWindow = 60;

    // ── Auto-cleanup old finished jobs every 5 min ──
    this._cleanupTimer = setInterval(() => this._cleanup(), 300000);
  }

  // ────────────────────────────────────────────
  //  PUBLIC API
  // ────────────────────────────────────────────

  /**
   * Add a switch job to the queue. Returns immediately.
   */
  enqueue(params) {
    const jobId = generateJobId();
    const job = {
      id: jobId,
      status: 'queued',
      params,
      result: null,
      error: null,
      position: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };

    this.jobs.set(jobId, job);
    this.pending.push(jobId);
    this._updatePositions();

    console.log(`[Queue] 📥 Job ${jobId.slice(0, 8)} enqueued (position ${job.position}, pending: ${this.pending.length})`);

    // Kick off processing (non-blocking)
    setImmediate(() => this._processLoop());

    return { ...job };
  }

  /**
   * Get a job's current status (returns a copy).
   */
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'queued') {
      const idx = this.pending.indexOf(jobId);
      job.position = idx >= 0 ? idx + 1 : 0;
    }
    return { ...job };
  }

  /**
   * Get overall queue health status.
   */
  getStatus() {
    const now = Date.now();
    this._pruneTimestamps();
    const used = this.heavyCallTimestamps.length;
    const available = Math.max(0, this.HEAVY_LIMIT - this.SAFE_MARGIN - used);

    return {
      pendingJobs: this.pending.length,
      isProcessing: this.isProcessing,
      totalTrackedJobs: this.jobs.size,
      heavyCallsInWindow: used,
      heavyCallsAvailable: available,
      maxSwitchesAvailable: Math.floor(available / this.HEAVY_CALLS_PER_SWITCH),
      isPaused: now < this.pausedUntil,
      pauseRemainingSec: Math.max(0, Math.ceil((this.pausedUntil - now) / 1000)),
      rcRemaining: this.rcRemaining,
    };
  }

  /**
   * Update rate limits from RC API response headers.
   * Called by the RC service after each heavy call.
   */
  updateRateLimits(info) {
    if (!info || !info.group) return;
    const group = String(info.group).toLowerCase();
    if (group !== 'heavy') return;

    const remaining = parseInt(info.remaining) || 0;
    const limit = parseInt(info.limit) || this.HEAVY_LIMIT;
    const window = parseInt(info.window) || 60;

    this.rcRemaining = remaining;
    this.rcWindow = window;

    console.log(`[Queue] 📊 RC Header → Heavy: ${remaining}/${limit} remaining (window: ${window}s)`);

    // Proactive pause if remaining is critically low
    if (remaining <= 1) {
      const pauseMs = window * 1000;
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + pauseMs);
      console.log(`[Queue] ⏸️ Remaining ≤ 1 → pausing ${window}s`);
    }
  }

  /**
   * Record that a heavy API call was made (for sliding window tracking).
   */
  recordHeavyCall() {
    this.heavyCallTimestamps.push(Date.now());
  }

  /**
   * Handle a 429 error — pause queue for penalty duration.
   */
  handle429(retryAfterSec = 60) {
    const penaltyMs = (retryAfterSec || 60) * 1000;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + penaltyMs);
    console.log(`[Queue] 🛑 429 received! Paused for ${retryAfterSec}s`);
  }

  // ────────────────────────────────────────────
  //  INTERNAL: Processing Loop
  // ────────────────────────────────────────────

  async _processLoop() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.pending.length > 0) {
      // 1. Wait if rate-limited
      await this._waitIfPaused();

      // 2. Wait for heavy call budget
      await this._waitForBudget();

      // 3. Dequeue next job
      const jobId = this.pending.shift();
      const job = this.jobs.get(jobId);
      if (!job) continue;

      job.status = 'processing';
      job.startedAt = Date.now();
      job.updatedAt = Date.now();
      job.position = 0;
      this._updatePositions();

      console.log(`[Queue] ⚙️ Processing job ${jobId.slice(0, 8)} — ${job.params.extensionName || job.params.extensionId}`);

      try {
        // Lazy require to avoid circular dependency
        const rc = require('./ringcentral');
        const result = await rc.switchAgentNumber(
          job.params.extensionId,
          job.params.preferredNumberId || null
        );

        job.status = 'completed';
        job.result = {
          extensionId: job.params.extensionId,
          oldNumber: result.oldNumber.phoneNumber,
          newNumber: result.newNumber.phoneNumber,
          oldNumberDeleted: result.oldNumberDeleted,
          deleteWarning: result.deleteError || null,
          message: result.oldNumberDeleted
            ? `Number changed from ${result.oldNumber.phoneNumber} to ${result.newNumber.phoneNumber}. Old number deleted.`
            : `Number changed from ${result.oldNumber.phoneNumber} to ${result.newNumber.phoneNumber}. ⚠️ Old number may still be in inventory.`,
        };
        job.completedAt = Date.now();
        job.updatedAt = Date.now();

        // Log to DB
        try {
          const db = require('./database');
          db.logChange({
            extensionId: job.params.extensionId,
            extensionName: job.params.extensionName || 'Unknown',
            extensionNumber: job.params.extensionNumber || '',
            oldPhoneNumber: result.oldNumber.phoneNumber,
            oldPhoneNumberId: result.oldNumber.id,
            newPhoneNumber: result.newNumber.phoneNumber,
            newPhoneNumberId: result.newNumber.id,
          });
        } catch (_) {}

        console.log(`[Queue] ✅ Job ${jobId.slice(0, 8)} completed: ${result.oldNumber.phoneNumber} → ${result.newNumber.phoneNumber}`);

      } catch (error) {
        console.error(`[Queue] ❌ Job ${jobId.slice(0, 8)} failed: ${error.message}`);

        // If it's a 429 that bubbled up — requeue at front
        const is429 = error.message.includes('429') || error.message.toLowerCase().includes('too many requests');
        if (is429) {
          console.log(`[Queue] ♻️ Re-queuing job ${jobId.slice(0, 8)} after 429`);
          job.status = 'queued';
          job.updatedAt = Date.now();
          this.pending.unshift(jobId);
          this._updatePositions();
          this.handle429();
          continue;
        }

        job.status = 'failed';
        job.error = error.message;
        job.completedAt = Date.now();
        job.updatedAt = Date.now();

        // Log error to DB
        try {
          const db = require('./database');
          db.logError({
            extensionId: job.params.extensionId,
            extensionName: job.params.extensionName || 'Unknown',
            extensionNumber: job.params.extensionNumber || '',
            oldPhoneNumber: '',
            oldPhoneNumberId: '',
            errorMessage: error.message,
          });
        } catch (_) {}
      }
    }

    this.isProcessing = false;
    console.log('[Queue] 💤 Queue empty, idle');
  }

  // ────────────────────────────────────────────
  //  INTERNAL: Rate Limit Helpers
  // ────────────────────────────────────────────

  _pruneTimestamps() {
    const cutoff = Date.now() - this.HEAVY_WINDOW_MS;
    this.heavyCallTimestamps = this.heavyCallTimestamps.filter(t => t > cutoff);
  }

  async _waitIfPaused() {
    const now = Date.now();
    if (now < this.pausedUntil) {
      const waitMs = this.pausedUntil - now;
      console.log(`[Queue] ⏳ Paused — cooldown ${Math.ceil(waitMs / 1000)}s...`);
      await this._delay(waitMs);
    }
  }

  async _waitForBudget() {
    this._pruneTimestamps();
    const used = this.heavyCallTimestamps.length;
    const available = this.HEAVY_LIMIT - this.SAFE_MARGIN - used;

    if (available < this.HEAVY_CALLS_PER_SWITCH) {
      const oldest = this.heavyCallTimestamps[0];
      const waitMs = (oldest + this.HEAVY_WINDOW_MS) - Date.now() + 1000;
      if (waitMs > 0) {
        console.log(`[Queue] ⏳ Heavy budget low (${available} avail, need ${this.HEAVY_CALLS_PER_SWITCH}). Waiting ${Math.ceil(waitMs / 1000)}s...`);
        await this._delay(waitMs);
        return this._waitForBudget(); // re-check
      }
    }
  }

  _updatePositions() {
    this.pending.forEach((id, idx) => {
      const job = this.jobs.get(id);
      if (job) {
        job.position = idx + 1;
        job.updatedAt = Date.now();
      }
    });
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _cleanup() {
    const cutoff = Date.now() - 300000; // 5 min
    let count = 0;
    for (const [id, job] of this.jobs.entries()) {
      if ((job.status === 'completed' || job.status === 'failed') && job.updatedAt < cutoff) {
        this.jobs.delete(id);
        count++;
      }
    }
    if (count) console.log(`[Queue] 🧹 Cleaned ${count} finished jobs`);
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}

// ── Singleton ──
const queue = new SwitchQueue();
module.exports = queue;
