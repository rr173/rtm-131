const { pointInPolygon } = require('./geometry');
const { FenceModel, AlertModel, FenceTimeWindowModel, FenceAlertRuleModel, FenceActionModel, FenceActivationOverrideModel, TargetBindingModel } = require('./database');
const http = require('http');
const https = require('https');
const url = require('url');

class FenceEngine {
  constructor(onAlert, onFenceStatusChange) {
    this.onAlert = onAlert;
    this.onFenceStatusChange = onFenceStatusChange;
    this.targetStates = new Map();
    this.fenceStats = new Map();
    this.fenceGroupStats = new Map();
    this.enterTimes = new Map();
    this.fences = [];
    this.timeWindows = new Map();
    this.alertRules = new Map();
    this.fenceActions = new Map();
    this.activationOverrides = new Map();
    this.fenceActiveStatus = new Map();
    this.lastFenceStatusCheck = 0;
  }

  async reloadFences() {
    this.fences = await FenceModel.getAll();
    const allTimeWindows = await FenceTimeWindowModel.getAll();
    const allAlertRules = await FenceAlertRuleModel.getByFenceId ? [] : [];
    const allActions = await FenceActionModel.getAll();
    const allOverrides = await FenceActivationOverrideModel.getAll();

    this.timeWindows.clear();
    this.alertRules.clear();
    this.fenceActions.clear();
    this.activationOverrides.clear();

    allTimeWindows.forEach(tw => {
      this.timeWindows.set(tw.fence_id, tw);
    });

    for (const fence of this.fences) {
      const rules = await FenceAlertRuleModel.getByFenceId(fence.id);
      this.alertRules.set(fence.id, rules);
      const actions = await FenceActionModel.getByFenceId(fence.id);
      this.fenceActions.set(fence.id, actions);
    }

    allOverrides.forEach(ov => {
      this.activationOverrides.set(ov.fence_id, ov);
    });

    this.fences.forEach(fence => {
      if (!this.fenceStats.has(fence.id)) {
        this.fenceStats.set(fence.id, {
          currentTargets: new Set(),
          todayEnterCount: 0,
          todayLeaveCount: 0,
          totalStayDuration: 0,
          stayCount: 0
        });
      }
      if (!this.fenceGroupStats.has(fence.id)) {
        this.fenceGroupStats.set(fence.id, new Map());
      }
      const wasActive = this.fenceActiveStatus.get(fence.id);
      const isActive = this.isFenceActive(fence.id);
      this.fenceActiveStatus.set(fence.id, isActive);
      if (wasActive !== undefined && wasActive !== isActive && this.onFenceStatusChange) {
        this.onFenceStatusChange({ fence_id: fence.id, fence_name: fence.name, is_active: isActive });
      }
    });
  }

  checkFenceStatusChanges() {
    const now = Date.now();
    if (now - this.lastFenceStatusCheck < 1000) return;
    this.lastFenceStatusCheck = now;
    this.fences.forEach(fence => {
      const wasActive = this.fenceActiveStatus.get(fence.id);
      const isActive = this.isFenceActive(fence.id);
      if (wasActive !== isActive) {
        this.fenceActiveStatus.set(fence.id, isActive);
        if (this.onFenceStatusChange) {
          this.onFenceStatusChange({ fence_id: fence.id, fence_name: fence.name, is_active: isActive });
        }
      }
    });
  }

  isFenceActive(fenceId, now = new Date()) {
    const override = this.activationOverrides.get(fenceId);
    if (override) {
      if (override.expires_at && new Date(override.expires_at) < now) {
        this.activationOverrides.delete(fenceId);
        FenceActivationOverrideModel.clearOverride(fenceId).catch(console.error);
      } else {
        return override.is_active === 1;
      }
    }
    const tw = this.timeWindows.get(fenceId);
    if (!tw) return true;
    if (tw.mode === 'all_day') return true;
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (tw.mode === 'time_range') {
      return this.isTimeInRange(currentTime, tw.start_time, tw.end_time);
    }
    if (tw.mode === 'weekday_time') {
      const weekday = now.getDay();
      const weekdays = tw.weekdays || [];
      if (!weekdays.includes(weekday)) return false;
      return this.isTimeInRange(currentTime, tw.start_time, tw.end_time);
    }
    return true;
  }

  isTimeInRange(currentTime, startTime, endTime) {
    if (!startTime || !endTime) return true;
    const current = this.timeToMinutes(currentTime);
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);
    if (start <= end) {
      return current >= start && current <= end;
    } else {
      return current >= start || current <= end;
    }
  }

  timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  async getTargetGroup(targetId) {
    return await TargetBindingModel.getBinding(targetId);
  }

  matchAlertRule(fenceId, groupId) {
    const rules = this.alertRules.get(fenceId) || [];
    let matchedRule = rules.find(r => r.group_id === String(groupId));
    if (!matchedRule) {
      matchedRule = rules.find(r => r.group_id === 'default');
    }
    return matchedRule;
  }

  async processPositionUpdate(targetUpdate) {
    this.checkFenceStatusChanges();
    const { id: targetId, name: targetName, lng, lat, timestamp } = targetUpdate;
    const point = { lng, lat };
    if (!this.targetStates.has(targetId)) {
      this.targetStates.set(targetId, new Map());
    }
    const prevStates = this.targetStates.get(targetId);
    const groupBinding = await this.getTargetGroup(targetId);
    const groupId = groupBinding ? groupBinding.group_id : null;
    const groupName = groupBinding ? groupBinding.group_name : null;
    this.fences.forEach(fence => {
      const wasInside = prevStates.get(fence.id) || false;
      const isActive = this.isFenceActive(fence.id);
      const isInside = isActive && pointInPolygon(point, fence.vertices);
      prevStates.set(fence.id, isInside);
      const stats = this.fenceStats.get(fence.id);
      const groupStats = this.fenceGroupStats.get(fence.id);
      if (!groupStats.has(groupId || 'nogroup')) {
        groupStats.set(groupId || 'nogroup', {
          currentTargets: new Set(),
          todayEnterCount: 0,
          todayLeaveCount: 0,
          totalStayDuration: 0,
          stayCount: 0
        });
      }
      const gs = groupStats.get(groupId || 'nogroup');
      if (!wasInside && isInside) {
        this.handleEnter(targetId, targetName, fence, lng, lat, timestamp, stats, gs, groupId, groupName);
      } else if (wasInside && !isInside) {
        this.handleLeave(targetId, targetName, fence, lng, lat, timestamp, stats, gs, groupId, groupName);
      }
    });
  }

  async handleEnter(targetId, targetName, fence, lng, lat, timestamp, stats, groupStats, groupId, groupName) {
    stats.currentTargets.add(targetId);
    stats.todayEnterCount++;
    if (groupStats) {
      groupStats.currentTargets.add(targetId);
      groupStats.todayEnterCount++;
    }
    const enterKey = `${targetId}_${fence.id}`;
    this.enterTimes.set(enterKey, timestamp);
    const rule = this.matchAlertRule(fence.id, groupId);
    let level = 'warning';
    let shouldAlert = true;
    let ruleId = null;
    let customMessage = null;
    if (rule) {
      level = rule.enter_level;
      ruleId = rule.id;
      shouldAlert = level !== 'none';
      if (rule.message_template) {
        customMessage = this.renderMessageTemplate(rule.message_template, {
          target_name: targetName,
          fence_name: fence.name,
          time: new Date(timestamp).toLocaleString(),
          event_type: 'enter'
        });
      }
    } else {
      if (fence.type === 'forbidden_enter') {
        level = 'critical';
      } else if (fence.type === 'normal') {
        level = 'warning';
      } else {
        shouldAlert = false;
      }
    }
    if (shouldAlert) {
      const alert = await AlertModel.create({
        target_id: targetId,
        target_name: targetName,
        fence_id: fence.id,
        fence_name: fence.name,
        event_type: 'enter',
        level,
        lng,
        lat,
        rule_id: ruleId,
        group_id: groupId,
        group_name: groupName,
        custom_message: customMessage
      });
      if (this.onAlert) {
        this.onAlert({
          ...alert,
          timestamp: new Date(alert.timestamp).getTime(),
          rule_id: ruleId,
          group_id: groupId,
          group_name: groupName,
          custom_message: customMessage
        });
      }
    }
    this.executeActions(fence.id, targetId, targetName, 'enter', groupId, timestamp, new Set([fence.id]));
  }

  async handleLeave(targetId, targetName, fence, lng, lat, timestamp, stats, groupStats, groupId, groupName) {
    stats.currentTargets.delete(targetId);
    stats.todayLeaveCount++;
    if (groupStats) {
      groupStats.currentTargets.delete(targetId);
      groupStats.todayLeaveCount++;
    }
    const enterKey = `${targetId}_${fence.id}`;
    const enterTime = this.enterTimes.get(enterKey);
    if (enterTime) {
      const stayDuration = (timestamp - enterTime) / 1000;
      stats.totalStayDuration += stayDuration;
      stats.stayCount++;
      if (groupStats) {
        groupStats.totalStayDuration += stayDuration;
        groupStats.stayCount++;
      }
      this.enterTimes.delete(enterKey);
    }
    const rule = this.matchAlertRule(fence.id, groupId);
    let level = 'warning';
    let shouldAlert = true;
    let ruleId = null;
    let customMessage = null;
    if (rule) {
      level = rule.leave_level;
      ruleId = rule.id;
      shouldAlert = level !== 'none';
      if (rule.message_template) {
        customMessage = this.renderMessageTemplate(rule.message_template, {
          target_name: targetName,
          fence_name: fence.name,
          time: new Date(timestamp).toLocaleString(),
          event_type: 'leave'
        });
      }
    } else {
      if (fence.type === 'forbidden_leave') {
        level = 'critical';
      } else if (fence.type === 'normal') {
        level = 'warning';
      } else {
        shouldAlert = false;
      }
    }
    if (shouldAlert) {
      const alert = await AlertModel.create({
        target_id: targetId,
        target_name: targetName,
        fence_id: fence.id,
        fence_name: fence.name,
        event_type: 'leave',
        level,
        lng,
        lat,
        rule_id: ruleId,
        group_id: groupId,
        group_name: groupName,
        custom_message: customMessage
      });
      if (this.onAlert) {
        this.onAlert({
          ...alert,
          timestamp: new Date(alert.timestamp).getTime(),
          rule_id: ruleId,
          group_id: groupId,
          group_name: groupName,
          custom_message: customMessage
        });
      }
    }
    this.executeActions(fence.id, targetId, targetName, 'leave', groupId, timestamp, new Set([fence.id]));
    await FenceActivationOverrideModel.clearBySourceAndTarget(fence.id, targetId);
    this.activationOverrides.forEach((ov, fid) => {
      if (ov.source_fence_id === fence.id && ov.target_id === targetId) {
        this.activationOverrides.delete(fid);
        const wasActive = this.fenceActiveStatus.get(fid);
        const isActive = this.isFenceActive(fid);
        this.fenceActiveStatus.set(fid, isActive);
        if (wasActive !== isActive && this.onFenceStatusChange) {
          this.onFenceStatusChange({ fence_id: fid, is_active: isActive });
        }
      }
    });
  }

  renderMessageTemplate(template, data) {
    return template.replace(/{(\w+)}/g, (_, key) => data[key] !== undefined ? data[key] : `{${key}}`);
  }

  async executeActions(fenceId, targetId, targetName, eventType, groupId, timestamp, chainSet) {
    const actions = this.fenceActions.get(fenceId) || [];
    for (const action of actions) {
      if (action.trigger_condition !== 'both' && action.trigger_condition !== eventType) continue;
      if (action.target_group_id && action.target_group_id !== String(groupId) && action.target_group_id !== 'all') continue;
      switch (action.action_type) {
        case 'webhook':
          this.executeWebhook(action, targetId, targetName, eventType, timestamp);
          break;
        case 'speed_limit':
          this.executeSpeedLimit(action, targetId, targetName, eventType, timestamp);
          break;
        case 'fence_activate':
          await this.executeFenceActivate(action, targetId, targetName, eventType, groupId, timestamp, chainSet);
          break;
      }
    }
  }

  executeWebhook(action, targetId, targetName, eventType, timestamp) {
    const config = action.action_config;
    const payload = {
      action_id: action.id,
      fence_id: action.fence_id,
      target_id: targetId,
      target_name: targetName,
      event_type: eventType,
      timestamp: timestamp,
      data: config.data || {}
    };
    const parsedUrl = url.parse(config.url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers || {})
      },
      timeout: 3000
    };
    const req = protocol.request(options, (res) => {
      console.log(`[Webhook] ${config.url} 响应: ${res.statusCode}`);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error(`[Webhook] ${config.url} 请求超时`);
    });
    req.on('error', (err) => {
      console.error(`[Webhook] ${config.url} 请求失败:`, err.message);
    });
    req.write(JSON.stringify(payload));
    req.end();
  }

  executeSpeedLimit(action, targetId, targetName, eventType, timestamp) {
    const config = action.action_config;
    console.log(`[SpeedLimit] 目标 ${targetName}(${targetId}) ${eventType} 围栏 ${action.fence_id}, 限速: ${config.speed_limit} km/h`);
    if (this.onAlert) {
      this.onAlert({
        type: 'speed_limit',
        target_id: targetId,
        target_name: targetName,
        fence_id: action.fence_id,
        speed_limit: config.speed_limit,
        event_type: eventType,
        timestamp: timestamp
      });
    }
  }

  async executeFenceActivate(action, targetId, targetName, eventType, groupId, timestamp, chainSet) {
    const config = action.action_config;
    const targetFenceId = config.target_fence_id;
    const activate = config.activate !== false;
    if (chainSet.has(targetFenceId)) {
      console.warn(`[FenceActivate] 检测到循环触发，源围栏: ${action.fence_id}, 目标围栏: ${targetFenceId}, 已中止`);
      if (this.onAlert) {
        this.onAlert({
          type: 'cycle_warning',
          source_fence_id: action.fence_id,
          target_fence_id: targetFenceId,
          target_id: targetId,
          message: '检测到围栏联动循环触发，已中止',
          timestamp: timestamp
        });
      }
      return;
    }
    chainSet.add(targetFenceId);
    const expiresAt = config.duration_seconds ? new Date(timestamp + config.duration_seconds * 1000) : null;
    await FenceActivationOverrideModel.setOverride(targetFenceId, activate, action.fence_id, targetId, expiresAt);
    this.activationOverrides.set(targetFenceId, {
      fence_id: targetFenceId,
      is_active: activate ? 1 : 0,
      source_fence_id: action.fence_id,
      target_id: targetId,
      expires_at: expiresAt
    });
    const wasActive = this.fenceActiveStatus.get(targetFenceId);
    this.fenceActiveStatus.set(targetFenceId, activate);
    if (wasActive !== activate && this.onFenceStatusChange) {
      const targetFence = this.fences.find(f => f.id === targetFenceId);
      this.onFenceStatusChange({
        fence_id: targetFenceId,
        fence_name: targetFence ? targetFence.name : `Fence ${targetFenceId}`,
        is_active: activate
      });
    }
    console.log(`[FenceActivate] 目标 ${targetName}(${targetId}) ${eventType} 围栏 ${action.fence_id}, ${activate ? '激活' : '停用'} 围栏 ${targetFenceId}`);
    if (activate && config.propagate_events !== false) {
      this.executeActions(targetFenceId, targetId, targetName, eventType, groupId, timestamp, chainSet);
    }
  }

  getStatistics() {
    return this.fences.map(fence => {
      const stats = this.fenceStats.get(fence.id);
      const avgStay = stats.stayCount > 0 ? stats.totalStayDuration / stats.stayCount : 0;
      const groupStats = this.fenceGroupStats.get(fence.id);
      const groupStatsArr = [];
      groupStats.forEach((gs, groupId) => {
        const avgStayGroup = gs.stayCount > 0 ? gs.totalStayDuration / gs.stayCount : 0;
        groupStatsArr.push({
          group_id: groupId === 'nogroup' ? null : groupId,
          current_targets: gs.currentTargets.size,
          today_enters: gs.todayEnterCount,
          today_leaves: gs.todayLeaveCount,
          avg_stay_seconds: Math.round(avgStayGroup * 10) / 10
        });
      });
      return {
        fence_id: fence.id,
        fence_name: fence.name,
        fence_type: fence.type,
        color: fence.color,
        is_active: this.fenceActiveStatus.get(fence.id),
        current_targets: stats.currentTargets.size,
        today_enters: stats.todayEnterCount,
        today_leaves: stats.todayLeaveCount,
        avg_stay_seconds: Math.round(avgStay * 10) / 10,
        group_stats: groupStatsArr
      };
    });
  }

  resetDailyStats() {
    this.fenceStats.forEach(stats => {
      stats.todayEnterCount = 0;
      stats.todayLeaveCount = 0;
      stats.totalStayDuration = 0;
      stats.stayCount = 0;
    });
    this.fenceGroupStats.forEach(groupMap => {
      groupMap.forEach(stats => {
        stats.todayEnterCount = 0;
        stats.todayLeaveCount = 0;
        stats.totalStayDuration = 0;
        stats.stayCount = 0;
      });
    });
  }

  getFenceActiveStatus(fenceId) {
    return this.fenceActiveStatus.get(fenceId);
  }

  getAllFenceStatus() {
    const result = [];
    this.fences.forEach(fence => {
      result.push({
        fence_id: fence.id,
        fence_name: fence.name,
        is_active: this.fenceActiveStatus.get(fence.id)
      });
    });
    return result;
  }
}

module.exports = { FenceEngine };
