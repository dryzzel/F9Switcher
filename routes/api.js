// ============================================================
// API Routes — REST endpoints for the Number Switcher
//
// SECURITY: All routes in this file are protected by requireAuth.
// req.agent = { extensionId, extensionName, extensionNumber }
// is guaranteed to be set from the verified JWT session cookie.
//
// The extensionId is NEVER received from the client.
// ============================================================
const express = require('express');
const router = express.Router();
const rc = require('../services/ringcentral');
const db = require('../services/database');
const queue = require('../services/queue');

// ──────────────────────────────────────────────
//  GET /api/my-number
//  Get the authenticated agent's current phone number.
//  Uses req.agent.extensionId from the JWT — NOT from params.
// ──────────────────────────────────────────────
router.get('/my-number', async (req, res) => {
  try {
    const { extensionId } = req.agent;
    const numbers = await rc.getExtensionPhoneNumbers(extensionId);
    const directNumber = numbers.find((n) => n.usageType === 'DirectNumber');
    res.json({
      success: true,
      data: {
        all: numbers,
        directNumber: directNumber || null,
      },
    });
  } catch (error) {
    console.error('[API] Error getting agent numbers:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get your phone numbers',
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
//  ⚠️ SECURITY: extensionId is extracted from the JWT session,
//  NOT from the request body. This makes it cryptographically
//  impossible for an agent to switch another agent's number.
//
//  Body (optional): {
//    preferredNumberId: "789"
//  }
// ──────────────────────────────────────────────
router.post('/switch-number', (req, res) => {
  // extensionId comes ONLY from the verified JWT — never from the client
  const { extensionId, extensionName, extensionNumber } = req.agent;
  const { preferredNumberId } = req.body;

  console.log(
    `[API] 🚀 Switch requested by ${extensionName} (${extensionId}) → enqueuing`
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
//  Get the change history for the AUTHENTICATED AGENT only.
//  Each agent can only see their own history.
//  Query: ?limit=50
// ──────────────────────────────────────────────
router.get('/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    // Filter by the authenticated agent's extensionId — not a client param
    const extensionId = req.agent.extensionId;
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
