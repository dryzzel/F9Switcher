// ============================================================
// Auth Routes — RingCentral OAuth Login / Callback / Logout
// ============================================================
const express = require('express');
const router = express.Router();
const auth = require('../services/auth');

// Cookie options for the session token
const COOKIE_OPTS = {
  httpOnly: true,       // JS cannot read it → XSS-proof
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',      // 'lax' allows the OAuth redirect to send the cookie
  maxAge: 8 * 60 * 60 * 1000, // 8 hours (matches JWT TTL)
  path: '/',
};

// ──────────────────────────────────────────────
//  GET /api/auth/login
//  Redirects the agent to RingCentral's OAuth page
// ──────────────────────────────────────────────
router.get('/login', (req, res) => {
  try {
    const { url } = auth.getLoginUrl();
    res.redirect(url);
  } catch (error) {
    console.error('[Auth] ❌ Failed to generate login URL:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate login',
      details: error.message,
    });
  }
});

// ──────────────────────────────────────────────
//  GET /api/auth/callback
//  RingCentral redirects here after agent login.
//  Exchanges code → token → identity → JWT cookie.
// ──────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Handle OAuth errors (user denied, etc.)
  if (error) {
    console.error(`[Auth] ❌ OAuth error: ${error} — ${error_description}`);
    return res.redirect('/?auth_error=' + encodeURIComponent(error_description || error));
  }

  if (!code) {
    console.error('[Auth] ❌ No authorization code received');
    return res.redirect('/?auth_error=' + encodeURIComponent('No authorization code received'));
  }

  try {
    // 1. Exchange code for agent identity
    const agentInfo = await auth.handleCallback(code);

    // 2. Create signed JWT session token
    const sessionToken = auth.createSessionToken(agentInfo);

    // 3. Set HttpOnly cookie and redirect to app
    res.cookie('session_token', sessionToken, COOKIE_OPTS);

    console.log(`[Auth] ✅ Login complete for ${agentInfo.extensionName} — redirecting to app`);
    res.redirect('/');

  } catch (error) {
    console.error('[Auth] ❌ Callback processing failed:', error.message);
    console.error(error);
    res.redirect('/?auth_error=' + encodeURIComponent('Login failed. Please try again.'));
  }
});

// ──────────────────────────────────────────────
//  GET /api/auth/me
//  Returns the current agent's identity from JWT.
//  No DB needed — everything is in the signed cookie.
// ──────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = req.cookies?.session_token;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated',
    });
  }

  try {
    const agent = auth.verifySessionToken(token);
    res.json({
      success: true,
      data: {
        extensionId: agent.extensionId,
        extensionName: agent.extensionName,
        extensionNumber: agent.extensionNumber,
      },
    });
  } catch (err) {
    res.clearCookie('session_token');
    res.status(401).json({
      success: false,
      error: 'Session expired',
    });
  }
});

// ──────────────────────────────────────────────
//  POST /api/auth/logout
//  Clears the session cookie
// ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const token = req.cookies?.session_token;
  let agentName = 'Unknown';
  try {
    if (token) agentName = auth.verifySessionToken(token).extensionName;
  } catch (_) {}

  res.clearCookie('session_token', { path: '/' });
  console.log(`[Auth] 👋 ${agentName} logged out`);
  res.json({ success: true, message: 'Logged out' });
});

module.exports = router;
