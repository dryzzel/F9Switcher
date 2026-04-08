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

    // 4. Start the HTTP server
    app.listen(PORT, () => {
      console.log('');
      console.log('═══════════════════════════════════════════════');
      console.log('  🔄 RingCentral Number Switcher');
      console.log('  🔐 OAuth Security: ENABLED');
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
