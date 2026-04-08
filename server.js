// ============================================================
// Server Entry Point — RingCentral Number Switcher
// Now with OAuth authentication for agent identity
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const rc = require('./services/ringcentral');
const db = require('./services/database');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const requireAuth = require('./middleware/requireAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
//  MIDDLEWARE
// ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────

// Auth routes (public — no requireAuth)
app.use('/api/auth', authRoutes);

// Protected API routes (require valid JWT session cookie)
app.use('/api', requireAuth, apiRoutes);

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ──────────────────────────────────────────────
//  SMS TCR AUTO-DISCOVERY
// ──────────────────────────────────────────────
async function discoverTcrConfig() {
  const brandId = process.env.RC_TCR_BRAND_ID;
  const campaignId = process.env.RC_TCR_CAMPAIGN_ID;

  if (brandId && campaignId) {
    console.log(`[SMS] ✅ TCR Campaign configured (Brand: ${brandId}, Campaign: ${campaignId})`);
    return;
  }

  console.log('[SMS] ⚠️  RC_TCR_BRAND_ID / RC_TCR_CAMPAIGN_ID not set. Running auto-discovery...');
  try {
    const brands = await rc.listTcrBrands();
    if (!brands.length) {
      console.log('[SMS] ⚠️  No TCR Brands found. SMS activation will be unavailable.');
      return;
    }

    console.log(`[SMS] 📋 Found ${brands.length} TCR Brand(s):`);
    for (const b of brands) {
      console.log(`  ▸ Brand ID: ${b.id} | Name: "${b.name || 'N/A'}" | Status: ${b.status || 'N/A'} | External: ${b.externalId || 'N/A'}`);
      try {
        const campaigns = await rc.listTcrCampaigns(b.id);
        if (campaigns.length) {
          for (const c of campaigns) {
            console.log(`    ▸ Campaign ID: ${c.id} | Name: "${c.name || c.externalId || 'N/A'}" | Status: ${c.status || 'N/A'}`);
          }
        } else {
          console.log('    (No campaigns found for this brand)');
        }
      } catch (err) {
        console.log(`    (Could not list campaigns: ${err.message})`);
      }
    }

    console.log('');
    console.log('[SMS] 👉 Copy the Brand ID and Campaign ID above to your .env:');
    console.log('         RC_TCR_BRAND_ID=<brand_id>');
    console.log('         RC_TCR_CAMPAIGN_ID=<campaign_id>');
    console.log('');
  } catch (err) {
    console.warn(`[SMS] ⚠️  Auto-discovery failed: ${err.message}`);
    console.warn('[SMS]    SMS activation will be unavailable until configured.');
  }
}

// ──────────────────────────────────────────────
//  STARTUP
// ──────────────────────────────────────────────
async function start() {
  try {
    // 1. Initialize the database (async because sql.js loads WASM)
    await db.initialize();
    console.log('[Server] 📦 Database ready');

    // 2. Initialize RingCentral Admin connection (App 1 — JWT)
    await rc.initialize();
    console.log('[Server] 🔗 RingCentral Admin (App 1) connected');

    // 3. Wire rate limit callbacks: RC → Queue
    const queue = require('./services/queue');
    rc.onRateLimitInfo((info) => {
      if (info.is429) {
        queue.handle429(info.retryAfter || 60);
      }
      queue.updateRateLimits(info);
    });
    console.log('[Server] 📊 Rate limit monitoring active');

    // 4. SMS TCR Auto-Discovery / Validation
    await discoverTcrConfig();

    // 5. Start the HTTP server
    app.listen(PORT, () => {
      console.log('');
      console.log('═══════════════════════════════════════════════');
      console.log('  🔄 RingCentral Number Switcher');
      console.log('  🔐 OAuth Security: ENABLED');
      console.log('  📱 SMS Activation: ' + (process.env.RC_TCR_BRAND_ID && process.env.RC_TCR_CAMPAIGN_ID ? 'ENABLED' : 'NOT CONFIGURED'));
      console.log(`  🌐 http://localhost:${PORT}`);
      console.log('═══════════════════════════════════════════════');
      console.log('');
    });
  } catch (error) {
    console.error('[Server] ❌ Failed to start:', error.message);
    console.error(error);
    process.exit(1);
  }
}

start();
