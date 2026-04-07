// ============================================================
// Server Entry Point — RingCentral Number Switcher
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const rc = require('./services/ringcentral');
const db = require('./services/database');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
//  MIDDLEWARE
// ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRoutes);

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

    // 2. Initialize RingCentral connection
    await rc.initialize();
    console.log('[Server] 🔗 RingCentral connected');

    // 3. Start the HTTP server
    app.listen(PORT, () => {
      console.log('');
      console.log('═══════════════════════════════════════════════');
      console.log('  🔄 RingCentral Number Switcher');
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
