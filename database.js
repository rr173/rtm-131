const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'geofence.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`
    CREATE TABLE IF NOT EXISTS fences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('forbidden_enter', 'forbidden_leave', 'normal')),
      color TEXT NOT NULL,
      vertices TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      fence_id INTEGER NOT NULL,
      fence_name TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('enter', 'leave')),
      level TEXT NOT NULL CHECK(level IN ('warning', 'critical')),
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pois (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      color TEXT DEFAULT '#ff6b6b',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_target ON alerts(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_fence ON alerts(fence_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level)`);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

const FenceModel = {
  async getAll() {
    const rows = await all('SELECT * FROM fences ORDER BY created_at DESC');
    return rows.map(row => ({ ...row, vertices: JSON.parse(row.vertices) }));
  },
  async getById(id) {
    const row = await get('SELECT * FROM fences WHERE id = ?', [id]);
    if (!row) return null;
    return { ...row, vertices: JSON.parse(row.vertices) };
  },
  async create({ name, type, color, vertices }) {
    const result = await run(
      'INSERT INTO fences (name, type, color, vertices) VALUES (?, ?, ?, ?)',
      [name, type, color, JSON.stringify(vertices)]
    );
    return this.getById(result.lastID);
  },
  async update(id, { name, type, color, vertices }) {
    await run(
      'UPDATE fences SET name = ?, type = ?, color = ?, vertices = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, type, color, JSON.stringify(vertices), id]
    );
    return this.getById(id);
  },
  async delete(id) {
    await run('DELETE FROM fences WHERE id = ?', [id]);
    return true;
  }
};

const AlertModel = {
  async create({ target_id, target_name, fence_id, fence_name, event_type, level, lng, lat }) {
    const result = await run(
      'INSERT INTO alerts (target_id, target_name, fence_id, fence_name, event_type, level, lng, lat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [target_id, target_name, fence_id, fence_name, event_type, level, lng, lat]
    );
    return this.getById(result.lastID);
  },
  async getById(id) {
    return get('SELECT * FROM alerts WHERE id = ?', [id]);
  },
  async query({ target_id, fence_id, start_time, end_time, level, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM alerts WHERE 1=1';
    const params = [];
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (fence_id !== undefined) { sql += ' AND fence_id = ?'; params.push(fence_id); }
    if (level) { sql += ' AND level = ?'; params.push(level); }
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return all(sql, params);
  },
  async getTodayCount() {
    const row = await get(`
      SELECT COUNT(*) as count FROM alerts 
      WHERE DATE(timestamp) = DATE('now')
    `);
    return row ? row.count : 0;
  }
};

const POIModel = {
  async getAll() {
    return all('SELECT * FROM pois ORDER BY created_at DESC');
  },
  async create({ name, lng, lat, color }) {
    const result = await run(
      'INSERT INTO pois (name, lng, lat, color) VALUES (?, ?, ?, ?)',
      [name, lng, lat, color || '#ff6b6b']
    );
    return this.getById(result.lastID);
  },
  async getById(id) {
    return get('SELECT * FROM pois WHERE id = ?', [id]);
  },
  async delete(id) {
    await run('DELETE FROM pois WHERE id = ?', [id]);
    return true;
  }
};

module.exports = {
  db,
  FenceModel,
  AlertModel,
  POIModel
};
