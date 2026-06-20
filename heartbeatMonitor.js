const { OfflineEventModel, OfflineStatsModel } = require('./database');

const STATUS_UNKNOWN = 'unknown';
const STATUS_ONLINE = 'online';
const STATUS_OFFLINE = 'offline';

class HeartbeatMonitor {
  constructor(onOfflineEvent, onRecoverEvent, onStatusChange) {
    this.onOfflineEvent = onOfflineEvent;
    this.onRecoverEvent = onRecoverEvent;
    this.onStatusChange = onStatusChange;
    this.defaultTimeoutMs = 30 * 1000;
    this.scanIntervalMs = 5 * 1000;
    this.targetTimeouts = new Map();
    this.targetStates = new Map();
    this.targetLastPositions = new Map();
    this.scanTimer = null;
    this.isRunning = false;
    this.targetStats = new Map();
    this.currentOfflineSession = new Map();
  }

  setDefaultTimeout(ms) {
    this.defaultTimeoutMs = ms;
    console.log(`[Heartbeat] 全局超时阈值设为 ${ms / 1000}秒`);
  }

  setTargetTimeout(targetId, ms) {
    this.targetTimeouts.set(targetId, ms);
    console.log(`[Heartbeat] 目标 ${targetId} 超时阈值设为 ${ms / 1000}秒`);
  }

  getTargetTimeout(targetId) {
    return this.targetTimeouts.get(targetId) || this.defaultTimeoutMs;
  }

  recordHeartbeat(position) {
    const targetId = position.id;
    const now = Date.now();
    const prevStatus = this.getTargetStatus(targetId);
    const existed = this.targetStates.has(targetId);

    this.targetStates.set(targetId, {
      lastReportAt: now,
      status: STATUS_ONLINE,
      firstReportAt: existed ? this.targetStates.get(targetId).firstReportAt : now
    });
    this.targetLastPositions.set(targetId, {
      lng: position.lng,
      lat: position.lat,
      bearing: position.bearing,
      timestamp: now
    });

    if (prevStatus === STATUS_OFFLINE || prevStatus === STATUS_UNKNOWN) {
      const offlineSession = this.currentOfflineSession.get(targetId);
      const offlineDurationMs = offlineSession ? (now - offlineSession.offlineAt) : 0;

      if (prevStatus === STATUS_OFFLINE && offlineSession) {
        this.currentOfflineSession.delete(targetId);
        this._updateStatsOnRecover(targetId, offlineSession.offlineAt, now);
        OfflineEventModel.create({
          target_id: targetId,
          target_name: position.name,
          event_type: 'recover',
          offline_start_at: offlineSession.offlineAt,
          offline_end_at: now,
          offline_duration_ms: offlineDurationMs,
          last_lng: offlineSession.lastPos ? offlineSession.lastPos.lng : null,
          last_lat: offlineSession.lastPos ? offlineSession.lastPos.lat : null,
          recover_lng: position.lng,
          recover_lat: position.lat
        }).catch(err => console.error('[Heartbeat] 写入恢复事件失败:', err.message));
      }

      const recoverEvent = {
        id: `recover-${targetId}-${now}`,
        target_id: targetId,
        target_name: position.name,
        event_type: 'recover',
        offline_start_at: offlineSession ? offlineSession.offlineAt : null,
        offline_end_at: now,
        offline_duration_ms: offlineDurationMs,
        offline_duration_seconds: Math.round(offlineDurationMs / 1000),
        offline_duration_text: this._formatDuration(offlineDurationMs),
        last_lng: offlineSession && offlineSession.lastPos ? offlineSession.lastPos.lng : null,
        last_lat: offlineSession && offlineSession.lastPos ? offlineSession.lastPos.lat : null,
        recover_lng: position.lng,
        recover_lat: position.lat,
        timestamp: now
      };

      if (this.onRecoverEvent) {
        try {
          this.onRecoverEvent(recoverEvent);
        } catch (err) {
          console.error('[Heartbeat] 推送恢复事件失败:', err.message);
        }
      }
      if (this.onStatusChange) {
        try {
          this.onStatusChange({
            target_id: targetId,
            target_name: position.name,
            old_status: prevStatus,
            new_status: STATUS_ONLINE,
            timestamp: now
          });
        } catch (err) {
          console.error('[Heartbeat] 推送状态变更失败:', err.message);
        }
      }
      console.log(`[Heartbeat] 目标 ${targetId} (${position.name}) 已恢复在线，离线 ${this._formatDuration(offlineDurationMs)}`);
    }
  }

  getTargetStatus(targetId) {
    const state = this.targetStates.get(targetId);
    if (!state) return STATUS_UNKNOWN;
    return state.status;
  }

  getTargetState(targetId) {
    const state = this.targetStates.get(targetId);
    if (!state) {
      return {
        target_id: targetId,
        status: STATUS_UNKNOWN,
        last_report_at: null,
        timeout_ms: this.getTargetTimeout(targetId),
        offline_duration_ms: 0
      };
    }
    const now = Date.now();
    let offlineMs = 0;
    if (state.status === STATUS_OFFLINE) {
      const session = this.currentOfflineSession.get(targetId);
      offlineMs = session ? now - session.offlineAt : 0;
    }
    return {
      target_id: targetId,
      status: state.status,
      last_report_at: state.lastReportAt,
      last_report_seconds_ago: state.lastReportAt ? Math.round((now - state.lastReportAt) / 1000) : null,
      timeout_ms: this.getTargetTimeout(targetId),
      timeout_seconds: Math.round(this.getTargetTimeout(targetId) / 1000),
      offline_duration_ms: offlineMs,
      offline_duration_seconds: Math.round(offlineMs / 1000),
      offline_duration_text: this._formatDuration(offlineMs),
      first_report_at: state.firstReportAt
    };
  }

  getAllTargetStates() {
    const result = [];
    const allIds = new Set([
      ...this.targetStates.keys(),
      ...this.targetTimeouts.keys()
    ]);
    for (const targetId of allIds) {
      result.push(this.getTargetState(targetId));
    }
    return result;
  }

  getTargetLastPosition(targetId) {
    return this.targetLastPositions.get(targetId) || null;
  }

  isTargetOnline(targetId) {
    return this.getTargetStatus(targetId) === STATUS_ONLINE;
  }

  isTargetOffline(targetId) {
    return this.getTargetStatus(targetId) === STATUS_OFFLINE;
  }

  async _updateStatsOnOffline(targetId, offlineAt) {
    let stats = this.targetStats.get(targetId);
    if (!stats) {
      stats = {
        total_offline_count: 0,
        total_offline_ms: 0,
        longest_single_offline_ms: 0,
        latest_offline_start_at: offlineAt,
        latest_offline_end_at: null,
        latest_offline_duration_ms: 0
      };
    }
    stats.total_offline_count += 1;
    stats.latest_offline_start_at = offlineAt;
    stats.latest_offline_end_at = null;
    stats.latest_offline_duration_ms = 0;
    this.targetStats.set(targetId, stats);

    try {
      await OfflineStatsModel.upsert({
        target_id: targetId,
        total_offline_count: stats.total_offline_count,
        total_offline_ms: stats.total_offline_ms,
        longest_single_offline_ms: stats.longest_single_offline_ms,
        latest_offline_start_at: stats.latest_offline_start_at,
        latest_offline_end_at: stats.latest_offline_end_at,
        latest_offline_duration_ms: stats.latest_offline_duration_ms
      });
    } catch (err) {
      console.error('[Heartbeat] 写入离线统计(离线)失败:', err.message);
    }
  }

  async _updateStatsOnRecover(targetId, offlineAt, recoverAt) {
    const durationMs = recoverAt - offlineAt;
    let stats = this.targetStats.get(targetId);
    if (!stats) {
      stats = {
        total_offline_count: 1,
        total_offline_ms: durationMs,
        longest_single_offline_ms: durationMs,
        latest_offline_start_at: offlineAt,
        latest_offline_end_at: recoverAt,
        latest_offline_duration_ms: durationMs
      };
    } else {
      stats.total_offline_ms += durationMs;
      if (durationMs > stats.longest_single_offline_ms) {
        stats.longest_single_offline_ms = durationMs;
      }
      stats.latest_offline_end_at = recoverAt;
      stats.latest_offline_duration_ms = durationMs;
    }
    this.targetStats.set(targetId, stats);

    try {
      await OfflineStatsModel.upsert({
        target_id: targetId,
        total_offline_count: stats.total_offline_count,
        total_offline_ms: stats.total_offline_ms,
        longest_single_offline_ms: stats.longest_single_offline_ms,
        latest_offline_start_at: stats.latest_offline_start_at,
        latest_offline_end_at: stats.latest_offline_end_at,
        latest_offline_duration_ms: stats.latest_offline_duration_ms
      });
    } catch (err) {
      console.error('[Heartbeat] 写入离线统计(恢复)失败:', err.message);
    }
  }

  async loadStatsFromDb() {
    try {
      const rows = await OfflineStatsModel.getAll();
      for (const row of rows) {
        this.targetStats.set(row.target_id, {
          total_offline_count: row.total_offline_count,
          total_offline_ms: row.total_offline_ms,
          longest_single_offline_ms: row.longest_single_offline_ms,
          latest_offline_start_at: row.latest_offline_start_at,
          latest_offline_end_at: row.latest_offline_end_at,
          latest_offline_duration_ms: row.latest_offline_duration_ms
        });
      }
      console.log(`[Heartbeat] 已加载 ${rows.length} 个目标的离线统计数据`);
    } catch (err) {
      console.error('[Heartbeat] 加载离线统计失败:', err.message);
    }
  }

  getTargetStats(targetId) {
    const stats = this.targetStats.get(targetId);
    if (!stats) {
      return {
        target_id: targetId,
        total_offline_count: 0,
        total_offline_ms: 0,
        total_offline_seconds: 0,
        total_offline_text: this._formatDuration(0),
        longest_single_offline_ms: 0,
        longest_single_offline_seconds: 0,
        longest_single_offline_text: this._formatDuration(0),
        latest_offline_start_at: null,
        latest_offline_end_at: null,
        latest_offline_duration_ms: 0,
        latest_offline_duration_seconds: 0,
        latest_offline_duration_text: this._formatDuration(0)
      };
    }
    return {
      target_id: targetId,
      total_offline_count: stats.total_offline_count,
      total_offline_ms: stats.total_offline_ms,
      total_offline_seconds: Math.round(stats.total_offline_ms / 1000),
      total_offline_text: this._formatDuration(stats.total_offline_ms),
      longest_single_offline_ms: stats.longest_single_offline_ms,
      longest_single_offline_seconds: Math.round(stats.longest_single_offline_ms / 1000),
      longest_single_offline_text: this._formatDuration(stats.longest_single_offline_ms),
      latest_offline_start_at: stats.latest_offline_start_at,
      latest_offline_end_at: stats.latest_offline_end_at,
      latest_offline_duration_ms: stats.latest_offline_duration_ms,
      latest_offline_duration_seconds: Math.round(stats.latest_offline_duration_ms / 1000),
      latest_offline_duration_text: this._formatDuration(stats.latest_offline_duration_ms)
    };
  }

  getAllStats() {
    const result = [];
    for (const targetId of this.targetStats.keys()) {
      result.push(this.getTargetStats(targetId));
    }
    return result;
  }

  startScan(intervalMs) {
    if (intervalMs) this.scanIntervalMs = intervalMs;
    if (this.isRunning) return;
    this.isRunning = true;
    this.scanTimer = setInterval(() => this._scan(), this.scanIntervalMs);
    console.log(`[Heartbeat] 心跳扫描器已启动，间隔 ${this.scanIntervalMs / 1000}秒`);
  }

  stopScan() {
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    console.log('[Heartbeat] 心跳扫描器已停止');
  }

  _scan() {
    const now = Date.now();
    for (const [targetId, state] of this.targetStates.entries()) {
      if (state.status === STATUS_OFFLINE) continue;
      const timeoutMs = this.getTargetTimeout(targetId);
      const elapsed = now - state.lastReportAt;
      if (elapsed > timeoutMs) {
        this._markOffline(targetId, now);
      }
    }
  }

  async _markOffline(targetId, now) {
    const state = this.targetStates.get(targetId);
    if (!state) return;
    const prevStatus = state.status;
    state.status = STATUS_OFFLINE;
    const lastPos = this.targetLastPositions.get(targetId);

    this.currentOfflineSession.set(targetId, {
      offlineAt: now,
      lastPos: lastPos ? { ...lastPos } : null
    });

    await this._updateStatsOnOffline(targetId, now);

    const targetName = this._getTargetName(targetId);
    OfflineEventModel.create({
      target_id: targetId,
      target_name: targetName,
      event_type: 'offline',
      offline_start_at: now,
      offline_end_at: null,
      offline_duration_ms: null,
      last_lng: lastPos ? lastPos.lng : null,
      last_lat: lastPos ? lastPos.lat : null,
      recover_lng: null,
      recover_lat: null
    }).catch(err => console.error('[Heartbeat] 写入离线事件失败:', err.message));

    const offlineEvent = {
      id: `offline-${targetId}-${now}`,
      target_id: targetId,
      target_name: targetName,
      event_type: 'offline',
      offline_start_at: now,
      last_lng: lastPos ? lastPos.lng : null,
      last_lat: lastPos ? lastPos.lat : null,
      last_bearing: lastPos ? lastPos.bearing : null,
      last_report_at: state.lastReportAt,
      last_report_seconds_ago: Math.round((now - state.lastReportAt) / 1000),
      timeout_ms: this.getTargetTimeout(targetId),
      timeout_seconds: Math.round(this.getTargetTimeout(targetId) / 1000),
      timestamp: now
    };

    if (this.onOfflineEvent) {
      try {
        this.onOfflineEvent(offlineEvent);
      } catch (err) {
        console.error('[Heartbeat] 推送离线事件失败:', err.message);
      }
    }
    if (this.onStatusChange) {
      try {
        this.onStatusChange({
          target_id: targetId,
          target_name: targetName,
          old_status: prevStatus,
          new_status: STATUS_OFFLINE,
          timestamp: now
        });
      } catch (err) {
        console.error('[Heartbeat] 推送状态变更失败:', err.message);
      }
    }
    console.log(`[Heartbeat] 目标 ${targetId} (${targetName}) 已离线，最后上报 ${Math.round((now - state.lastReportAt) / 1000)}秒前`);
  }

  _getTargetName(targetId) {
    const { getPresetTargets } = require('./gpsSimulator');
    const targets = getPresetTargets();
    const found = targets.find(t => t.id === targetId);
    return found ? found.name : targetId;
  }

  _formatDuration(ms) {
    if (!ms || ms < 0) return '0秒';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
    return parts.join('');
  }

  async init() {
    await this.loadStatsFromDb();
  }
}

module.exports = {
  HeartbeatMonitor,
  STATUS_UNKNOWN,
  STATUS_ONLINE,
  STATUS_OFFLINE
};
