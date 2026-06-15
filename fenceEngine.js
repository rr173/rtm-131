const { pointInPolygon } = require('./geometry');
const { FenceModel, AlertModel } = require('./database');

class FenceEngine {
  constructor(onAlert) {
    this.onAlert = onAlert;
    this.targetStates = new Map();
    this.fenceStats = new Map();
    this.enterTimes = new Map();
    this.fences = [];
  }

  async reloadFences() {
    this.fences = await FenceModel.getAll();
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
    });
  }

  processPositionUpdate(targetUpdate) {
    const { id: targetId, name: targetName, lng, lat, timestamp } = targetUpdate;
    const point = { lng, lat };
    if (!this.targetStates.has(targetId)) {
      this.targetStates.set(targetId, new Map());
    }
    const prevStates = this.targetStates.get(targetId);
    this.fences.forEach(fence => {
      const wasInside = prevStates.get(fence.id) || false;
      const isInside = pointInPolygon(point, fence.vertices);
      prevStates.set(fence.id, isInside);
      const stats = this.fenceStats.get(fence.id);
      if (!wasInside && isInside) {
        this.handleEnter(targetId, targetName, fence, lng, lat, timestamp, stats);
      } else if (wasInside && !isInside) {
        this.handleLeave(targetId, targetName, fence, lng, lat, timestamp, stats);
      }
    });
  }

  async handleEnter(targetId, targetName, fence, lng, lat, timestamp, stats) {
    stats.currentTargets.add(targetId);
    stats.todayEnterCount++;
    const enterKey = `${targetId}_${fence.id}`;
    this.enterTimes.set(enterKey, timestamp);
    let level = 'warning';
    let shouldAlert = true;
    if (fence.type === 'forbidden_enter') {
      level = 'critical';
    } else if (fence.type === 'normal') {
      level = 'warning';
    } else {
      shouldAlert = false;
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
        lat
      });
      if (this.onAlert) {
        this.onAlert({ ...alert, timestamp: new Date(alert.timestamp).getTime() });
      }
    }
  }

  async handleLeave(targetId, targetName, fence, lng, lat, timestamp, stats) {
    stats.currentTargets.delete(targetId);
    stats.todayLeaveCount++;
    const enterKey = `${targetId}_${fence.id}`;
    const enterTime = this.enterTimes.get(enterKey);
    if (enterTime) {
      const stayDuration = (timestamp - enterTime) / 1000;
      stats.totalStayDuration += stayDuration;
      stats.stayCount++;
      this.enterTimes.delete(enterKey);
    }
    let level = 'warning';
    let shouldAlert = true;
    if (fence.type === 'forbidden_leave') {
      level = 'critical';
    } else if (fence.type === 'normal') {
      level = 'warning';
    } else {
      shouldAlert = false;
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
        lat
      });
      if (this.onAlert) {
        this.onAlert({ ...alert, timestamp: new Date(alert.timestamp).getTime() });
      }
    }
  }

  getStatistics() {
    return this.fences.map(fence => {
      const stats = this.fenceStats.get(fence.id);
      const avgStay = stats.stayCount > 0 ? stats.totalStayDuration / stats.stayCount : 0;
      return {
        fence_id: fence.id,
        fence_name: fence.name,
        fence_type: fence.type,
        color: fence.color,
        current_targets: stats.currentTargets.size,
        today_enters: stats.todayEnterCount,
        today_leaves: stats.todayLeaveCount,
        avg_stay_seconds: Math.round(avgStay * 10) / 10
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
  }
}

module.exports = { FenceEngine };
