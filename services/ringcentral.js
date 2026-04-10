// ============================================================
// RingCentral Service Layer
// Handles all communication with the RingCentral REST API
// ============================================================
require('dotenv').config();
const { SDK } = require('@ringcentral/sdk');

let platform = null;
let sdk = null;

// ── Token management (prevents auth rate limit storm) ──
let _tokenExpiresAt = 0;          // timestamp (ms) when token expires
let _loginPromise = null;         // mutex: prevents concurrent logins
const TOKEN_SAFETY_MARGIN = 120000; // re-login 2 min before expiry

// ── In-memory cache (reduces API calls by ~80%) ──
const _cache = {
  extensions:     { data: null, expiresAt: 0 },
  inventory:      { data: null, expiresAt: 0 },
  phoneNumbers:   new Map(), // extensionId → { data, expiresAt }
};
const CACHE_TTL = {
  extensions:   5 * 60 * 1000,  // 5 min — extensions rarely change
  inventory:    2 * 60 * 1000,  // 2 min — changes after a switch
  phoneNumbers: 60 * 1000,      // 1 min — changes after a switch
};

// ── Rate limit callback (set by queue via onRateLimitInfo) ──
let _rateLimitCallback = null;

/**
 * Subscribe to rate limit info from RC API responses.
 * @param {function} callback — receives { group, remaining, limit, window, is429?, retryAfter? }
 */
function onRateLimitInfo(callback) {
  _rateLimitCallback = callback;
}

/**
 * Extract rate limit headers from an RC API response and notify subscriber.
 */
function _reportRateLimit(resp, is429 = false, retryAfter = null) {
  try {
    const headers = resp?.headers;
    if (!headers || !headers.get) return;

    const group = headers.get('x-rate-limit-group') || '';
    const remaining = headers.get('x-rate-limit-remaining') || '';
    const limit = headers.get('x-rate-limit-limit') || '';
    const window = headers.get('x-rate-limit-window') || '';

    if (group) {
      console.log(`[RC] 📊 Rate [${group}]: ${remaining}/${limit} left (window: ${window}s)`);
      if (_rateLimitCallback) {
        _rateLimitCallback({ group, remaining, limit, window, is429, retryAfter });
      }
    }
  } catch (_) {}
}

// ──────────────────────────────────────────────
//  INITIALIZATION & TOKEN MANAGEMENT
// ──────────────────────────────────────────────

/**
 * Initialize and authenticate with RingCentral using JWT.
 *
 * KEY FIX: JWT auth does NOT produce refresh tokens, so the SDK's
 * auto-refresh always fails with "Refresh token is missing".
 * We track token expiry ourselves and re-login proactively.
 */
async function initialize() {
  sdk = new SDK({
    server: process.env.RC_SERVER_URL,
    clientId: process.env.RC_CLIENT_ID,
    clientSecret: process.env.RC_CLIENT_SECRET,
  });

  platform = sdk.platform();

  await _doLogin();

  // Listen for token events (informational only — we handle re-login ourselves)
  platform.on(platform.events.refreshSuccess, () => {
    console.log('[RC] 🔄 Token refreshed automatically');
    _updateTokenExpiry();
  });

  platform.on(platform.events.refreshError, () => {
    // Suppress the noisy error — JWT has no refresh token, this is expected.
    // Our ensurePlatform() will handle re-login when needed.
  });

  return platform;
}

/**
 * Perform a JWT login and record the token expiry time.
 */
async function _doLogin() {
  console.log('[RC] 🔑 Logging in with JWT...');
  await platform.login({ jwt: process.env.RC_JWT });
  _updateTokenExpiry();
  console.log(`[RC] ✅ Authenticated (token valid for ${Math.round((_tokenExpiresAt - Date.now()) / 60000)} min)`);
}

/**
 * Read the token data from the SDK and set our expiry tracker.
 */
function _updateTokenExpiry() {
  try {
    const tokenData = platform.auth().data();
    if (tokenData && tokenData.expires_in) {
      // expires_in is in seconds; we convert and subtract a safety margin
      _tokenExpiresAt = Date.now() + (tokenData.expires_in * 1000) - TOKEN_SAFETY_MARGIN;
    } else {
      // Fallback: assume 1 hour (RC default) minus safety margin
      _tokenExpiresAt = Date.now() + (3600 * 1000) - TOKEN_SAFETY_MARGIN;
    }
  } catch (_) {
    _tokenExpiresAt = Date.now() + (3600 * 1000) - TOKEN_SAFETY_MARGIN;
  }
}

/**
 * Ensure we have a valid platform connection.
 *
 * KEY FIX: Uses a mutex (_loginPromise) so that if 10 requests all
 * discover the token is expired simultaneously, only ONE login happens.
 * The other 9 await the same promise.
 *
 * Also checks our own expiry tracker instead of calling platform.loggedIn(),
 * which was triggering failed refresh attempts that flood the logs and
 * eat the auth rate limit (5 req/60s).
 */
async function ensurePlatform() {
  if (!platform) {
    await initialize();
    return platform;
  }

  const now = Date.now();

  // Token still fresh — fast path, no API call needed
  if (now < _tokenExpiresAt) {
    return platform;
  }

  // Token expired or about to expire — need to re-login.
  // Use mutex: if another request is already logging in, wait for it.
  if (_loginPromise) {
    console.log('[RC] ⏳ Waiting for in-flight re-login...');
    await _loginPromise;
    return platform;
  }

  // We're the first to detect expiry — do the login
  _loginPromise = _doLogin()
    .catch((err) => {
      console.error('[RC] ❌ Re-login failed:', err.message);
      throw err;
    })
    .finally(() => {
      _loginPromise = null; // release mutex
    });

  await _loginPromise;
  return platform;
}

/**
 * Wrapper for all RC SDK API calls.
 *
 * KEY FIX: The RC SDK's platform.get()/post() internally check the access
 * token and try to refresh it before making the HTTP call. With JWT auth,
 * there is NO refresh token, so the SDK throws "Refresh token is missing".
 *
 * This wrapper catches that specific error, re-authenticates with JWT,
 * and retries the call ONCE — making the token refresh transparent.
 *
 * @param {'get'|'post'|'send'} method — SDK method to call
 * @param {string} url — API endpoint
 * @param {object} [body] — Request body (for post) or query params (for get)
 * @returns {Promise<Response>}
 */
async function _apiCall(method, url, body = null) {
  await ensurePlatform();

  try {
    if (method === 'get') {
      return await platform.get(url, body);
    } else if (method === 'post') {
      return await platform.post(url, body);
    } else if (method === 'send') {
      return await platform.send(body); // body is the full request config
    }
  } catch (err) {
    // Check if this is the SDK's internal "Refresh token is missing" error
    const isRefreshError =
      err.message && err.message.includes('Refresh token');

    if (isRefreshError) {
      console.log('[RC] 🔄 SDK refresh failed internally, re-authenticating with JWT...');

      // Force re-login (bypass our expiry check)
      _tokenExpiresAt = 0;
      await ensurePlatform();

      // Retry the call once
      if (method === 'get') {
        return await platform.get(url, body);
      } else if (method === 'post') {
        return await platform.post(url, body);
      } else if (method === 'send') {
        return await platform.send(body);
      }
    }

    throw err; // Non-refresh errors propagate normally
  }
}

/**
 * Invalidate cache entries that change after a number switch.
 */
function invalidateSwitchCache(extensionId) {
  _cache.inventory.expiresAt = 0;
  if (extensionId) {
    _cache.phoneNumbers.delete(String(extensionId));
  }
  console.log('[RC] 🗑️ Cache invalidated (inventory + agent numbers)');
}

// ──────────────────────────────────────────────
//  READ OPERATIONS
// ──────────────────────────────────────────────

/**
 * List all user extensions in the account.
 * Filters to only "User" type extensions that are Enabled.
 * CACHED: 5 minutes (extensions rarely change)
 * Returns: [{ id, extensionNumber, name, email, status }]
 */
async function listExtensions() {
  // Check cache first
  const now = Date.now();
  if (_cache.extensions.data && now < _cache.extensions.expiresAt) {
    return _cache.extensions.data;
  }

  const extensions = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const resp = await _apiCall('get', '/restapi/v1.0/account/~/extension', {
      type: 'User',
      status: 'Enabled',
      page,
      perPage: 100,
    });
    const data = await resp.json();
    totalPages = data.paging?.totalPages || 1;

    for (const ext of data.records || []) {
      extensions.push({
        id: ext.id,
        extensionNumber: ext.extensionNumber,
        name: ext.name || `Ext ${ext.extensionNumber}`,
        email: ext.contact?.email || '',
        status: ext.status,
      });
    }
    page++;
  }

  // Update cache
  _cache.extensions.data = extensions;
  _cache.extensions.expiresAt = now + CACHE_TTL.extensions;

  console.log(`[RC] 📋 Found ${extensions.length} user extensions (cached ${CACHE_TTL.extensions / 1000}s)`);
  return extensions;
}

/**
 * Get phone numbers assigned to a specific extension.
 * CACHED: 1 minute per extension (invalidated after switch)
 * Returns: [{ id, phoneNumber, usageType, type, primary }]
 */
async function getExtensionPhoneNumbers(extensionId) {
  const extIdStr = String(extensionId);
  const now = Date.now();

  // Check cache first
  const cached = _cache.phoneNumbers.get(extIdStr);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const resp = await _apiCall('get',
    `/restapi/v1.0/account/~/extension/${extensionId}/phone-number`
  );
  const data = await resp.json();

  const numbers = (data.records || []).map((n) => ({
    id: n.id,
    phoneNumber: n.phoneNumber,
    usageType: n.usageType,
    type: n.type,
    primary: n.primary || false,
    label: n.label || '',
    features: n.features || [],
  }));

  // Update cache
  _cache.phoneNumbers.set(extIdStr, {
    data: numbers,
    expiresAt: now + CACHE_TTL.phoneNumbers,
  });

  console.log(
    `[RC] 📞 Extension ${extensionId} has ${numbers.length} phone numbers (cached ${CACHE_TTL.phoneNumbers / 1000}s)`
  );
  return numbers;
}

/**
 * Get the current DirectNumber phone number for an extension.
 * This is the number we want to replace.
 * Returns: { id, phoneNumber, usageType } or null
 */
async function getCurrentDirectNumber(extensionId) {
  const numbers = await getExtensionPhoneNumbers(extensionId);

  // Find the DirectNumber (this is the one shown as "Softphone" in the UI)
  const directNumber = numbers.find(
    (n) => n.usageType === 'DirectNumber'
  );

  if (!directNumber) {
    console.warn(
      `[RC] ⚠️ No DirectNumber found for extension ${extensionId}`
    );
    return null;
  }

  console.log(
    `[RC] 🎯 Current DirectNumber: ${directNumber.phoneNumber} (ID: ${directNumber.id})`
  );
  return directNumber;
}

/**
 * List available phone numbers in the company inventory.
 * CACHED: 2 minutes (invalidated after switch)
 * These are unassigned numbers ready to be assigned.
 * Returns: [{ id, phoneNumber, type, tollType }]
 */
async function getInventoryNumbers() {
  // Check cache first
  const now = Date.now();
  if (_cache.inventory.data && now < _cache.inventory.expiresAt) {
    return _cache.inventory.data;
  }

  const numbers = [];
  let pageToken = null;

  do {
    const params = {
      usageType: 'Inventory',
      perPage: 100,
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    const resp = await _apiCall('get',
      '/restapi/v2/accounts/~/phone-numbers',
      params
    );
    const data = await resp.json();

    for (const n of data.records || []) {
      numbers.push({
        id: n.id,
        phoneNumber: n.phoneNumber,
        type: n.type,
        tollType: n.tollType || 'Toll',
      });
    }

    pageToken = data.paging?.nextPageToken || null;
  } while (pageToken);

  // Update cache
  _cache.inventory.data = numbers;
  _cache.inventory.expiresAt = now + CACHE_TTL.inventory;

  console.log(`[RC] 📦 Found ${numbers.length} numbers in inventory (cached ${CACHE_TTL.inventory / 1000}s)`);
  return numbers;
}

// ──────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────

/**
 * Async delay helper — pauses execution for the given ms.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────
//  WRITE OPERATIONS
// ──────────────────────────────────────────────

/**
 * Replace a phone number using the v2 Replace endpoint.
 *
 * POST /restapi/v2/accounts/~/phone-numbers/{sourcePhoneNumberId}/replace
 * Body: { targetPhoneNumberId: "..." }
 *
 * RC semantics:
 *   - {sourcePhoneNumberId} in URL = the INVENTORY number (the new one coming in)
 *   - targetPhoneNumberId in body  = the CURRENT number on the agent (being replaced)
 *
 * Result:
 *   - The inventory number takes the place of the agent's current number
 *   - The agent's old number goes back to inventory
 *   - Device ID, extension, and license remain UNTOUCHED
 *
 * @param {string} inventoryPhoneNumberId - ID of the number FROM INVENTORY (source, goes in URL)
 * @param {string} agentCurrentPhoneNumberId - ID of the agent's CURRENT number (target, goes in body)
 */
async function replacePhoneNumber(inventoryPhoneNumberId, agentCurrentPhoneNumberId, maxRetries = 3) {
  const sourceId = String(inventoryPhoneNumberId);
  const targetId = String(agentCurrentPhoneNumberId);
  const url = `/restapi/v2/accounts/~/phone-numbers/${sourceId}/replace`;
  const body = { targetPhoneNumberId: targetId };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[RC] 🔄 Replace attempt ${attempt}/${maxRetries}: POST ${url}`);
      const resp = await _apiCall('post', url, body);

      // Read rate limit headers
      _reportRateLimit(resp);

      // Record heavy call in queue
      try { require('./queue').recordHeavyCall(); } catch (_) {}

      const result = await resp.json();
      console.log('[RC] ✅ Phone number replaced successfully');
      return result;
    } catch (err) {
      let statusCode = null;
      let retryAfter = 60;
      let errorDetail = err.message;

      try {
        if (err.response) {
          statusCode = err.response.status;
          retryAfter = parseInt(err.response.headers?.get('retry-after')) || 60;
          const errBody = await err.response.json();
          errorDetail = JSON.stringify(errBody, null, 2);
          _reportRateLimit(err.response, statusCode === 429, retryAfter);
        }
      } catch (_) {}

      console.warn(`[RC] ⚠️ Replace attempt ${attempt} failed (HTTP ${statusCode}): ${errorDetail}`);

      if (statusCode === 429 && attempt < maxRetries) {
        console.log(`[RC] 🛑 Rate limited! Waiting ${retryAfter}s...`);
        await delay(retryAfter * 1000);
        continue;
      }

      throw new Error(`RingCentral Replace API failed: ${errorDetail}`);
    }
  }
}

/**
 * Delete a phone number permanently from the RingCentral account.
 *
 * DELETE /restapi/v2/accounts/~/phone-numbers
 * Body: { records: [{ id: "..." }] }
 *
 * IMPORTANT:
 *   - The number MUST be in "Inventory" (Unassigned) status before deletion.
 *   - After a Replace call, there can be a delay before RC marks it as Inventory.
 *   - This function includes retry logic with exponential backoff to handle that.
 *
 * @param {string} phoneNumberId - The ID of the number to delete
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 */
async function deletePhoneNumber(phoneNumberId, maxRetries = 3) {
  const numberId = String(phoneNumberId);
  const url = '/restapi/v2/accounts/~/phone-numbers';
  const body = { records: [{ id: numberId }] };

  // Retry loop with exponential backoff
  // Delays: 5s → 10s → 20s (total max wait: ~35s)
  const baseDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[RC] 🗑️  Delete attempt ${attempt}/${maxRetries} for number ID: ${numberId}`);
      console.log(`[RC]   URL: DELETE ${url}`);
      console.log(`[RC]   Body: ${JSON.stringify(body)}`);

      const resp = await _apiCall('send', null, {
        method: 'DELETE',
        url,
        body,
      });

      // Read rate limit headers
      _reportRateLimit(resp);

      // Record heavy call in queue
      try { require('./queue').recordHeavyCall(); } catch (_) {}

      // 204 No Content = success (no body to parse)
      // Some RC endpoints return 200 with a body
      let result = null;
      try {
        result = await resp.json();
      } catch (_) {
        // 204 responses have no body — that's fine
      }

      console.log(`[RC] ✅ Phone number ${numberId} deleted permanently from account`);
      return { success: true, deletedId: numberId, response: result };
    } catch (err) {
      let errorDetail = err.message;
      let statusCode = null;
      let errorCode = '';

      try {
        if (err.response) {
          statusCode = err.response.status;
          const retryAfterHeader = parseInt(err.response.headers?.get('retry-after')) || 60;
          const errBody = await err.response.json();
          errorDetail = JSON.stringify(errBody, null, 2);
          errorCode = errBody?.errorCode || errBody?.errors?.[0]?.errorCode || '';
          _reportRateLimit(err.response, statusCode === 429, retryAfterHeader);
        }
      } catch (_) {}

      console.warn(`[RC] ⚠️ Delete attempt ${attempt} failed (HTTP ${statusCode}): ${errorDetail}`);

      // Determine if we should retry
      // Retry on: 409 Conflict, 429 Too Many Requests, locked resources, or 500-level errors
      const isRetryable =
        statusCode === 409 ||
        statusCode === 429 ||
        (statusCode >= 500 && statusCode < 600) ||
        errorCode.includes('CMN-211') || // Resource locked
        errorDetail.includes('locked') ||
        errorDetail.includes('cannot be deleted');

      if (isRetryable && attempt < maxRetries) {
        // Use Retry-After header for 429, otherwise exponential backoff
        const waitTime = statusCode === 429
          ? (parseInt(err.response?.headers?.get('retry-after')) || 60) * 1000
          : baseDelay * Math.pow(2, attempt - 1);
        console.log(`[RC] ⏳ Waiting ${waitTime / 1000}s before retry...`);
        await delay(waitTime);
        continue;
      }

      // Non-retryable error or max retries exhausted
      console.error(`[RC] ❌ Delete permanently failed after ${attempt} attempt(s): ${errorDetail}`);
      throw new Error(`Failed to delete old number (ID: ${numberId}): ${errorDetail}`);
    }
  }
}

// ──────────────────────────────────────────────
//  ORCHESTRATOR — MAIN FLOW
// ──────────────────────────────────────────────

/**
 * Complete flow to switch an agent's phone number AND delete the old one.
 *
 * Steps:
 * 1. Get the agent's current DirectNumber (Softphone)
 * 2. ★ Save the old number's phoneNumberId for later deletion
 * 3. Get available numbers from inventory & pick one
 * 4. Execute the Replace call (old number goes to inventory automatically)
 * 5. ★ Wait for RC to process, then DELETE the old number from the account
 * 6. Return old/new number info + deletion result
 *
 * @param {string} extensionId - The RingCentral extension ID of the agent
 * @param {string} [preferredNumberId] - Optional: specific inventory number ID to use
 * @returns {{ success, oldNumber, newNumber, extensionId, oldNumberDeleted }}
 */
async function switchAgentNumber(extensionId, preferredNumberId = null) {
  // ─── Step 1: Find the agent's current DirectNumber ───
  const currentNumber = await getCurrentDirectNumber(extensionId);
  if (!currentNumber) {
    throw new Error(
      `No DirectNumber found for extension ${extensionId}. The agent may not have a Softphone number assigned.`
    );
  }

  // ─── Step 2: ★ Capture the old number ID for deletion later ───
  const oldNumberId = String(currentNumber.id);
  const oldNumberPhone = currentNumber.phoneNumber;
  console.log(`[RC] 📌 Old number captured for deletion: ${oldNumberPhone} (ID: ${oldNumberId})`);

  // ─── Step 3: Get inventory & choose replacement ───
  const inventory = await getInventoryNumbers();
  if (inventory.length === 0) {
    throw new Error(
      'No phone numbers available in the company inventory. Please add numbers to the inventory first.'
    );
  }

  let targetNumber;
  if (preferredNumberId) {
    targetNumber = inventory.find((n) => n.id === preferredNumberId);
    if (!targetNumber) {
      throw new Error(
        `Preferred number ID ${preferredNumberId} not found in inventory.`
      );
    }
  } else {
    // Pick a random number from inventory
    const randomIndex = Math.floor(Math.random() * inventory.length);
    targetNumber = inventory[randomIndex];
  }

  console.log(
    `[RC] 🔀 Switching: ${currentNumber.phoneNumber} → ${targetNumber.phoneNumber}`
  );

  // ─── Step 4: Execute the Replace ───
  const replaceResult = await replacePhoneNumber(targetNumber.id, currentNumber.id);

  // ─── Step 4b: Invalidate caches (inventory changed, agent number changed) ───
  invalidateSwitchCache(extensionId);

  // ─── Step 5: ★ Wait and then DELETE the old number ───
  // After the Replace, the old number is returned to Inventory.
  // We wait a bit for RingCentral to fully release the resource before deleting.
  const initialDelay = 5000; // 5 seconds initial wait
  console.log(`[RC] ⏳ Waiting ${initialDelay / 1000}s for RC to release the old number...`);
  await delay(initialDelay);

  let oldNumberDeleted = false;
  let deleteError = null;
  try {
    await deletePhoneNumber(oldNumberId);
    oldNumberDeleted = true;
    console.log(`[RC] 🗑️  Old number ${oldNumberPhone} (ID: ${oldNumberId}) DELETED from account`);
  } catch (err) {
    // The switch itself was successful — deletion failure is logged but not fatal
    deleteError = err.message;
    console.error(`[RC] ⚠️ Switch succeeded but old number deletion failed: ${err.message}`);
    console.error(`[RC] ⚠️ The old number ${oldNumberPhone} may still be in your inventory.`);
  }

  // ─── Step 6: Return result ───
  return {
    success: true,
    extensionId,
    oldNumber: {
      id: oldNumberId,
      phoneNumber: oldNumberPhone,
    },
    newNumber: {
      id: targetNumber.id,
      phoneNumber: targetNumber.phoneNumber,
    },
    oldNumberDeleted,
    deleteError,
    apiResponse: replaceResult,
  };
}

// ──────────────────────────────────────────────
//  SMS / A2P 10DLC — TCR Campaign Registration
// ──────────────────────────────────────────────

/**
 * List all TCR Brands registered on the account.
 * GET /restapi/v1.0/account/~/sms-registration-brands
 * Used for auto-discovery when RC_TCR_BRAND_ID is not set.
 * @returns {Array} [{ id, name, status, externalId, ... }]
 */
async function listTcrBrands() {
  const resp = await _apiCall('get', '/restapi/v1.0/account/~/sms-registration-brands');
  _reportRateLimit(resp);
  const data = await resp.json();
  return data.records || [];
}

/**
 * List all TCR Campaigns for a specific Brand.
 * GET /restapi/v1.0/account/~/sms-registration-brands/{brandId}/campaigns
 * @param {string|number} brandId — TCR Brand ID
 * @returns {Array} [{ id, name, status, externalId, useCases, ... }]
 */
async function listTcrCampaigns(brandId) {
  const resp = await _apiCall('get',
    `/restapi/v1.0/account/~/sms-registration-brands/${brandId}/campaigns`
  );
  _reportRateLimit(resp);
  const data = await resp.json();
  return data.records || [];
}

/**
 * Link a phone number to a TCR Campaign for SMS activation.
 * POST /restapi/v1.0/account/~/sms-registration-brands/{brandId}/campaigns/{campaignId}/submit-phone-numbers
 *
 * ⚠️ Requires EditAccounts scope (admin token).
 * ⚠️ SMS activation may take up to 48 hours after linking.
 *
 * @param {string|number} brandId — TCR Brand ID
 * @param {string|number} campaignId — TCR Campaign ID
 * @param {string} phoneNumberE164 — Phone number in E.164 format (e.g. "+16505550111")
 * @returns {boolean} true if successful (200 OK)
 */
async function linkPhoneNumberToCampaign(brandId, campaignId, phoneNumberE164) {
  console.log(`[RC-SMS] 📱 Linking ${phoneNumberE164} to campaign ${campaignId}...`);
  const resp = await _apiCall('post',
    `/restapi/v1.0/account/~/sms-registration-brands/${brandId}/campaigns/${campaignId}/submit-phone-numbers`,
    { phoneNumbers: [phoneNumberE164] }
  );
  _reportRateLimit(resp);
  console.log(`[RC-SMS] ✅ Number ${phoneNumberE164} linked to campaign ${campaignId}`);
  return true;
}

/**
 * Read the SMS configuration (TCR brand/campaign info) for a phone number.
 * GET /restapi/v1.0/account/~/extension/{extId}/phone-number/{phoneNumberId}/sms-configuration
 *
 * @param {string} extensionId — Extension ID
 * @param {string} phoneNumberId — Phone number resource ID
 * @returns {{ smsCampaignInfo, smsBrandInfo }|null} — null if no SMS config
 */
async function getSmsConfiguration(extensionId, phoneNumberId) {
  try {
    const resp = await _apiCall('get',
      `/restapi/v1.0/account/~/extension/${extensionId}/phone-number/${phoneNumberId}/sms-configuration`
    );
    _reportRateLimit(resp);
    return await resp.json();
  } catch (err) {
    // If the number has no SMS config, RC may return 404 or empty
    const statusCode = err.response?.status || err.apiResponse?.status;
    if (statusCode === 404 || statusCode === 400) return null;
    throw err;
  }
}

// ──────────────────────────────────────────────
//  EXPORTS
// ──────────────────────────────────────────────

module.exports = {
  initialize,
  onRateLimitInfo,
  invalidateSwitchCache,
  listExtensions,
  getExtensionPhoneNumbers,
  getCurrentDirectNumber,
  getInventoryNumbers,
  replacePhoneNumber,
  deletePhoneNumber,
  switchAgentNumber,
  listTcrBrands,
  listTcrCampaigns,
  linkPhoneNumberToCampaign,
  getSmsConfiguration,
};
