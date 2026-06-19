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
      level TEXT NOT NULL CHECK(level IN ('none', 'info', 'warning', 'critical')),
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      rule_id INTEGER,
      group_id INTEGER,
      group_name TEXT,
      custom_message TEXT,
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
  db.run(`
    CREATE TABLE IF NOT EXISTS target_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      description TEXT,
      default_level TEXT NOT NULL CHECK(default_level IN ('none', 'info', 'warning', 'critical')) DEFAULT 'warning',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS target_group_bindings (
      target_id TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL,
      bound_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES target_groups(id) ON DELETE RESTRICT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fence_time_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_id INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('all_day', 'time_range', 'weekday_time')),
      start_time TEXT,
      end_time TEXT,
      weekdays TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE,
      UNIQUE(fence_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fence_alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      enter_level TEXT NOT NULL CHECK(enter_level IN ('none', 'info', 'warning', 'critical')) DEFAULT 'warning',
      leave_level TEXT NOT NULL CHECK(leave_level IN ('none', 'info', 'warning', 'critical')) DEFAULT 'warning',
      message_template TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fence_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_id INTEGER NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('webhook', 'speed_limit', 'fence_activate')),
      trigger_condition TEXT NOT NULL CHECK(trigger_condition IN ('enter', 'leave', 'both')),
      target_group_id TEXT,
      action_config TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fence_activation_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_id INTEGER NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      source_fence_id INTEGER,
      target_id TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE,
      FOREIGN KEY (source_fence_id) REFERENCES fences(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_target ON alerts(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_fence ON alerts(fence_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_group ON alerts(group_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bindings_group ON target_group_bindings(group_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rules_fence ON fence_alert_rules(fence_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_fence ON fence_actions(fence_id)`);
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

const AlertModel = {
  async create({ target_id, target_name, fence_id, fence_name, event_type, level, lng, lat, rule_id, group_id, group_name, custom_message }) {
    const result = await run(
      'INSERT INTO alerts (target_id, target_name, fence_id, fence_name, event_type, level, lng, lat, rule_id, group_id, group_name, custom_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [target_id, target_name, fence_id, fence_name, event_type, level, lng, lat, rule_id, group_id, group_name, custom_message]
    );
    return this.getById(result.lastID);
  },
  async getById(id) {
    return get('SELECT * FROM alerts WHERE id = ?', [id]);
  },
  async query({ target_id, fence_id, start_time, end_time, level, limit = 100, offset = 0, group_id } = {}) {
    let sql = 'SELECT * FROM alerts WHERE 1=1';
    const params = [];
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (fence_id !== undefined) { sql += ' AND fence_id = ?'; params.push(fence_id); }
    if (level) { sql += ' AND level = ?'; params.push(level); }
    if (group_id !== undefined) { sql += ' AND group_id = ?'; params.push(group_id); }
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
  },
  async getTodayGroupStats(groupId) {
    const rows = await all(`
      SELECT level, COUNT(*) as count FROM alerts 
      WHERE DATE(timestamp) = DATE('now') AND group_id = ?
      GROUP BY level
    `, [groupId]);
    return rows.reduce((acc, row) => {
      acc[row.level] = row.count;
      return acc;
    }, { none: 0, info: 0, warning: 0, critical: 0 });
  },
  async getGroupFenceStats(groupId, limit = 3) {
    const rows = await all(`
      SELECT fence_id, fence_name, event_type, COUNT(*) as count FROM alerts 
      WHERE DATE(timestamp) = DATE('now') AND group_id = ?
      GROUP BY fence_id, event_type
      ORDER BY count DESC
      LIMIT ?
    `, [groupId, limit * 2]);
    const fenceMap = new Map();
    rows.forEach(row => {
      if (!fenceMap.has(row.fence_id)) {
        fenceMap.set(row.fence_id, { fence_id: row.fence_id, fence_name: row.fence_name, enter_count: 0, leave_count: 0, total: 0 });
      }
      const f = fenceMap.get(row.fence_id);
      if (row.event_type === 'enter') f.enter_count = row.count;
      else f.leave_count = row.count;
      f.total += row.count;
    });
    return Array.from(fenceMap.values()).sort((a, b) => b.total - a.total).slice(0, limit);
  }
};

const TargetGroupModel = {
  async getAll() {
    return all('SELECT * FROM target_groups ORDER BY created_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM target_groups WHERE id = ?', [id]);
  },
  async getByName(name) {
    return get('SELECT * FROM target_groups WHERE name = ?', [name]);
  },
  async create({ name, color, description, default_level }) {
    const result = await run(
      'INSERT INTO target_groups (name, color, description, default_level) VALUES (?, ?, ?, ?)',
      [name, color, description || '', default_level || 'warning']
    );
    return this.getById(result.lastID);
  },
  async update(id, { name, color, description, default_level }) {
    const existing = await this.getById(id);
    if (!existing) return null;
    await run(
      'UPDATE target_groups SET name = ?, color = ?, description = ?, default_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name || existing.name, color || existing.color, description !== undefined ? description : existing.description, default_level || existing.default_level, id]
    );
    return this.getById(id);
  },
  async delete(id) {
    const bindingCount = await get('SELECT COUNT(*) as count FROM target_group_bindings WHERE group_id = ?', [id]);
    if (bindingCount && bindingCount.count > 0) {
      throw new Error('分组下存在绑定目标，无法删除');
    }
    await run('DELETE FROM target_groups WHERE id = ?', [id]);
    return true;
  }
};

const TargetBindingModel = {
  async getBinding(targetId) {
    const row = await get(`
      SELECT tgb.*, tg.name as group_name, tg.color as group_color, tg.default_level 
      FROM target_group_bindings tgb 
      LEFT JOIN target_groups tg ON tgb.group_id = tg.id 
      WHERE tgb.target_id = ?
    `, [targetId]);
    return row || null;
  },
  async getAllBindings() {
    return all(`
      SELECT tgb.*, tg.name as group_name, tg.color as group_color, tg.default_level 
      FROM target_group_bindings tgb 
      LEFT JOIN target_groups tg ON tgb.group_id = tg.id
    `);
  },
  async bind(targetId, groupId) {
    await run(
      'INSERT OR REPLACE INTO target_group_bindings (target_id, group_id, bound_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [targetId, groupId]
    );
    return this.getBinding(targetId);
  },
  async unbind(targetId) {
    await run('DELETE FROM target_group_bindings WHERE target_id = ?', [targetId]);
    return true;
  },
  async getGroupTargets(groupId) {
    return all('SELECT * FROM target_group_bindings WHERE group_id = ?', [groupId]);
  }
};

const FenceTimeWindowModel = {
  async getByFenceId(fenceId) {
    const row = await get('SELECT * FROM fence_time_windows WHERE fence_id = ?', [fenceId]);
    if (!row) return null;
    return {
      ...row,
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null
    };
  },
  async getAll() {
    const rows = await all('SELECT * FROM fence_time_windows');
    return rows.map(row => ({
      ...row,
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null
    }));
  },
  async set(fenceId, { mode, start_time, end_time, weekdays }) {
    const existing = await this.getByFenceId(fenceId);
    if (existing) {
      await run(
        'UPDATE fence_time_windows SET mode = ?, start_time = ?, end_time = ?, weekdays = ? WHERE fence_id = ?',
        [mode, start_time || null, end_time || null, weekdays ? JSON.stringify(weekdays) : null, fenceId]
      );
    } else {
      await run(
        'INSERT INTO fence_time_windows (fence_id, mode, start_time, end_time, weekdays) VALUES (?, ?, ?, ?, ?)',
        [fenceId, mode, start_time || null, end_time || null, weekdays ? JSON.stringify(weekdays) : null]
      );
    }
    return this.getByFenceId(fenceId);
  },
  async delete(fenceId) {
    await run('DELETE FROM fence_time_windows WHERE fence_id = ?', [fenceId]);
    return true;
  }
};

const FenceAlertRuleModel = {
  async getByFenceId(fenceId) {
    return all('SELECT * FROM fence_alert_rules WHERE fence_id = ? ORDER BY id', [fenceId]);
  },
  async getById(id) {
    return get('SELECT * FROM fence_alert_rules WHERE id = ?', [id]);
  },
  async create({ fence_id, group_id, enter_level, leave_level, message_template }) {
    const result = await run(
      'INSERT INTO fence_alert_rules (fence_id, group_id, enter_level, leave_level, message_template) VALUES (?, ?, ?, ?, ?)',
      [fence_id, group_id, enter_level || 'warning', leave_level || 'warning', message_template || null]
    );
    return this.getById(result.lastID);
  },
  async update(id, { enter_level, leave_level, message_template }) {
    const existing = await this.getById(id);
    if (!existing) return null;
    await run(
      'UPDATE fence_alert_rules SET enter_level = ?, leave_level = ?, message_template = ? WHERE id = ?',
      [enter_level || existing.enter_level, leave_level || existing.leave_level, message_template !== undefined ? message_template : existing.message_template, id]
    );
    return this.getById(id);
  },
  async delete(id) {
    await run('DELETE FROM fence_alert_rules WHERE id = ?', [id]);
    return true;
  },
  async deleteByFenceId(fenceId) {
    await run('DELETE FROM fence_alert_rules WHERE fence_id = ?', [fenceId]);
    return true;
  }
};

const FenceActionModel = {
  async getByFenceId(fenceId) {
    const rows = await all('SELECT * FROM fence_actions WHERE fence_id = ? ORDER BY id', [fenceId]);
    return rows.map(row => ({
      ...row,
      action_config: JSON.parse(row.action_config)
    }));
  },
  async getById(id) {
    const row = await get('SELECT * FROM fence_actions WHERE id = ?', [id]);
    if (!row) return null;
    return { ...row, action_config: JSON.parse(row.action_config) };
  },
  async getAll() {
    const rows = await all('SELECT * FROM fence_actions ORDER BY id');
    return rows.map(row => ({
      ...row,
      action_config: JSON.parse(row.action_config)
    }));
  },
  async create({ fence_id, action_type, trigger_condition, target_group_id, action_config }) {
    const result = await run(
      'INSERT INTO fence_actions (fence_id, action_type, trigger_condition, target_group_id, action_config) VALUES (?, ?, ?, ?, ?)',
      [fence_id, action_type, trigger_condition, target_group_id || null, JSON.stringify(action_config)]
    );
    return this.getById(result.lastID);
  },
  async update(id, { trigger_condition, target_group_id, action_config }) {
    const existing = await this.getById(id);
    if (!existing) return null;
    await run(
      'UPDATE fence_actions SET trigger_condition = ?, target_group_id = ?, action_config = ? WHERE id = ?',
      [trigger_condition || existing.trigger_condition, target_group_id !== undefined ? target_group_id : existing.target_group_id, action_config ? JSON.stringify(action_config) : JSON.stringify(existing.action_config), id]
    );
    return this.getById(id);
  },
  async delete(id) {
    await run('DELETE FROM fence_actions WHERE id = ?', [id]);
    return true;
  },
  async deleteByFenceId(fenceId) {
    await run('DELETE FROM fence_actions WHERE fence_id = ?', [fenceId]);
    return true;
  }
};

const FenceActivationOverrideModel = {
  async getByFenceId(fenceId) {
    return get('SELECT * FROM fence_activation_overrides WHERE fence_id = ?', [fenceId]);
  },
  async getAll() {
    return all('SELECT * FROM fence_activation_overrides');
  },
  async setOverride(fenceId, isActive, sourceFenceId = null, targetId = null, expiresAt = null) {
    const existing = await this.getByFenceId(fenceId);
    if (existing) {
      await run(
        'UPDATE fence_activation_overrides SET is_active = ?, source_fence_id = ?, target_id = ?, expires_at = ?, created_at = CURRENT_TIMESTAMP WHERE fence_id = ?',
        [isActive ? 1 : 0, sourceFenceId, targetId, expiresAt, fenceId]
      );
    } else {
      await run(
        'INSERT INTO fence_activation_overrides (fence_id, is_active, source_fence_id, target_id, expires_at) VALUES (?, ?, ?, ?, ?)',
        [fenceId, isActive ? 1 : 0, sourceFenceId, targetId, expiresAt]
      );
    }
    return this.getByFenceId(fenceId);
  },
  async clearOverride(fenceId) {
    await run('DELETE FROM fence_activation_overrides WHERE fence_id = ?', [fenceId]);
    return true;
  },
  async clearBySourceAndTarget(sourceFenceId, targetId) {
    await run('DELETE FROM fence_activation_overrides WHERE source_fence_id = ? AND target_id = ?', [sourceFenceId, targetId]);
    return true;
  }
};

module.exports = {
  db,
  FenceModel,
  AlertModel,
  POIModel,
  TargetGroupModel,
  TargetBindingModel,
  FenceTimeWindowModel,
  FenceAlertRuleModel,
  FenceActionModel,
  FenceActivationOverrideModel
};
