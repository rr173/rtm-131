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

  db.run(`
    CREATE TABLE IF NOT EXISTS duty_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      officer_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      fence_ids TEXT NOT NULL,
      time_slots TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_duty_priority ON duty_schedules(priority)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      fence_id INTEGER NOT NULL,
      fence_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      alert_timestamp INTEGER NOT NULL,
      assigned_officer TEXT,
      assigned_contact TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority_level INTEGER NOT NULL DEFAULT 0,
      escalation_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at INTEGER NOT NULL,
      last_assigned_at INTEGER NOT NULL,
      claimed_at INTEGER,
      processing_at INTEGER,
      resolved_at INTEGER,
      closed_at INTEGER,
      resolution_note TEXT,
      FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wo_officer ON work_orders(assigned_officer)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wo_fence ON work_orders(fence_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wo_created ON work_orders(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wo_alert ON work_orders(alert_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS work_order_escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      from_officer TEXT,
      to_officer TEXT,
      to_contact TEXT,
      escalation_time INTEGER NOT NULL,
      reason TEXT,
      FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_escalation_wo ON work_order_escalations(work_order_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS patrol_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT,
      frequency TEXT NOT NULL CHECK(frequency IN ('once', 'daily', 'weekly')) DEFAULT 'once',
      planned_start_time INTEGER NOT NULL,
      deadline_time INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'completed', 'overdue', 'cancelled')) DEFAULT 'pending',
      actual_start_time INTEGER,
      completed_time INTEGER,
      current_waypoint_index INTEGER NOT NULL DEFAULT 0,
      parent_task_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (parent_task_id) REFERENCES patrol_tasks(id) ON DELETE SET NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_patrol_status ON patrol_tasks(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_patrol_target ON patrol_tasks(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_patrol_start ON patrol_tasks(planned_start_time)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS patrol_waypoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      fence_id INTEGER NOT NULL,
      fence_name TEXT NOT NULL,
      sequence_index INTEGER NOT NULL,
      centroid_lng REAL NOT NULL,
      centroid_lat REAL NOT NULL,
      arrived_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES patrol_tasks(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_patrol_wp_task ON patrol_waypoints(task_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_patrol_wp_fence ON patrol_waypoints(fence_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS target_behavior_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      target_name TEXT,
      profile_date TEXT NOT NULL,
      common_routes TEXT NOT NULL,
      common_stay_areas TEXT NOT NULL,
      active_hours TEXT NOT NULL,
      total_points INTEGER NOT NULL DEFAULT 0,
      data_start_time INTEGER NOT NULL,
      data_end_time INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(target_id, profile_date)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_profile_target ON target_behavior_profiles(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_profile_date ON target_behavior_profiles(profile_date)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS behavior_anomaly_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      target_name TEXT,
      anomaly_type TEXT NOT NULL CHECK(anomaly_type IN ('route_deviation', 'area_anomaly', 'time_anomaly')),
      description TEXT NOT NULL,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      details TEXT,
      group_id INTEGER,
      group_name TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_anomaly_target ON behavior_anomaly_events(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_anomaly_type ON behavior_anomaly_events(anomaly_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_anomaly_timestamp ON behavior_anomaly_events(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_anomaly_target_type ON behavior_anomaly_events(target_id, anomaly_type)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS offline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      target_name TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('offline', 'recover')),
      offline_start_at INTEGER NOT NULL,
      offline_end_at INTEGER,
      offline_duration_ms INTEGER,
      last_lng REAL,
      last_lat REAL,
      recover_lng REAL,
      recover_lat REAL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offline_events_target ON offline_events(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offline_events_type ON offline_events(event_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offline_events_start ON offline_events(offline_start_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offline_events_target_time ON offline_events(target_id, offline_start_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS formations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      radius_threshold REAL NOT NULL DEFAULT 0.01,
      status TEXT NOT NULL CHECK(status IN ('inactive', 'monitoring', 'dissolved')) DEFAULT 'inactive',
      route_fence_ids TEXT,
      route_progress TEXT,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      dissolved_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_formations_status ON formations(status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS formation_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formation_id INTEGER NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT,
      joined_at INTEGER NOT NULL,
      FOREIGN KEY (formation_id) REFERENCES formations(id) ON DELETE CASCADE,
      UNIQUE(target_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fm_formation ON formation_members(formation_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fm_target ON formation_members(target_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS formation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formation_id INTEGER NOT NULL,
      formation_name TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('detached', 'returned')),
      center_lng REAL NOT NULL,
      center_lat REAL NOT NULL,
      member_lng REAL NOT NULL,
      member_lat REAL NOT NULL,
      deviation REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fe_formation ON formation_events(formation_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fe_target ON formation_events(target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fe_type ON formation_events(event_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fe_timestamp ON formation_events(timestamp)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS target_offline_stats (
      target_id TEXT PRIMARY KEY,
      total_offline_count INTEGER NOT NULL DEFAULT 0,
      total_offline_ms INTEGER NOT NULL DEFAULT 0,
      longest_single_offline_ms INTEGER NOT NULL DEFAULT 0,
      latest_offline_start_at INTEGER,
      latest_offline_end_at INTEGER,
      latest_offline_duration_ms INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS fence_capacity_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_id INTEGER NOT NULL UNIQUE,
      max_capacity INTEGER NOT NULL,
      warning_threshold_pct REAL NOT NULL DEFAULT 80.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS capacity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fence_id INTEGER NOT NULL,
      fence_name TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('capacity_warning', 'capacity_full', 'capacity_normal', 'capacity_overlimit')),
      old_status TEXT,
      new_status TEXT NOT NULL,
      current_count INTEGER NOT NULL,
      max_capacity INTEGER NOT NULL,
      target_id TEXT,
      target_name TEXT,
      timestamp INTEGER NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (fence_id) REFERENCES fences(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cap_cfg_fence ON fence_capacity_config(fence_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cap_evt_fence ON capacity_events(fence_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cap_evt_type ON capacity_events(event_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cap_evt_time ON capacity_events(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cap_evt_fence_time ON capacity_events(fence_id, timestamp)`);
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

const DutyScheduleModel = {
  async getAll() {
    const rows = await all('SELECT * FROM duty_schedules ORDER BY priority DESC, id ASC');
    return rows.map(row => ({
      ...row,
      fence_ids: JSON.parse(row.fence_ids),
      time_slots: JSON.parse(row.time_slots)
    }));
  },
  async getById(id) {
    const row = await get('SELECT * FROM duty_schedules WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      fence_ids: JSON.parse(row.fence_ids),
      time_slots: JSON.parse(row.time_slots)
    };
  },
  async create({ officer_name, contact, fence_ids, time_slots, priority }) {
    const result = await run(
      'INSERT INTO duty_schedules (officer_name, contact, fence_ids, time_slots, priority) VALUES (?, ?, ?, ?, ?)',
      [officer_name, contact, JSON.stringify(fence_ids), JSON.stringify(time_slots), priority || 1]
    );
    return this.getById(result.lastID);
  },
  async update(id, { officer_name, contact, fence_ids, time_slots, priority }) {
    const existing = await this.getById(id);
    if (!existing) return null;
    await run(
      'UPDATE duty_schedules SET officer_name = ?, contact = ?, fence_ids = ?, time_slots = ?, priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        officer_name || existing.officer_name,
        contact || existing.contact,
        fence_ids ? JSON.stringify(fence_ids) : JSON.stringify(existing.fence_ids),
        time_slots ? JSON.stringify(time_slots) : JSON.stringify(existing.time_slots),
        priority !== undefined ? priority : existing.priority,
        id
      ]
    );
    return this.getById(id);
  },
  async delete(id) {
    await run('DELETE FROM duty_schedules WHERE id = ?', [id]);
    return true;
  },
  async getByFenceIdsAndTime(fenceIds, now = new Date()) {
    const allSchedules = await this.getAll();
    const weekday = now.getDay();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const currentMinutes = parseInt(currentTime.split(':')[0]) * 60 + parseInt(currentTime.split(':')[1]);

    const matched = [];
    for (const schedule of allSchedules) {
      const hasFence = fenceIds.some(fid => schedule.fence_ids.includes(fid));
      if (!hasFence) continue;

      let timeMatched = false;
      for (const slot of schedule.time_slots) {
        if (!slot.weekdays.includes(weekday)) continue;
        const [startH, startM] = slot.start_time.split(':').map(Number);
        const [endH, endM] = slot.end_time.split(':').map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        if (startMinutes <= endMinutes) {
          if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) {
            timeMatched = true;
            break;
          }
        } else {
          if (currentMinutes >= startMinutes || currentMinutes <= endMinutes) {
            timeMatched = true;
            break;
          }
        }
      }
      if (timeMatched) {
        matched.push(schedule);
      }
    }
    return matched.sort((a, b) => b.priority - a.priority);
  }
};

const WorkOrderEscalationModel = {
  async create({ work_order_id, from_officer, to_officer, to_contact, escalation_time, reason }) {
    const result = await run(
      'INSERT INTO work_order_escalations (work_order_id, from_officer, to_officer, to_contact, escalation_time, reason) VALUES (?, ?, ?, ?, ?, ?)',
      [work_order_id, from_officer || null, to_officer || null, to_contact || null, escalation_time, reason || null]
    );
    return this.getById(result.lastID);
  },
  async getById(id) {
    return get('SELECT * FROM work_order_escalations WHERE id = ?', [id]);
  },
  async getByWorkOrderId(workOrderId) {
    return all('SELECT * FROM work_order_escalations WHERE work_order_id = ? ORDER BY escalation_time ASC', [workOrderId]);
  }
};

const WorkOrderModel = {
  async create(data) {
    const result = await run(
      `INSERT INTO work_orders (
        alert_id, target_id, target_name, fence_id, fence_name, event_type, level,
        lng, lat, alert_timestamp, assigned_officer, assigned_contact, status,
        priority_level, escalation_count, note, created_at, last_assigned_at,
        claimed_at, processing_at, resolved_at, closed_at, resolution_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.alert_id, data.target_id, data.target_name, data.fence_id, data.fence_name,
        data.event_type, data.level, data.lng, data.lat, data.alert_timestamp,
        data.assigned_officer || null, data.assigned_contact || null,
        data.status || 'pending', data.priority_level || 0, data.escalation_count || 0,
        data.note || null,
        data.created_at || Date.now(),
        data.last_assigned_at || data.created_at || Date.now(),
        data.claimed_at || null,
        data.processing_at || null,
        data.resolved_at || null,
        data.closed_at || null,
        data.resolution_note || null
      ]
    );
    return this.getById(result.lastID);
  },
  async getById(id) {
    return get('SELECT * FROM work_orders WHERE id = ?', [id]);
  },
  async update(id, fields) {
    const existing = await this.getById(id);
    if (!existing) return null;
    const keys = Object.keys(fields);
    if (keys.length === 0) return existing;
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => fields[k]);
    values.push(id);
    await run(`UPDATE work_orders SET ${setClause} WHERE id = ?`, values);
    return this.getById(id);
  },
  async query({ officer, fence_id, status, start_time, end_time, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM work_orders WHERE 1=1';
    const params = [];
    if (officer) { sql += ' AND assigned_officer = ?'; params.push(officer); }
    if (fence_id !== undefined) { sql += ' AND fence_id = ?'; params.push(fence_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (start_time) { sql += ' AND created_at >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND created_at <= ?'; params.push(end_time); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return all(sql, params);
  },
  async count() {
    const row = await get('SELECT COUNT(*) as count FROM work_orders');
    return row ? row.count : 0;
  },
  async getPendingOlderThan(ms) {
    const threshold = Date.now() - ms;
    return all(
      `SELECT * FROM work_orders 
       WHERE status IN ('pending', 'escalated') 
       AND escalation_count < 3
       AND COALESCE(last_assigned_at, created_at) <= ?
       ORDER BY created_at ASC`,
      [threshold]
    );
  },
  async getByAlertId(alertId) {
    return get('SELECT * FROM work_orders WHERE alert_id = ?', [alertId]);
  },
  async getOfficerStats(startTime, endTime) {
    let baseSql = `
      SELECT 
        assigned_officer,
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_orders,
        SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END) as claimed_orders
      FROM work_orders
      WHERE assigned_officer IS NOT NULL
    `;
    const params = [];
    if (startTime) { baseSql += ' AND created_at >= ?'; params.push(startTime); }
    if (endTime) { baseSql += ' AND created_at <= ?'; params.push(endTime); }
    baseSql += ' GROUP BY assigned_officer';
    const baseStats = await all(baseSql, params);

    let detailedSql = `
      SELECT 
        assigned_officer,
        AVG(claimed_at - created_at) as avg_response_ms,
        AVG(CASE WHEN resolved_at IS NOT NULL AND claimed_at IS NOT NULL THEN resolved_at - claimed_at END) as avg_process_ms,
        SUM(CASE WHEN escalation_count > 0 THEN 1 ELSE 0 END) as escalated_orders
      FROM work_orders
      WHERE assigned_officer IS NOT NULL
    `;
    const detailedParams = [];
    if (startTime) { detailedSql += ' AND created_at >= ?'; detailedParams.push(startTime); }
    if (endTime) { detailedSql += ' AND created_at <= ?'; detailedParams.push(endTime); }
    detailedSql += ' GROUP BY assigned_officer';
    const detailedStats = await all(detailedSql, detailedParams);

    const detailedMap = new Map();
    detailedStats.forEach(d => detailedMap.set(d.assigned_officer, d));

    return baseStats.map(b => {
      const d = detailedMap.get(b.assigned_officer) || {};
      const total = b.total_orders || 0;
      return {
        officer_name: b.assigned_officer,
        total_orders: total,
        resolved_orders: b.resolved_orders || 0,
        claimed_orders: b.claimed_orders || 0,
        avg_response_seconds: d.avg_response_ms ? Math.round(d.avg_response_ms / 1000) : 0,
        avg_process_seconds: d.avg_process_ms ? Math.round(d.avg_process_ms / 1000) : 0,
        escalation_rate: total > 0 ? Math.round(((d.escalated_orders || 0) / total) * 100) / 100 : 0
      };
    });
  }
};

const PatrolTaskModel = {
  async create({ task_name, target_id, target_name, frequency, planned_start_time, deadline_time, waypoints, parent_task_id }) {
    const now = Date.now();
    const result = await run(
      `INSERT INTO patrol_tasks (
        task_name, target_id, target_name, frequency, planned_start_time, deadline_time,
        status, current_waypoint_index, parent_task_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [task_name, target_id, target_name || null, frequency || 'once', planned_start_time, deadline_time,
       parent_task_id || null, now, now]
    );
    const taskId = result.lastID;
    
    if (waypoints && waypoints.length > 0) {
      for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        await run(
          `INSERT INTO patrol_waypoints (task_id, fence_id, fence_name, sequence_index, centroid_lng, centroid_lat)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [taskId, wp.fence_id, wp.fence_name, i, wp.centroid_lng, wp.centroid_lat]
        );
      }
    }
    
    return this.getById(taskId);
  },
  
  async getById(id) {
    const row = await get('SELECT * FROM patrol_tasks WHERE id = ?', [id]);
    if (!row) return null;
    const waypoints = await all(
      'SELECT * FROM patrol_waypoints WHERE task_id = ? ORDER BY sequence_index ASC',
      [id]
    );
    return { ...row, waypoints };
  },
  
  async update(id, fields) {
    const existing = await this.getById(id);
    if (!existing) return null;
    const keys = Object.keys(fields);
    if (keys.length === 0) return existing;
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => fields[k]);
    values.push(Date.now());
    values.push(id);
    await run(`UPDATE patrol_tasks SET ${setClause}, updated_at = ? WHERE id = ?`, values);
    return this.getById(id);
  },
  
  async query({ target_id, status, start_time, end_time, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM patrol_tasks WHERE 1=1';
    const params = [];
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (start_time) { sql += ' AND planned_start_time >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND planned_start_time <= ?'; params.push(end_time); }
    sql += ' ORDER BY planned_start_time DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = await all(sql, params);
    const tasks = [];
    for (const row of rows) {
      const waypoints = await all(
        'SELECT * FROM patrol_waypoints WHERE task_id = ? ORDER BY sequence_index ASC',
        [row.id]
      );
      tasks.push({ ...row, waypoints });
    }
    return tasks;
  },
  
  async getPendingToActivate(now = Date.now()) {
    const rows = await all(
      `SELECT * FROM patrol_tasks 
       WHERE status = 'pending' AND planned_start_time <= ?
       ORDER BY planned_start_time ASC`,
      [now]
    );
    const tasks = [];
    for (const row of rows) {
      const waypoints = await all(
        'SELECT * FROM patrol_waypoints WHERE task_id = ? ORDER BY sequence_index ASC',
        [row.id]
      );
      tasks.push({ ...row, waypoints });
    }
    return tasks;
  },
  
  async getActiveTasks() {
    const rows = await all(
      `SELECT * FROM patrol_tasks WHERE status = 'active' ORDER BY actual_start_time ASC`
    );
    const tasks = [];
    for (const row of rows) {
      const waypoints = await all(
        'SELECT * FROM patrol_waypoints WHERE task_id = ? ORDER BY sequence_index ASC',
        [row.id]
      );
      tasks.push({ ...row, waypoints });
    }
    return tasks;
  },
  
  async getOverdueTasks(now = Date.now()) {
    const rows = await all(
      `SELECT * FROM patrol_tasks 
       WHERE status = 'active' AND deadline_time <= ?
       ORDER BY deadline_time ASC`,
      [now]
    );
    const tasks = [];
    for (const row of rows) {
      const waypoints = await all(
        'SELECT * FROM patrol_waypoints WHERE task_id = ? ORDER BY sequence_index ASC',
        [row.id]
      );
      tasks.push({ ...row, waypoints });
    }
    return tasks;
  },
  
  async markWaypointArrived(taskId, waypointIndex, arrivedAt = Date.now()) {
    await run(
      `UPDATE patrol_waypoints SET arrived_at = ? 
       WHERE task_id = ? AND sequence_index = ?`,
      [arrivedAt, taskId, waypointIndex]
    );
  },
  
  async getTargetStats(startTime, endTime) {
    let sql = `
      SELECT 
        target_id,
        target_name,
        COUNT(*) as total_tasks,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_tasks,
        AVG(CASE WHEN status = 'completed' AND completed_time IS NOT NULL AND actual_start_time IS NOT NULL 
                 THEN completed_time - actual_start_time ELSE NULL END) as avg_duration_ms
      FROM patrol_tasks
      WHERE status IN ('completed', 'overdue')
    `;
    const params = [];
    if (startTime) { sql += ' AND created_at >= ?'; params.push(startTime); }
    if (endTime) { sql += ' AND created_at <= ?'; params.push(endTime); }
    sql += ' GROUP BY target_id, target_name';
    
    const rows = await all(sql, params);
    return rows.map(row => ({
      target_id: row.target_id,
      target_name: row.target_name,
      total_tasks: row.total_tasks,
      completed_tasks: row.completed_tasks,
      overdue_tasks: row.overdue_tasks,
      completion_rate: row.total_tasks > 0 ? row.completed_tasks / row.total_tasks : 0,
      overdue_rate: row.total_tasks > 0 ? row.overdue_tasks / row.total_tasks : 0,
      avg_duration_seconds: row.avg_duration_ms ? Math.round(row.avg_duration_ms / 1000) : 0
    }));
  },
  
  async getFenceCoverageStats(startTime, endTime) {
    let sql = `
      SELECT 
        pw.fence_id,
        pw.fence_name,
        COUNT(DISTINCT pt.id) as task_count,
        SUM(CASE WHEN pw.arrived_at IS NOT NULL THEN 1 ELSE 0 END) as visited_count
      FROM patrol_waypoints pw
      INNER JOIN patrol_tasks pt ON pw.task_id = pt.id
      WHERE pt.status IN ('completed', 'overdue', 'active')
    `;
    const params = [];
    if (startTime) { sql += ' AND pt.created_at >= ?'; params.push(startTime); }
    if (endTime) { sql += ' AND pt.created_at <= ?'; params.push(endTime); }
    sql += ' GROUP BY pw.fence_id, pw.fence_name ORDER BY task_count DESC';
    
    return all(sql, params);
  },
  
  async count() {
    const row = await get('SELECT COUNT(*) as count FROM patrol_tasks');
    return row ? row.count : 0;
  }
};

const BehaviorProfileModel = {
  async upsert({ target_id, target_name, profile_date, common_routes, common_stay_areas, active_hours, total_points, data_start_time, data_end_time }) {
    const now = Date.now();
    const existing = await this.getByTargetAndDate(target_id, profile_date);
    if (existing) {
      await run(
        `UPDATE target_behavior_profiles SET 
          target_name = ?, common_routes = ?, common_stay_areas = ?, 
          active_hours = ?, total_points = ?, data_start_time = ?, 
          data_end_time = ?, updated_at = ? 
         WHERE target_id = ? AND profile_date = ?`,
        [target_name || null, JSON.stringify(common_routes), JSON.stringify(common_stay_areas),
         JSON.stringify(active_hours), total_points, data_start_time,
         data_end_time, now, target_id, profile_date]
      );
      return this.getByTargetAndDate(target_id, profile_date);
    } else {
      const result = await run(
        `INSERT INTO target_behavior_profiles 
          (target_id, target_name, profile_date, common_routes, common_stay_areas, 
           active_hours, total_points, data_start_time, data_end_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [target_id, target_name || null, profile_date, JSON.stringify(common_routes), 
         JSON.stringify(common_stay_areas), JSON.stringify(active_hours), total_points, 
         data_start_time, data_end_time, now, now]
      );
      return this.getById(result.lastID);
    }
  },

  async getById(id) {
    const row = await get('SELECT * FROM target_behavior_profiles WHERE id = ?', [id]);
    if (!row) return null;
    return this._parseRow(row);
  },

  async getByTargetAndDate(target_id, profile_date) {
    const row = await get(
      'SELECT * FROM target_behavior_profiles WHERE target_id = ? AND profile_date = ?',
      [target_id, profile_date]
    );
    if (!row) return null;
    return this._parseRow(row);
  },

  async getLatestByTarget(target_id) {
    const row = await get(
      'SELECT * FROM target_behavior_profiles WHERE target_id = ? ORDER BY profile_date DESC, updated_at DESC LIMIT 1',
      [target_id]
    );
    if (!row) return null;
    return this._parseRow(row);
  },

  async getAllLatest() {
    const rows = await all(`
      SELECT p.* 
      FROM target_behavior_profiles p
      INNER JOIN (
        SELECT target_id, MAX(profile_date) as max_date, MAX(updated_at) as max_updated
        FROM target_behavior_profiles
        GROUP BY target_id
      ) latest ON p.target_id = latest.target_id 
        AND p.profile_date = latest.max_date 
        AND p.updated_at = latest.max_updated
    `);
    return rows.map(row => this._parseRow(row));
  },

  async getByTarget(target_id, limit = 30) {
    const rows = await all(
      'SELECT * FROM target_behavior_profiles WHERE target_id = ? ORDER BY profile_date DESC LIMIT ?',
      [target_id, limit]
    );
    return rows.map(row => this._parseRow(row));
  },

  _parseRow(row) {
    return {
      ...row,
      common_routes: JSON.parse(row.common_routes),
      common_stay_areas: JSON.parse(row.common_stay_areas),
      active_hours: JSON.parse(row.active_hours)
    };
  }
};

const BehaviorAnomalyModel = {
  async create({ target_id, target_name, anomaly_type, description, lng, lat, timestamp, details, group_id, group_name }) {
    const now = Date.now();
    const result = await run(
      `INSERT INTO behavior_anomaly_events 
        (target_id, target_name, anomaly_type, description, lng, lat, timestamp, details, group_id, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [target_id, target_name || null, anomaly_type, description, lng, lat, timestamp,
       details ? JSON.stringify(details) : null, group_id || null, group_name || null, now]
    );
    return this.getById(result.lastID);
  },

  async getById(id) {
    const row = await get('SELECT * FROM behavior_anomaly_events WHERE id = ?', [id]);
    if (!row) return null;
    return this._parseRow(row);
  },

  async query({ target_id, anomaly_type, start_time, end_time, group_id, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM behavior_anomaly_events WHERE 1=1';
    const params = [];
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (anomaly_type) { sql += ' AND anomaly_type = ?'; params.push(anomaly_type); }
    if (group_id !== undefined && group_id !== null) { sql += ' AND group_id = ?'; params.push(group_id); }
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = await all(sql, params);
    return rows.map(row => this._parseRow(row));
  },

  async getTargetStats(start_time, end_time) {
    let sql = `
      SELECT 
        target_id,
        target_name,
        COUNT(*) as total_anomalies,
        SUM(CASE WHEN anomaly_type = 'route_deviation' THEN 1 ELSE 0 END) as route_deviation_count,
        SUM(CASE WHEN anomaly_type = 'area_anomaly' THEN 1 ELSE 0 END) as area_anomaly_count,
        SUM(CASE WHEN anomaly_type = 'time_anomaly' THEN 1 ELSE 0 END) as time_anomaly_count
      FROM behavior_anomaly_events
      WHERE 1=1
    `;
    const params = [];
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    sql += ' GROUP BY target_id, target_name ORDER BY total_anomalies DESC';
    return all(sql, params);
  },

  async getTypeDistribution(start_time, end_time) {
    let sql = `
      SELECT 
        anomaly_type,
        COUNT(*) as count,
        COUNT(DISTINCT target_id) as target_count
      FROM behavior_anomaly_events
      WHERE 1=1
    `;
    const params = [];
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    sql += ' GROUP BY anomaly_type ORDER BY count DESC';
    return all(sql, params);
  },

  async getLatestByTargetAndType(target_id, anomaly_type) {
    const row = await get(
      'SELECT * FROM behavior_anomaly_events WHERE target_id = ? AND anomaly_type = ? ORDER BY timestamp DESC LIMIT 1',
      [target_id, anomaly_type]
    );
    if (!row) return null;
    return this._parseRow(row);
  },

  _parseRow(row) {
    return {
      ...row,
      details: row.details ? JSON.parse(row.details) : null
    };
  }
};

const OfflineEventModel = {
  async create({ target_id, target_name, event_type, offline_start_at, offline_end_at, offline_duration_ms, last_lng, last_lat, recover_lng, recover_lat }) {
    const now = Date.now();
    const result = await run(
      `INSERT INTO offline_events 
        (target_id, target_name, event_type, offline_start_at, offline_end_at, offline_duration_ms, last_lng, last_lat, recover_lng, recover_lat, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [target_id, target_name || null, event_type, offline_start_at,
       offline_end_at || null, offline_duration_ms || null,
       last_lng !== undefined ? last_lng : null,
       last_lat !== undefined ? last_lat : null,
       recover_lng !== undefined ? recover_lng : null,
       recover_lat !== undefined ? recover_lat : null, now]
    );
    return this.getById(result.lastID);
  },

  async getById(id) {
    return get('SELECT * FROM offline_events WHERE id = ?', [id]);
  },

  async query({ target_id, event_type, start_time, end_time, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM offline_events WHERE 1=1';
    const params = [];
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
    if (start_time) { sql += ' AND offline_start_at >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND offline_start_at <= ?'; params.push(end_time); }
    sql += ' ORDER BY offline_start_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return all(sql, params);
  },

  async getByTarget(target_id, limit = 100) {
    return all(
      'SELECT * FROM offline_events WHERE target_id = ? ORDER BY offline_start_at DESC LIMIT ?',
      [target_id, limit]
    );
  }
};

const OfflineStatsModel = {
  async upsert({ target_id, total_offline_count, total_offline_ms, longest_single_offline_ms, latest_offline_start_at, latest_offline_end_at, latest_offline_duration_ms }) {
    const now = Date.now();
    const existing = await get('SELECT target_id FROM target_offline_stats WHERE target_id = ?', [target_id]);
    if (existing) {
      await run(
        `UPDATE target_offline_stats SET 
          total_offline_count = ?, total_offline_ms = ?, longest_single_offline_ms = ?,
          latest_offline_start_at = ?, latest_offline_end_at = ?, latest_offline_duration_ms = ?, updated_at = ?
         WHERE target_id = ?`,
        [total_offline_count, total_offline_ms, longest_single_offline_ms,
         latest_offline_start_at || null, latest_offline_end_at || null,
         latest_offline_duration_ms || null, now, target_id]
      );
    } else {
      await run(
        `INSERT INTO target_offline_stats 
          (target_id, total_offline_count, total_offline_ms, longest_single_offline_ms,
           latest_offline_start_at, latest_offline_end_at, latest_offline_duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [target_id, total_offline_count || 0, total_offline_ms || 0,
         longest_single_offline_ms || 0,
         latest_offline_start_at || null, latest_offline_end_at || null,
         latest_offline_duration_ms || null, now]
      );
    }
    return this.getByTarget(target_id);
  },

  async getByTarget(target_id) {
    return get('SELECT * FROM target_offline_stats WHERE target_id = ?', [target_id]);
  },

  async getAll() {
    return all('SELECT * FROM target_offline_stats');
  },

  async delete(target_id) {
    await run('DELETE FROM target_offline_stats WHERE target_id = ?', [target_id]);
    return true;
  }
};

const FormationModel = {
  async create({ name, radius_threshold, status, route_fence_ids }) {
    const now = Date.now();
    const result = await run(
      `INSERT INTO formations (name, radius_threshold, status, route_fence_ids, route_progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, radius_threshold || 0.01, status || 'inactive',
       route_fence_ids ? JSON.stringify(route_fence_ids) : null,
       route_fence_ids ? JSON.stringify(route_fence_ids.map(() => false)) : null,
       now, now]
    );
    return this.getById(result.lastID);
  },

  async getById(id) {
    const row = await get('SELECT * FROM formations WHERE id = ?', [id]);
    if (!row) return null;
    return this._parseRow(row);
  },

  async getAll() {
    const rows = await all('SELECT * FROM formations ORDER BY created_at DESC');
    return rows.map(row => this._parseRow(row));
  },

  async getByStatus(status) {
    const rows = await all('SELECT * FROM formations WHERE status = ? ORDER BY created_at DESC', [status]);
    return rows.map(row => this._parseRow(row));
  },

  async getByName(name) {
    const row = await get('SELECT * FROM formations WHERE name = ?', [name]);
    if (!row) return null;
    return this._parseRow(row);
  },

  async update(id, fields) {
    const existing = await this.getById(id);
    if (!existing) return null;
    const keys = Object.keys(fields);
    if (keys.length === 0) return existing;
    const setClause = keys.map(k => {
      if (k === 'route_fence_ids' || k === 'route_progress') return `${k} = ?`;
      return `${k} = ?`;
    }).join(', ');
    const values = keys.map(k => {
      if (k === 'route_fence_ids' && fields[k]) return JSON.stringify(fields[k]);
      if (k === 'route_progress' && fields[k]) return JSON.stringify(fields[k]);
      return fields[k];
    });
    values.push(Date.now());
    values.push(id);
    await run(`UPDATE formations SET ${setClause}, updated_at = ? WHERE id = ?`, values);
    return this.getById(id);
  },

  async delete(id) {
    await run('DELETE FROM formations WHERE id = ?', [id]);
    return true;
  },

  _parseRow(row) {
    return {
      ...row,
      route_fence_ids: row.route_fence_ids ? JSON.parse(row.route_fence_ids) : null,
      route_progress: row.route_progress ? JSON.parse(row.route_progress) : null
    };
  }
};

const FormationMemberModel = {
  async create({ formation_id, target_id, target_name }) {
    const now = Date.now();
    const result = await run(
      'INSERT INTO formation_members (formation_id, target_id, target_name, joined_at) VALUES (?, ?, ?, ?)',
      [formation_id, target_id, target_name || null, now]
    );
    return this.getById(result.lastID);
  },

  async getById(id) {
    return get('SELECT * FROM formation_members WHERE id = ?', [id]);
  },

  async getByFormationId(formation_id) {
    return all('SELECT * FROM formation_members WHERE formation_id = ?', [formation_id]);
  },

  async getByTargetId(target_id) {
    return get('SELECT * FROM formation_members WHERE target_id = ?', [target_id]);
  },

  async deleteByFormationId(formation_id) {
    await run('DELETE FROM formation_members WHERE formation_id = ?', [formation_id]);
    return true;
  },

  async deleteById(id) {
    await run('DELETE FROM formation_members WHERE id = ?', [id]);
    return true;
  },

  async deleteByTargetId(target_id) {
    await run('DELETE FROM formation_members WHERE target_id = ?', [target_id]);
    return true;
  },

  async batchCreate(formation_id, members) {
    const now = Date.now();
    for (const m of members) {
      await run(
        'INSERT OR IGNORE INTO formation_members (formation_id, target_id, target_name, joined_at) VALUES (?, ?, ?, ?)',
        [formation_id, m.target_id, m.target_name || null, now]
      );
    }
    return this.getByFormationId(formation_id);
  }
};

const FormationEventModel = {
  async create({ formation_id, formation_name, target_id, target_name, event_type, center_lng, center_lat, member_lng, member_lat, deviation, timestamp }) {
    const now = Date.now();
    const result = await run(
      `INSERT INTO formation_events
        (formation_id, formation_name, target_id, target_name, event_type, center_lng, center_lat, member_lng, member_lat, deviation, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [formation_id, formation_name, target_id, target_name || null, event_type,
       center_lng, center_lat, member_lng, member_lat, deviation, timestamp, now]
    );
    return this.getById(result.lastID);
  },

  async getById(id) {
    return get('SELECT * FROM formation_events WHERE id = ?', [id]);
  },

  async query({ formation_id, target_id, event_type, start_time, end_time, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM formation_events WHERE 1=1';
    const params = [];
    if (formation_id) { sql += ' AND formation_id = ?'; params.push(formation_id); }
    if (target_id) { sql += ' AND target_id = ?'; params.push(target_id); }
    if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return all(sql, params);
  },

  async getByFormationId(formation_id, limit = 100) {
    return all('SELECT * FROM formation_events WHERE formation_id = ? ORDER BY timestamp DESC LIMIT ?', [formation_id, limit]);
  },

  async countByFormation(formation_id) {
    const row = await get('SELECT COUNT(*) as count FROM formation_events WHERE formation_id = ?', [formation_id]);
    return row ? row.count : 0;
  },

  async getDetachStats(formation_id) {
    const rows = await all(`
      SELECT target_id, target_name, COUNT(*) as detach_count
      FROM formation_events
      WHERE formation_id = ? AND event_type = 'detached'
      GROUP BY target_id, target_name
      ORDER BY detach_count DESC
    `, [formation_id]);
    return rows;
  },

  async getTotalDetachCount(formation_id) {
    const row = await get(`
      SELECT COUNT(*) as count FROM formation_events
      WHERE formation_id = ? AND event_type = 'detached'
    `, [formation_id]);
    return row ? row.count : 0;
  }
};

const CapacityConfigModel = {
  async getByFenceId(fenceId) {
    return get('SELECT * FROM fence_capacity_config WHERE fence_id = ?', [fenceId]);
  },
  async getAll() {
    return all('SELECT * FROM fence_capacity_config ORDER BY fence_id');
  },
  async set(fenceId, { max_capacity, warning_threshold_pct }) {
    const existing = await this.getByFenceId(fenceId);
    if (existing) {
      await run(
        'UPDATE fence_capacity_config SET max_capacity = ?, warning_threshold_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE fence_id = ?',
        [max_capacity, warning_threshold_pct, fenceId]
      );
    } else {
      await run(
        'INSERT INTO fence_capacity_config (fence_id, max_capacity, warning_threshold_pct) VALUES (?, ?, ?)',
        [fenceId, max_capacity, warning_threshold_pct]
      );
    }
    return this.getByFenceId(fenceId);
  },
  async delete(fenceId) {
    await run('DELETE FROM fence_capacity_config WHERE fence_id = ?', [fenceId]);
    return true;
  }
};

const CapacityEventModel = {
  async create({ fence_id, fence_name, event_type, old_status, new_status, current_count, max_capacity, target_id, target_name, timestamp, details }) {
    const now = Date.now();
    const result = await run(
      `INSERT INTO capacity_events
        (fence_id, fence_name, event_type, old_status, new_status, current_count, max_capacity, target_id, target_name, timestamp, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fence_id, fence_name, event_type, old_status || null, new_status,
       current_count, max_capacity, target_id || null, target_name || null,
       timestamp, details ? JSON.stringify(details) : null, now]
    );
    return this.getById(result.lastID);
  },
  async getById(id) {
    const row = await get('SELECT * FROM capacity_events WHERE id = ?', [id]);
    if (!row) return null;
    return { ...row, details: row.details ? JSON.parse(row.details) : null };
  },
  async query({ fence_id, event_type, start_time, end_time, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM capacity_events WHERE 1=1';
    const params = [];
    if (fence_id !== undefined) { sql += ' AND fence_id = ?'; params.push(fence_id); }
    if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
    if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
    if (end_time) { sql += ' AND timestamp <= ?'; params.push(end_time); }
    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = await all(sql, params);
    return rows.map(row => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
  },
  async getDailyFullDuration(fenceId, dayStart, dayEnd) {
    const rows = await all(
      `WITH full_entries AS (
         SELECT
           timestamp as full_start,
           LEAD(timestamp) OVER (ORDER BY timestamp) as full_end
         FROM capacity_events
         WHERE fence_id = ? AND timestamp >= ? AND timestamp <= ?
           AND event_type = 'capacity_full'
       )
       SELECT COALESCE(SUM(full_end - full_start), 0) as full_duration_ms
       FROM full_entries
       WHERE full_end IS NOT NULL`,
      [fenceId, dayStart, dayEnd]
    );
    return rows && rows[0] ? (rows[0].full_duration_ms || 0) : 0;
  },
  async getHourlyPeakUtilization(fenceId, dayStart, dayEnd) {
    return all(
      `SELECT
         (timestamp / 3600000) as hour_bucket,
         MAX(current_count) as peak_count,
         MAX(CASE WHEN max_capacity > 0 THEN ROUND(current_count * 100.0 / max_capacity, 1) ELSE 0 END) as peak_pct
       FROM capacity_events
       WHERE fence_id = ? AND timestamp >= ? AND timestamp <= ?
       GROUP BY hour_bucket
       ORDER BY hour_bucket`,
      [fenceId, dayStart, dayEnd]
    );
  },
  async getTodayFullCount(fenceId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayStart = today.getTime();
    const row = await get(
      `SELECT COUNT(*) as count FROM capacity_events
       WHERE fence_id = ? AND event_type = 'capacity_full' AND timestamp >= ?`,
      [fenceId, dayStart]
    );
    return row ? row.count : 0;
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
  HeatmapModel,
  DutyScheduleModel,
  WorkOrderModel,
  WorkOrderEscalationModel,
  PatrolTaskModel,
  BehaviorProfileModel,
  BehaviorAnomalyModel,
  OfflineEventModel,
  OfflineStatsModel,
  FormationModel,
  FormationMemberModel,
  FormationEventModel,
  CapacityConfigModel,
  CapacityEventModel
};
