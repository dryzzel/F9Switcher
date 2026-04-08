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
//  GET /api/cooldown-status
//  Returns the cooldown state for the authenticated agent.
//  Used by the frontend to restore the timer on page refresh.
// ──────────────────────────────────────────────
router.get('/cooldown-status', (req, res) => {
  try {
    const { extensionId } = req.agent;
    const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
    const lastChange = db.getLastSuccessfulChange(extensionId);

    if (lastChange) {
      const lastChangeTime = new Date(lastChange).getTime();
      const elapsed = Date.now() - lastChangeTime;
      const remaining = COOLDOWN_MS - elapsed;

      if (remaining > 0) {
        return res.json({
          success: true,
          data: {
            active: true,
            cooldownRemainingSec: Math.ceil(remaining / 1000),
          },
        });
      }
    }

    res.json({
      success: true,
      data: { active: false, cooldownRemainingSec: 0 },
    });
  } catch (error) {
    console.error('[API] Error checking cooldown:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
//  POST /api/switch-number
router.post('/switch-number', (req, res) => {
  // extensionId comes ONLY from the verified JWT — never from the client
  const { extensionId, extensionName, extensionNumber } = req.agent;
  const { preferredNumberId } = req.body;

  // ── Cooldown check: 10 minutes between changes per agent ──
  const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
  const lastChange = db.getLastSuccessfulChange(extensionId);

  if (lastChange) {
    const lastChangeTime = new Date(lastChange).getTime();
    const elapsed = Date.now() - lastChangeTime;
    const remaining = COOLDOWN_MS - elapsed;

    if (remaining > 0) {
      const remainingSec = Math.ceil(remaining / 1000);
      console.log(`[API] ⏳ Cooldown active for ${extensionName}: ${remainingSec}s remaining`);
      return res.status(429).json({
        success: false,
        error: 'cooldown',
        message: `Debes esperar ${Math.ceil(remainingSec / 60)} minuto(s) antes de cambiar tu número de nuevo.`,
        cooldownRemainingSec: remainingSec,
      });
    }
  }

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

// ──────────────────────────────────────────────
//  POST /api/sms-activation
//  Link the agent's current phone number to the
//  configured TCR Campaign for A2P SMS activation.
//
//  ⚠️ Uses Admin JWT (App 1) — EditAccounts scope.
//  ⚠️ Activation may take up to 48 hours.
// ──────────────────────────────────────────────
router.post('/sms-activation', async (req, res) => {
  try {
    const brandId = process.env.RC_TCR_BRAND_ID;
    const campaignId = process.env.RC_TCR_CAMPAIGN_ID;

    // Validate config
    if (!brandId || !campaignId) {
      return res.status(503).json({
        success: false,
        error: 'SMS activation is not configured. TCR Brand/Campaign IDs are missing.',
      });
    }

    const { extensionId, extensionName } = req.agent;

    // Get the agent's current phone numbers
    const numbers = await rc.getExtensionPhoneNumbers(extensionId);
    const directNumber = numbers.find((n) => n.usageType === 'DirectNumber');

    if (!directNumber || !directNumber.phoneNumber) {
      return res.status(404).json({
        success: false,
        error: 'No direct phone number found for your extension.',
      });
    }

    const phoneNumberE164 = directNumber.phoneNumber; // Already in E.164 format

    console.log(`[API] 📱 SMS activation requested by ${extensionName} for ${phoneNumberE164}`);

    // Link the number to the TCR campaign (Admin token)
    await rc.linkPhoneNumberToCampaign(brandId, campaignId, phoneNumberE164);

    res.json({
      success: true,
      data: {
        status: 'pending',
        phoneNumber: phoneNumberE164,
        message: 'SMS activation submitted successfully. The number has been linked to the TCR campaign. Activation may take up to 48 hours.',
      },
    });
  } catch (error) {
    console.error('[API] ❌ SMS activation failed:', error.message);
    res.status(500).json({
      success: false,
      error: 'SMS activation failed',
      details: error.message,
    });
  }
});

// ──────────────────────────────────────────────
//  GET /api/sms-status
//  Check the SMS configuration status for the
//  agent's current phone number.
// ──────────────────────────────────────────────
router.get('/sms-status', async (req, res) => {
  try {
    const { extensionId } = req.agent;

    // Get the agent's current phone numbers
    const numbers = await rc.getExtensionPhoneNumbers(extensionId);
    const directNumber = numbers.find((n) => n.usageType === 'DirectNumber');

    if (!directNumber) {
      return res.json({
        success: true,
        data: { smsEnabled: false, reason: 'No direct number assigned' },
      });
    }

    // Check if the number has SmsSender or A2PSmsSender feature
    const features = directNumber.features || [];
    const hasSmsFeature = features.some(
      (f) => f === 'SmsSender' || f === 'A2PSmsSender' || f === 'MmsSender'
    );

    // Try to get detailed SMS configuration
    let smsConfig = null;
    if (directNumber.id) {
      try {
        smsConfig = await rc.getSmsConfiguration(extensionId, directNumber.id);
      } catch (_) {
        // Non-critical — continue without detailed config
      }
    }

    const campaignStatus = smsConfig?.smsCampaignInfo?.status || null;

    res.json({
      success: true,
      data: {
        smsEnabled: hasSmsFeature,
        phoneNumber: directNumber.phoneNumber,
        features,
        campaignStatus,
        campaign: smsConfig?.smsCampaignInfo || null,
        brand: smsConfig?.smsBrandInfo || null,
      },
    });
  } catch (error) {
    console.error('[API] ❌ SMS status check failed:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to check SMS status',
      details: error.message,
    });
  }
});

module.exports = router;
