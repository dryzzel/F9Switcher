// ============================================================
// Auth Middleware — Verify JWT session token from HttpOnly cookie
//
// Protects all /api/* routes (except /api/auth/*).
// On success: attaches req.agent = { extensionId, extensionName, extensionNumber }
// On failure: responds 401 Unauthorized
// ============================================================
const auth = require('../services/auth');

function requireAuth(req, res, next) {
  const token = req.cookies?.session_token;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated',
      message: 'Please log in with RingCentral to continue.',
    });
  }

  try {
    const decoded = auth.verifySessionToken(token);
    req.agent = {
      extensionId: decoded.extensionId,
      extensionName: decoded.extensionName,
      extensionNumber: decoded.extensionNumber,
    };
    next();
  } catch (err) {
    // Token expired or tampered
    res.clearCookie('session_token');
    return res.status(401).json({
      success: false,
      error: 'Session expired',
      message: 'Your session has expired. Please log in again.',
    });
  }
}

module.exports = requireAuth;
