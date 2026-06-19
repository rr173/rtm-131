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
  
  db.run(`
    CREATE TABLE IF NOT EXISTS trajectory_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      target_name TEXT,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      group_id INTEGER,
      group_name TEXT,
      bearing REAL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trajectory_target ON trajectory_points(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trajectory_timestamp ON trajectory_points(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trajectory_target_time ON trajectory_points(target_id, timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trajectory_group ON trajectory_points(group_id)`);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS heatmap_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_time INTEGER NOT NULL,
      grid_lng_count INTEGER NOT NULL DEFAULT 50,
      grid_lat_count INTEGER NOT NULL DEFAULT 35,
      lng_min REAL NOT NULL,
      lng_max REAL NOT NULL,
      lat_min REAL NOT NULL,
      lat_max REAL NOT NULL,
      grid_data TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_heatmap_time ON heatmap_snapshots(snapshot_time)`);
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

const TrajectoryModel = {
  async addPoint({ target_id, target_name, lng, lat, timestamp, group_id, group_name, bearing }) {
    const result = await run(
      'INSERT INTO trajectory_points (target_id, target_name, lng, lat, timestamp, group_id, group_name, bearing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [target_id, target_name || null, lng, lat, timestamp, group_id || null, group_name || null, bearing || null]
    );
    return result.lastID;
  },
  async batchAddPoints(points) {
    if (!points || points.length === 0) return 0;
    const stmt = db.prepare('INSERT INTO trajectory_points (target_id, target_name, lng, lat, timestamp, group_id, group_name, bearing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        let count = 0;
        points.forEach(p => {
          stmt.run(p.target_id, p.target_name || null, p.lng, p.lat, p.timestamp, p.group_id || null, p.group_name || null, p.bearing || null, function(err) {
            if (err) {
              db.run('ROLLBACK');
              reject(err);
            }
            count++;
          });
        });
        db.run('COMMIT', (err) => {
          if (err) reject(err);
          else resolve(count);
        });
      });
    });
  },
  async query({ target_id, start_time, end_time, group_id, interval = 0, limit = 10000 }) {
    let sql = 'SELECT * FROM trajectory_points WHERE 1=1';
    const params = [];
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (group_id !== undefined && group_id !== null) { sql += ' AND group_id = ?'; params.push(group_id); }
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    
    if (interval && interval > 0) {
      sql = `
        SELECT tp.* 
        FROM trajectory_points tp
        INNER JOIN (
          SELECT MIN(id) as min_id
          FROM trajectory_points
          WHERE 1=1
          ${target_id ? 'AND target_id = ?' : ''}
          ${group_id !== undefined && group_id !== null ? 'AND group_id = ?' : ''}
          ${start_time ? 'AND timestamp >= ?' : ''}
          ${end_time ? 'AND timestamp <= ?' : ''}
          GROUP BY (timestamp / ?)
        ) grouped ON tp.id = grouped.min_id
        ORDER BY tp.timestamp ASC
        LIMIT ?
      `;
      const newParams = [];
      if (target_id) newParams.push(target_id);
      if (group_id !== undefined && group_id !== null) newParams.push(group_id);
      if (start_time) newParams.push(start_time);
      if (end_time) newParams.push(end_time);
      newParams.push(interval * 1000);
      newParams.push(limit);
      return all(sql, newParams);
    }
    
    sql += ' ORDER BY timestamp ASC LIMIT ?';
    params.push(limit);
    return all(sql, params);
  },
  async getStays({ target_id, start_time, end_time, stay_radius = 0.0005, min_duration = 60000 }) {
    const points = await this.query({ target_id, start_time, end_time, limit: 100000 });
    if (points.length < 2) return [];
    
    const stays = [];
    let i = 0;
    while (i < points.length) {
      const startPoint = points[i];
      let j = i + 1;
      let maxDist = 0;
      let centerLng = startPoint.lng;
      let centerLat = startPoint.lat;
      
      while (j < points.length) {
        const curr = points[j];
        const dist = Math.sqrt(
          Math.pow(curr.lng - startPoint.lng, 2) + 
          Math.pow(curr.lat - startPoint.lat, 2)
        );
        if (dist > stay_radius) {
          break;
        }
        const total = j - i + 1;
        centerLng = ((centerLng * (total - 1)) + curr.lng) / total;
        centerLat = ((centerLat * (total - 1)) + curr.lat) / total;
        maxDist = Math.max(maxDist, dist);
        j++;
      }
      
      const duration = points[j - 1].timestamp - startPoint.timestamp;
      if (duration >= min_duration) {
        stays.push({
          center_lng: centerLng,
          center_lat: centerLat,
          start_time: startPoint.timestamp,
          end_time: points[j - 1].timestamp,
          duration_seconds: Math.round(duration / 1000),
          point_count: j - i
        });
        i = j;
      } else {
        i++;
      }
    }
    return stays;
  },
  async getFenceEventRanking({ start_time, end_time, group_id, event_type, limit = 20 } = {}) {
    let sql = `
      SELECT 
        fence_id, 
        fence_name,
        SUM(CASE WHEN event_type = 'enter' THEN 1 ELSE 0 END) as enter_count,
        SUM(CASE WHEN event_type = 'leave' THEN 1 ELSE 0 END) as leave_count,
        COUNT(*) as total_events
      FROM alerts
      WHERE 1=1
    `;
    const params = [];
    if (start_time) {
      const startStr = typeof start_time === 'number'
        ? new Date(start_time).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
        : start_time;
      sql += ' AND timestamp >= ?'; params.push(startStr);
    }
    if (end_time) {
      const endStr = typeof end_time === 'number'
        ? new Date(end_time).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
        : end_time;
      sql += ' AND timestamp <= ?'; params.push(endStr);
    }
    if (group_id !== undefined && group_id !== null) { sql += ' AND group_id = ?'; params.push(group_id); }
    if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
    
    sql += ' GROUP BY fence_id, fence_name ORDER BY total_events DESC LIMIT ?';
    params.push(limit);
    return all(sql, params);
  }
};

const HeatmapModel = {
  async saveSnapshot({ snapshot_time, grid_lng_count, grid_lat_count, lng_min, lng_max, lat_min, lat_max, grid_data }) {
    const result = await run(
      'INSERT INTO heatmap_snapshots (snapshot_time, grid_lng_count, grid_lat_count, lng_min, lng_max, lat_min, lat_max, grid_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [snapshot_time, grid_lng_count, grid_lat_count, lng_min, lng_max, lat_min, lat_max, JSON.stringify(grid_data)]
    );
    return result.lastID;
  },
  async getLatest() {
    const row = await get('SELECT * FROM heatmap_snapshots ORDER BY snapshot_time DESC LIMIT 1');
    if (!row) return null;
    return {
      ...row,
      grid_data: JSON.parse(row.grid_data)
    };
  },
  async getByTime(timestamp) {
    const row = await get(
      'SELECT * FROM heatmap_snapshots WHERE snapshot_time <= ? ORDER BY snapshot_time DESC LIMIT 1',
      [timestamp]
    );
    if (!row) return null;
    return {
      ...row,
      grid_data: JSON.parse(row.grid_data)
    };
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
  FenceActivationOverrideModel,
  TrajectoryModel,
  HeatmapModel
};
