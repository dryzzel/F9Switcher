// ============================================================
// Number Switcher — Frontend Application Logic
// ============================================================

const API_BASE = '';

// ── State ──
let extensions = [];
let selectedExtension = null;
let currentDirectNumber = null;
let inventoryNumbers = [];

// ── DOM Elements ──
const agentSelect = document.getElementById('agentSelect');
const currentNumberDisplay = document.getElementById('currentNumberDisplay');
const currentNumberValue = document.getElementById('currentNumberValue');
const currentNumberMeta = document.getElementById('currentNumberMeta');
const inventoryInfo = document.getElementById('inventoryInfo');
const inventoryCount = document.getElementById('inventoryCount');
const btnSwitch = document.getElementById('btnSwitch');
const resultArea = document.getElementById('resultArea');
const resultContent = document.getElementById('resultContent');
const historyList = document.getElementById('historyList');
const confirmModal = document.getElementById('confirmModal');
const confirmDetails = document.getElementById('confirmDetails');
const btnCancel = document.getElementById('btnCancel');
const btnConfirm = document.getElementById('btnConfirm');
const btnRefreshHistory = document.getElementById('btnRefreshHistory');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statToday = document.getElementById('statToday');
const statTotal = document.getElementById('statTotal');

// ──────────────────────────────────────────────
//  INITIALIZATION
// ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Load extensions and history in parallel
    await Promise.all([loadExtensions(), loadHistory()]);
    setStatus('connected', 'Connected');
  } catch (error) {
    console.error('Initialization error:', error);
    setStatus('error', 'Connection Failed');
  }

  // Event listeners
  agentSelect.addEventListener('change', onAgentSelected);
  btnSwitch.addEventListener('click', onSwitchClicked);
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', executeSwitchNumber);
  btnRefreshHistory.addEventListener('click', loadHistory);

  // Close modal on overlay click
  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) closeModal();
  });

  // Close modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
});

// ──────────────────────────────────────────────
//  API CALLS
// ──────────────────────────────────────────────

async function apiCall(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API_BASE}${path}`, opts);
  const data = await resp.json();

  if (!resp.ok || !data.success) {
    throw new Error(data.details || data.error || 'API request failed');
  }

  return data;
}

// ──────────────────────────────────────────────
//  LOAD DATA
// ──────────────────────────────────────────────

async function loadExtensions() {
  try {
    const { data } = await apiCall('GET', '/api/extensions');
    extensions = data;

    // Populate the dropdown
    agentSelect.innerHTML = '<option value="">— Select an agent —</option>';
    for (const ext of extensions) {
      const option = document.createElement('option');
      option.value = ext.id;
      option.dataset.name = ext.name;
      option.dataset.number = ext.extensionNumber;
      option.textContent = `${ext.name} (Ext. ${ext.extensionNumber})`;
      agentSelect.appendChild(option);
    }
    agentSelect.disabled = false;
  } catch (error) {
    agentSelect.innerHTML = '<option value="">Error loading agents</option>';
    console.error('Failed to load extensions:', error);
    throw error;
  }
}

async function loadHistory() {
  try {
    const { data, stats } = await apiCall('GET', '/api/history?limit=50');

    // Update stats
    statToday.textContent = stats.todayChanges;
    statTotal.textContent = stats.totalChanges;

    // Render history
    if (data.length === 0) {
      historyList.innerHTML = `
        <div class="history-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          <p>No changes recorded yet</p>
          <span>Changes will appear here after the first switch</span>
        </div>
      `;
      return;
    }

    historyList.innerHTML = data
      .map((entry) => {
        const isSuccess = entry.status === 'success';
        const time = formatTime(entry.created_at);

        if (isSuccess) {
          return `
            <div class="history-item">
              <div class="history-icon-wrap success">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>
              <div class="history-details">
                <div class="history-agent">${escapeHtml(entry.extension_name)} (Ext. ${escapeHtml(entry.extension_number)})</div>
                <div class="history-numbers">
                  ${formatPhone(entry.old_phone_number)}
                  <span class="arrow">→</span>
                  ${formatPhone(entry.new_phone_number)}
                </div>
                <div class="history-time">${time}</div>
              </div>
            </div>
          `;
        } else {
          return `
            <div class="history-item">
              <div class="history-icon-wrap error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </div>
              <div class="history-details">
                <div class="history-agent">${escapeHtml(entry.extension_name)}</div>
                <div class="history-error-msg">${escapeHtml(entry.error_message || 'Unknown error')}</div>
                <div class="history-time">${time}</div>
              </div>
            </div>
          `;
        }
      })
      .join('');
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

// ──────────────────────────────────────────────
//  EVENT HANDLERS
// ──────────────────────────────────────────────

async function onAgentSelected() {
  const extensionId = agentSelect.value;

  // Reset state
  currentDirectNumber = null;
  inventoryNumbers = [];
  btnSwitch.disabled = true;
  resultArea.style.display = 'none';

  if (!extensionId) {
    currentNumberDisplay.style.display = 'none';
    inventoryInfo.style.display = 'none';
    return;
  }

  // Find the selected extension
  selectedExtension = extensions.find((e) => String(e.id) === extensionId);

  // Fetch current number and inventory in parallel
  try {
    agentSelect.disabled = true;

    const [numbersResp, invResp] = await Promise.all([
      apiCall('GET', `/api/extensions/${extensionId}/numbers`),
      apiCall('GET', '/api/inventory'),
    ]);

    // Show current number
    currentDirectNumber = numbersResp.data.directNumber;
    if (currentDirectNumber) {
      currentNumberValue.textContent = formatPhone(currentDirectNumber.phoneNumber);
      currentNumberMeta.textContent = `ID: ${currentDirectNumber.id} • ${currentDirectNumber.usageType}`;
      currentNumberDisplay.style.display = 'block';
    } else {
      currentNumberValue.textContent = 'No Direct Number Found';
      currentNumberMeta.textContent = 'This agent may not have a Softphone number assigned';
      currentNumberDisplay.style.display = 'block';
    }

    // Show inventory info
    inventoryNumbers = invResp.data;
    inventoryCount.textContent = inventoryNumbers.length;
    inventoryInfo.style.display = 'flex';

    // Enable switch button if we have both a current number and inventory
    btnSwitch.disabled = !currentDirectNumber || inventoryNumbers.length === 0;
  } catch (error) {
    console.error('Error loading agent data:', error);
    currentNumberValue.textContent = 'Error';
    currentNumberMeta.textContent = error.message;
    currentNumberDisplay.style.display = 'block';
  } finally {
    agentSelect.disabled = false;
  }
}

function onSwitchClicked() {
  if (!selectedExtension || !currentDirectNumber) return;

  // Show confirmation modal
  confirmDetails.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Agent</span>
      <span class="detail-value">${escapeHtml(selectedExtension.name)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Extension</span>
      <span class="detail-value">${escapeHtml(selectedExtension.extensionNumber)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Current Number</span>
      <span class="detail-value">${formatPhone(currentDirectNumber.phoneNumber)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">New Number</span>
      <span class="detail-value" style="color: var(--accent-secondary)">Random from inventory (${inventoryNumbers.length} available)</span>
    </div>
  `;
  confirmModal.style.display = 'flex';
}

function closeModal() {
  confirmModal.style.display = 'none';
}

async function executeSwitchNumber() {
  closeModal();

  // Show loading state
  const btnText = btnSwitch.querySelector('.btn-text');
  const btnLoader = btnSwitch.querySelector('.btn-loader');
  btnText.style.display = 'none';
  btnSwitch.querySelector('.btn-icon').style.display = 'none';
  btnLoader.style.display = 'flex';
  btnSwitch.disabled = true;
  agentSelect.disabled = true;

  try {
    const { data } = await apiCall('POST', '/api/switch-number', {
      extensionId: String(selectedExtension.id),
      extensionName: selectedExtension.name,
      extensionNumber: selectedExtension.extensionNumber,
    });

    // Show success result
    const deletionBadge = data.oldNumberDeleted
      ? `<div class="deletion-badge success">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
             <polyline points="20 6 9 17 4 12"></polyline>
           </svg>
           Old number permanently deleted
         </div>`
      : `<div class="deletion-badge warning">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
             <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
             <line x1="12" y1="9" x2="12" y2="13"></line>
             <line x1="12" y1="17" x2="12.01" y2="17"></line>
           </svg>
           Old number may still be in inventory
         </div>`;

    resultContent.innerHTML = `
      <div class="result-success">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="result-icon">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <div class="result-text">
          <h4>Number Switched Successfully!</h4>
          <p>${escapeHtml(data.message)}</p>
        </div>
      </div>
      <div class="number-swap-display">
        <span class="old-num">${formatPhone(data.oldNumber)}</span>
        <span class="arrow">→</span>
        <span class="new-num">${formatPhone(data.newNumber)}</span>
      </div>
      ${deletionBadge}
    `;
    resultArea.style.display = 'block';

    // Refresh the agent's current number display
    currentNumberValue.textContent = formatPhone(data.newNumber);
    currentNumberMeta.textContent = 'Just updated';

    // Refresh history and stats
    await loadHistory();
  } catch (error) {
    // Show error result
    resultContent.innerHTML = `
      <div class="result-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="result-icon">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        <div class="result-text">
          <h4>Switch Failed</h4>
          <p>${escapeHtml(error.message)}</p>
        </div>
      </div>
    `;
    resultArea.style.display = 'block';

    // Refresh history (error attempts are also logged)
    await loadHistory();
  } finally {
    // Restore button state
    btnText.style.display = 'inline';
    btnSwitch.querySelector('.btn-icon').style.display = 'block';
    btnLoader.style.display = 'none';
    btnSwitch.disabled = false;
    agentSelect.disabled = false;
  }
}

// ──────────────────────────────────────────────
//  UTILITIES
// ──────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state === 'connected') statusDot.classList.add('connected');
  else if (state === 'error') statusDot.classList.add('error');
  statusText.textContent = text;
}

function formatPhone(phone) {
  if (!phone) return '—';
  // Format US numbers: +1XXXXXXXXXX → (XXX) XXX-XXXX
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `(${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  }
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  // If less than 1 minute
  if (diff < 60000) return 'Just now';
  // If less than 1 hour
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  // If today
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  // If yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  // Otherwise
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
