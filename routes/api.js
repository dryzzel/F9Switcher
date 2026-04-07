// ============================================================
// API Routes — REST endpoints for the Number Switcher
// Now with job-based async processing via queue
// ============================================================
const express = require('express');
const router = express.Router();
const rc = require('../services/ringcentral');
const db = require('../services/database');
const queue = require('../services/queue');

// ──────────────────────────────────────────────
//  GET /api/extensions
//  List all user extensions (for the agent dropdown)
// ──────────────────────────────────────────────
router.get('/extensions', async (req, res) => {
  try {
    const extensions = await rc.listExtensions();
    res.json({ success: true, data: extensions });
  } catch (error) {
    console.error('[API] Error listing extensions:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to list extensions',
      details: error.message,
    });
  }
});

// ──────────────────────────────────────────────
//  GET /api/extensions/:id/numbers
//  Get phone numbers for a specific extension
// ──────────────────────────────────────────────
router.get('/extensions/:id/numbers', async (req, res) => {
  try {
    const numbers = await rc.getExtensionPhoneNumbers(req.params.id);
    const directNumber = numbers.find((n) => n.usageType === 'DirectNumber');
    res.json({
      success: true,
      data: {
        all: numbers,
        directNumber: directNumber || null,
      },
    });
  } catch (error) {
    console.error('[API] Error getting extension numbers:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get extension phone numbers',
      details: error.message,
    });
  }
});

// ──────────────────────────────────────────────
//  GET /api/inventory
//  List available numbers in the company inventory
// ──────────────────────────────────────────────
router.get('/inventory', async (req, res) => {
  try {
    const numbers = await rc.getInventoryNumbers();
    res.json({
      success: true,
      data: numbers,
      count: numbers.length,
    });
  } catch (error) {
    console.error('[API] Error listing inventory:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to list inventory numbers',
      details: error.message,
    });
  }
});

// ──────────────────────────────────────────────
//  POST /api/switch-number
//  Enqueue a phone number switch job.
//  Returns immediately with jobId for polling.
//
//  Body: {
//    extensionId: "123456",
//    extensionName: "John Doe",
//    extensionNumber: "101",
//    preferredNumberId: "789" (optional)
//  }
// ──────────────────────────────────────────────
router.post('/switch-number', (req, res) => {
  const { extensionId, extensionName, extensionNumber, preferredNumberId } =
    req.body;

  if (!extensionId) {
    return res.status(400).json({
      success: false,
      error: 'extensionId is required',
    });
  }

  console.log(
    `[API] 🚀 Switch requested for ${extensionName || extensionId} → enqueuing`
  );

  const job = queue.enqueue({
    extensionId: String(extensionId),
    extensionName: extensionName || 'Unknown',
    extensionNumber: extensionNumber || '',
    preferredNumberId,
  });

  const queueStatus = queue.getStatus();

  res.json({
    success: true,
    data: {
      jobId: job.id,
      status: job.status,
      position: job.position,
      queueInfo: {
        pendingJobs: queueStatus.pendingJobs,
        heavyCallsAvailable: queueStatus.heavyCallsAvailable,
        isPaused: queueStatus.isPaused,
        pauseRemainingSec: queueStatus.pauseRemainingSec,
      },
    },
  });
});

// ──────────────────────────────────────────────
//  GET /api/jobs/:id
//  Poll a job's status. Frontend calls this every 2s.
// ──────────────────────────────────────────────
router.get('/jobs/:id', (req, res) => {
  const job = queue.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Job not found or expired',
    });
  }

  const queueStatus = queue.getStatus();

  res.json({
    success: true,
    data: {
      jobId: job.id,
      status: job.status,
      position: job.position,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      queueInfo: {
        pendingJobs: queueStatus.pendingJobs,
        isPaused: queueStatus.isPaused,
        pauseRemainingSec: queueStatus.pauseRemainingSec,
      },
    },
  });
});

// ──────────────────────────────────────────────
//  GET /api/queue/status
//  Queue health / monitoring endpoint
// ──────────────────────────────────────────────
router.get('/queue/status', (req, res) => {
  res.json({
    success: true,
    data: queue.getStatus(),
  });
});

// ──────────────────────────────────────────────
//  GET /api/history
//  Get the change history log
//  Query: ?limit=50&extensionId=123
// ──────────────────────────────────────────────
router.get('/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const extensionId = req.query.extensionId || null;
    const history = db.getHistory(limit, extensionId);
    const stats = db.getStats();

    res.json({
      success: true,
      data: history,
      stats,
    });
  } catch (error) {
    console.error('[API] Error getting history:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get history',
      details: error.message,
    });
  }
});

module.exports = router;
