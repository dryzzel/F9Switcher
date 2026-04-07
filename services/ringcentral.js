// ============================================================
// RingCentral Service Layer
// Handles all communication with the RingCentral REST API
// ============================================================
require('dotenv').config();
const { SDK } = require('@ringcentral/sdk');

let platform = null;
let sdk = null;

// ──────────────────────────────────────────────
//  INITIALIZATION
// ──────────────────────────────────────────────

/**
 * Initialize and authenticate with RingCentral using JWT.
 * The SDK handles token refresh automatically.
 */
async function initialize() {
  sdk = new SDK({
    server: process.env.RC_SERVER_URL,
    clientId: process.env.RC_CLIENT_ID,
    clientSecret: process.env.RC_CLIENT_SECRET,
  });

  platform = sdk.platform();

  await platform.login({ jwt: process.env.RC_JWT });
  console.log('[RC] ✅ Authenticated successfully');

  // Listen for token refresh events
  platform.on(platform.events.refreshSuccess, () => {
    console.log('[RC] 🔄 Token refreshed automatically');
  });

  platform.on(platform.events.refreshError, (e) => {
    console.error('[RC] ❌ Token refresh failed:', e.message);
  });

  return platform;
}

/**
 * Ensure we have a valid platform connection. Re-login if expired.
 */
async function ensurePlatform() {
  if (!platform) {
    await initialize();
  }
  const loggedIn = await platform.loggedIn();
  if (!loggedIn) {
    console.log('[RC] ⚠️ Session expired, re-authenticating...');
    await platform.login({ jwt: process.env.RC_JWT });
  }
  return platform;
}

// ──────────────────────────────────────────────
//  READ OPERATIONS
// ──────────────────────────────────────────────

/**
 * List all user extensions in the account.
 * Filters to only "User" type extensions that are Enabled.
 * Returns: [{ id, extensionNumber, name, email, status }]
 */
async function listExtensions() {
  await ensurePlatform();
  const extensions = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const resp = await platform.get('/restapi/v1.0/account/~/extension', {
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

  console.log(`[RC] 📋 Found ${extensions.length} user extensions`);
  return extensions;
}

/**
 * Get phone numbers assigned to a specific extension.
 * Returns: [{ id, phoneNumber, usageType, type, primary }]
 */
async function getExtensionPhoneNumbers(extensionId) {
  await ensurePlatform();

  const resp = await platform.get(
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
  }));

  console.log(
    `[RC] 📞 Extension ${extensionId} has ${numbers.length} phone numbers`
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
 * These are unassigned numbers ready to be assigned.
 * Returns: [{ id, phoneNumber, type, tollType }]
 */
async function getInventoryNumbers() {
  await ensurePlatform();
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

    const resp = await platform.get(
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

  console.log(`[RC] 📦 Found ${numbers.length} numbers in inventory`);
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
async function replacePhoneNumber(inventoryPhoneNumberId, agentCurrentPhoneNumberId) {
  await ensurePlatform();

  // Ensure IDs are strings (CMN-101 can happen if they're numbers)
  const sourceId = String(inventoryPhoneNumberId);
  const targetId = String(agentCurrentPhoneNumberId);
  const url = `/restapi/v2/accounts/~/phone-numbers/${sourceId}/replace`;
  const body = { targetPhoneNumberId: targetId };

  console.log(`[RC] 🔄 Replace request:`);
  console.log(`[RC]   URL: POST ${url}`);
  console.log(`[RC]   Body: ${JSON.stringify(body)}`);
  console.log(`[RC]   Source (inventory) ID: ${sourceId}`);
  console.log(`[RC]   Target (agent current) ID: ${targetId}`);

  try {
    const resp = await platform.post(url, body);
    const result = await resp.json();
    console.log('[RC] ✅ Phone number replaced successfully');
    console.log('[RC]   Response:', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    // Extract detailed error info from RC API response
    let errorDetail = err.message;
    try {
      if (err.response) {
        const errBody = await err.response.json();
        errorDetail = JSON.stringify(errBody, null, 2);
        console.error('[RC] ❌ API Error Response:', errorDetail);
      }
    } catch (_) {}

    console.error(`[RC] ❌ Replace failed: ${errorDetail}`);
    throw new Error(`RingCentral Replace API failed: ${errorDetail}`);
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
  await ensurePlatform();

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

      const resp = await platform.send({
        method: 'DELETE',
        url,
        body,
      });

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
          const errBody = await err.response.json();
          errorDetail = JSON.stringify(errBody, null, 2);
          errorCode = errBody?.errorCode || errBody?.errors?.[0]?.errorCode || '';
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
        const waitTime = baseDelay * Math.pow(2, attempt - 1); // 5s, 10s, 20s
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
//  EXPORTS
// ──────────────────────────────────────────────

module.exports = {
  initialize,
  listExtensions,
  getExtensionPhoneNumbers,
  getCurrentDirectNumber,
  getInventoryNumbers,
  replacePhoneNumber,
  deletePhoneNumber,
  switchAgentNumber,
};
