const { CapacityConfigModel, CapacityEventModel, FenceModel } = require('./database');

class CapacityManager {
  constructor(onCapacityStatusChange) {
    this.onCapacityStatusChange = onCapacityStatusChange;
    this.configs = new Map();
    this.states = new Map();
    this.inflowHistory = new Map();
    this.overlimitTargets = new Map();
  }

  async loadConfigs() {
    const configs = await CapacityConfigModel.getAll();
    this.configs.clear();
    for (const cfg of configs) {
      this.configs.set(cfg.fence_id, {
        max_capacity: cfg.max_capacity,
        warning_threshold_pct: cfg.warning_threshold_pct
      });
      if (!this.states.has(cfg.fence_id)) {
        this.states.set(cfg.fence_id, {
          current_count: 0,
          status: 'normal',
          today_full_count: 0
        });
      }
    }
  }

  async setConfig(fenceId, { max_capacity, warning_threshold_pct }) {
    if (max_capacity < 1) throw new Error('max_capacity 必须大于0');
    if (warning_threshold_pct <= 0 || warning_threshold_pct > 100) throw new Error('warning_threshold_pct 必须在(0, 100]范围内');
    const cfg = await CapacityConfigModel.set(fenceId, { max_capacity, warning_threshold_pct });
    this.configs.set(fenceId, {
      max_capacity: cfg.max_capacity,
      warning_threshold_pct: cfg.warning_threshold_pct
    });
    if (!this.states.has(fenceId)) {
      this.states.set(fenceId, {
        current_count: 0,
        status: 'normal',
        today_full_count: 0
      });
    }
    return cfg;
  }

  async deleteConfig(fenceId) {
    await CapacityConfigModel.delete(fenceId);
    this.configs.delete(fenceId);
    this.states.delete(fenceId);
    this.inflowHistory.delete(fenceId);
    this.overlimitTargets.delete(fenceId);
  }

  hasCapacity(fenceId) {
    return this.configs.has(fenceId);
  }

  getConfig(fenceId) {
    return this.configs.get(fenceId);
  }

  getStatus(fenceId) {
    return this.states.get(fenceId);
  }

  recordInflow(fenceId, isEnter, timestamp) {
    if (!this.inflowHistory.has(fenceId)) {
      this.inflowHistory.set(fenceId, []);
    }
    const history = this.inflowHistory.get(fenceId);
    history.push({ isEnter, timestamp });
    const cutoff = Date.now() - 10 * 60 * 1000;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
  }

  predictMinutesToFull(fenceId) {
    const config = this.configs.get(fenceId);
    const state = this.states.get(fenceId);
    if (!config || !state) return null;

    const remaining = config.max_capacity - state.current_count;
    if (remaining <= 0) return 0;

    const history = this.inflowHistory.get(fenceId);
    if (!history || history.length < 2) return null;

    const now = Date.now();
    const windowStart = now - 10 * 60 * 1000;
    const recentEvents = history.filter(e => e.timestamp >= windowStart);
    if (recentEvents.length < 2) return null;

    const enters = recentEvents.filter(e => e.isEnter).length;
    const leaves = recentEvents.filter(e => !e.isEnter).length;
    const windowMinutes = 10;
    const netInflowPerMin = (enters - leaves) / windowMinutes;

    if (netInflowPerMin <= 0) return null;

    return Math.ceil(remaining / netInflowPerMin);
  }

  computeStatus(currentCount, config) {
    const warningThreshold = Math.max(1, Math.min(Math.floor(config.max_capacity * config.warning_threshold_pct / 100), config.max_capacity - 1));
    if (currentCount >= config.max_capacity) return 'full';
    if (currentCount >= warningThreshold) return 'warning';
    return 'normal';
  }

  async onTargetEnter(fenceId, fenceName, targetId, targetName, timestamp, currentCount, isFenceActive) {
    if (!this.hasCapacity(fenceId)) return { overlimit: false };

    const config = this.configs.get(fenceId);
    const state = this.states.get(fenceId);

    if (!isFenceActive) {
      return { overlimit: false };
    }

    this.recordInflow(fenceId, true, timestamp);

    if (!this.overlimitTargets.has(fenceId)) {
      this.overlimitTargets.set(fenceId, new Set());
    }

    const isOverlimit = state.status === 'full';

    if (isOverlimit) {
      this.overlimitTargets.get(fenceId).add(targetId);

      await CapacityEventModel.create({
        fence_id: fenceId,
        fence_name: fenceName,
        event_type: 'capacity_overlimit',
        old_status: 'full',
        new_status: 'full',
        current_count: state.current_count,
        max_capacity: config.max_capacity,
        target_id: targetId,
        target_name: targetName,
        timestamp,
        details: { rejected: true }
      });
      return { overlimit: true, oldStatus: 'full', newStatus: 'full' };
    }

    state.current_count = state.current_count + 1;
    const newCount = state.current_count;
    const newStatus = this.computeStatus(newCount, config);
    const oldStatus = state.status;

    if (newStatus !== oldStatus) {
      state.status = newStatus;

      let eventType;
      if (newStatus === 'warning') eventType = 'capacity_warning';
      else if (newStatus === 'full') eventType = 'capacity_full';
      else eventType = 'capacity_normal';

      if (newStatus === 'full') {
        state.today_full_count++;
      }

      await CapacityEventModel.create({
        fence_id: fenceId,
        fence_name: fenceName,
        event_type: eventType,
        old_status: oldStatus,
        new_status: newStatus,
        current_count: newCount,
        max_capacity: config.max_capacity,
        target_id: targetId,
        target_name: targetName,
        timestamp
      });

      if (this.onCapacityStatusChange) {
        this.onCapacityStatusChange({
          fence_id: fenceId,
          fence_name: fenceName,
          old_status: oldStatus,
          new_status: newStatus,
          current_count: newCount,
          max_capacity: config.max_capacity,
          ratio: config.max_capacity > 0 ? Math.round(newCount / config.max_capacity * 1000) / 10 : 0,
          timestamp
        });
      }

      return { overlimit: newStatus === 'full', oldStatus, newStatus };
    }

    return { overlimit: false };
  }

  async onTargetLeave(fenceId, fenceName, targetId, targetName, timestamp, currentCount, isFenceActive) {
    if (!this.hasCapacity(fenceId)) return;

    const config = this.configs.get(fenceId);
    const state = this.states.get(fenceId);

    if (!isFenceActive) {
      return;
    }

    this.recordInflow(fenceId, false, timestamp);

    const overlimitSet = this.overlimitTargets.get(fenceId);
    if (overlimitSet && overlimitSet.has(targetId)) {
      overlimitSet.delete(targetId);
      return;
    }

    state.current_count = Math.max(0, state.current_count - 1);
    const newCount = state.current_count;
    const newStatus = this.computeStatus(newCount, config);
    const oldStatus = state.status;

    if (newStatus !== oldStatus) {
      state.status = newStatus;

      let eventType;
      if (newStatus === 'warning') eventType = 'capacity_warning';
      else if (newStatus === 'full') eventType = 'capacity_full';
      else eventType = 'capacity_normal';

      await CapacityEventModel.create({
        fence_id: fenceId,
        fence_name: fenceName,
        event_type: eventType,
        old_status: oldStatus,
        new_status: newStatus,
        current_count: newCount,
        max_capacity: config.max_capacity,
        target_id: targetId,
        target_name: targetName,
        timestamp
      });

      if (this.onCapacityStatusChange) {
        this.onCapacityStatusChange({
          fence_id: fenceId,
          fence_name: fenceName,
          old_status: oldStatus,
          new_status: newStatus,
          current_count: newCount,
          max_capacity: config.max_capacity,
          ratio: config.max_capacity > 0 ? Math.round(newCount / config.max_capacity * 1000) / 10 : 0,
          timestamp
        });
      }
    }
  }

  async onFenceDeactivated(fenceId) {
    const state = this.states.get(fenceId);
    if (!state) return;
    const oldStatus = state.status;
    if (oldStatus === 'normal') return;

    const config = this.configs.get(fenceId);
    if (!config) return;

    const fence = await FenceModel.getById(fenceId);
    const fenceName = fence ? fence.name : `Fence ${fenceId}`;

    state.status = 'normal';
    state.current_count = 0;

    const overlimitSet = this.overlimitTargets.get(fenceId);
    if (overlimitSet) {
      overlimitSet.clear();
    }

    await CapacityEventModel.create({
      fence_id: fenceId,
      fence_name: fenceName,
      event_type: 'capacity_normal',
      old_status: oldStatus,
      new_status: 'normal',
      current_count: 0,
      max_capacity: config.max_capacity,
      timestamp: Date.now(),
      details: { reason: 'fence_deactivated' }
    });

    if (this.onCapacityStatusChange) {
      this.onCapacityStatusChange({
        fence_id: fenceId,
        fence_name: fenceName,
        old_status: oldStatus,
        new_status: 'normal',
        current_count: 0,
        max_capacity: config.max_capacity,
        ratio: 0,
        timestamp: Date.now()
      });
    }
  }

  async onFenceReactivated(fenceId, currentCount) {
    const state = this.states.get(fenceId);
    const config = this.configs.get(fenceId);
    if (!state || !config) return;

    const overlimitSet = this.overlimitTargets.get(fenceId);
    if (overlimitSet) {
      overlimitSet.clear();
    }

    const effectiveCount = Math.min(currentCount, config.max_capacity);
    state.current_count = effectiveCount;
    const newStatus = this.computeStatus(effectiveCount, config);
    const oldStatus = state.status;

    if (newStatus === oldStatus) return;

    state.status = newStatus;
    const fence = await FenceModel.getById(fenceId);
    const fenceName = fence ? fence.name : `Fence ${fenceId}`;

    let eventType;
    if (newStatus === 'warning') eventType = 'capacity_warning';
    else if (newStatus === 'full') eventType = 'capacity_full';
    else eventType = 'capacity_normal';

    if (newStatus === 'full') {
      state.today_full_count++;
    }

    await CapacityEventModel.create({
      fence_id: fenceId,
      fence_name: fenceName,
      event_type: eventType,
      old_status: oldStatus,
      new_status: newStatus,
      current_count: effectiveCount,
      max_capacity: config.max_capacity,
      timestamp: Date.now(),
      details: { reason: 'fence_reactivated' }
    });

    if (this.onCapacityStatusChange) {
      this.onCapacityStatusChange({
        fence_id: fenceId,
        fence_name: fenceName,
        old_status: oldStatus,
        new_status: newStatus,
        current_count: effectiveCount,
        max_capacity: config.max_capacity,
        ratio: config.max_capacity > 0 ? Math.round(effectiveCount / config.max_capacity * 1000) / 10 : 0,
        timestamp: Date.now()
      });
    }
  }

  async getCapacitySummary(fenceId) {
    const config = this.configs.get(fenceId);
    const state = this.states.get(fenceId);
    if (!config || !state) return null;

    const fence = await FenceModel.getById(fenceId);
    const prediction = this.predictMinutesToFull(fenceId);
    const todayFullCount = await CapacityEventModel.getTodayFullCount(fenceId);

    return {
      fence_id: fenceId,
      fence_name: fence ? fence.name : `Fence ${fenceId}`,
      current_count: state.current_count,
      max_capacity: config.max_capacity,
      ratio: config.max_capacity > 0 ? Math.round(state.current_count / config.max_capacity * 1000) / 10 : 0,
      status: state.status,
      warning_threshold_pct: config.warning_threshold_pct,
      warning_threshold_count: Math.max(1, Math.min(Math.floor(config.max_capacity * config.warning_threshold_pct / 100), config.max_capacity - 1)),
      predicted_minutes_to_full: prediction,
      today_full_count: todayFullCount
    };
  }

  async getAllCapacitySummaries() {
    const summaries = [];
    for (const [fenceId] of this.configs) {
      const summary = await this.getCapacitySummary(fenceId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  resetDailyStats() {
    for (const [, state] of this.states) {
      state.today_full_count = 0;
    }
  }

  setCurrentCount(fenceId, count) {
    const state = this.states.get(fenceId);
    if (state) {
      state.current_count = count;
    }
  }
}

module.exports = { CapacityManager };
