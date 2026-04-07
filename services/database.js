// ============================================================
// Database Service — SQLite history/log for number changes
// Uses sql.js (pure JS, no native compilation needed)
// ============================================================
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'history.db');
let db = null;

/**
 * Initialize the SQLite database and create tables if needed.
 */
async function initialize() {
  const SQL = await initSqlJs();

  // Load existing database file or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS number_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extension_id TEXT NOT NULL,
      extension_name TEXT NOT NULL,
      extension_number TEXT NOT NULL,
      old_phone_number TEXT NOT NULL,
      old_phone_number_id TEXT NOT NULL,
      new_phone_number TEXT NOT NULL,
      new_phone_number_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  save();
  console.log('[DB] ✅ Database initialized');
  return db;
}

/**
 * Save the in-memory database to disk.
 */
function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

/**
 * Log a successful number change.
 */
function logChange({
  extensionId,
  extensionName,
  extensionNumber,
  oldPhoneNumber,
  oldPhoneNumberId,
  newPhoneNumber,
  newPhoneNumberId,
}) {
  db.run(
    `INSERT INTO number_changes
      (extension_id, extension_name, extension_number, old_phone_number, old_phone_number_id, new_phone_number, new_phone_number_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'success')`,
    [
      extensionId,
      extensionName,
      extensionNumber,
      oldPhoneNumber,
      oldPhoneNumberId,
      newPhoneNumber,
      newPhoneNumberId,
    ]
  );
  save();
  console.log('[DB] 📝 Change logged');
}

/**
 * Log a failed number change attempt.
 */
function logError({
  extensionId,
  extensionName,
  extensionNumber,
  oldPhoneNumber,
  oldPhoneNumberId,
  errorMessage,
}) {
  db.run(
    `INSERT INTO number_changes
      (extension_id, extension_name, extension_number, old_phone_number, old_phone_number_id, new_phone_number, new_phone_number_id, status, error_message)
    VALUES (?, ?, ?, ?, ?, '', '', 'error', ?)`,
    [
      extensionId,
      extensionName || 'Unknown',
      extensionNumber || '',
      oldPhoneNumber || '',
      oldPhoneNumberId || '',
      errorMessage,
    ]
  );
  save();
}

/**
 * Get change history with optional filters.
 * @param {number} limit - Max records to return
 * @param {string} [extensionId] - Optional filter by extension
 */
function getHistory(limit = 50, extensionId = null) {
  let query = 'SELECT * FROM number_changes';
  const params = [];

  if (extensionId) {
    query += ' WHERE extension_id = ?';
    params.push(extensionId);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const result = db.exec(query, params);
  if (!result.length) return [];

  // Convert sql.js result to array of objects
  const columns = result[0].columns;
  return result[0].values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

/**
 * Get summary stats.
 */
function getStats() {
  const runScalar = (query) => {
    const result = db.exec(query);
    if (!result.length) return 0;
    return result[0].values[0][0] || 0;
  };

  return {
    totalChanges: runScalar(
      "SELECT COUNT(*) FROM number_changes WHERE status = 'success'"
    ),
    todayChanges: runScalar(
      "SELECT COUNT(*) FROM number_changes WHERE status = 'success' AND date(created_at) = date('now', 'localtime')"
    ),
    totalErrors: runScalar(
      "SELECT COUNT(*) FROM number_changes WHERE status = 'error'"
    ),
  };
}

module.exports = {
  initialize,
  logChange,
  logError,
  getHistory,
  getStats,
};
