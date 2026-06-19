const { TrajectoryModel } = require('./database');
const WebSocket = require('ws');

class ReplayManager {
  constructor(broadcastFn, getTargetStateFn, getBindingFn) {
    this.broadcast = broadcastFn;
    this.getTargetState = getTargetStateFn;
    this.getBinding = getBindingFn;
    this.currentReplay = null;
    this.replayTimer = null;
    this.paused = false;
  }

  isReplaying() {
    return this.currentReplay !== null;
  }

  getCurrentReplay() {
    if (!this.currentReplay) return null;
    const { target_id, start_time, end_time, speed, points, currentIndex, totalPoints } = this.currentReplay;
    const currentPoint = points[currentIndex];
    const progress = totalPoints > 0 ? (currentIndex / totalPoints) * 100 : 0;
    return {
      target_id,
      start_time,
      end_time,
      speed,
      current_time: currentPoint ? currentPoint.timestamp : start_time,
      current_index: currentIndex,
      total_points: totalPoints,
      progress_percent: Math.round(progress * 100) / 100,
      is_paused: this.paused,
      is_running: !this.paused && this.currentReplay !== null
    };
  }

  async startReplay({ target_id, start_time, end_time, speed = 1 }) {
    if (this.currentReplay) {
      throw new Error('当前已有回放任务在进行中，请先停止');
    }

    const points = await TrajectoryModel.query({
      target_id,
      start_time,
      end_time,
      limit: 100000
    });

    if (points.length === 0) {
      throw new Error('该时间范围内没有轨迹数据');
    }

    const validSpeeds = [1, 2, 5, 10];
    const actualSpeed = validSpeeds.includes(speed) ? speed : 1;

    this.currentReplay = {
      target_id,
      start_time,
      end_time,
      speed: actualSpeed,
      points,
      currentIndex: 0,
      totalPoints: points.length,
      suspendedTargets: new Set()
    };

    this.paused = false;
    this.startReplayLoop();

    const status = this.getCurrentReplay();
    this.broadcast({ type: 'replay_started', data: status });

    return status;
  }

  startReplayLoop() {
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
    }

    const baseInterval = 1000;
    const interval = baseInterval / this.currentReplay.speed;

    this.replayTimer = setInterval(() => {
      if (this.paused || !this.currentReplay) return;
      this.tick();
    }, interval);
  }

  tick() {
    if (!this.currentReplay) return;

    const { points, currentIndex, target_id } = this.currentReplay;

    if (currentIndex >= points.length) {
      this.stopReplay();
      return;
    }

    const point = points[currentIndex];
    const binding = this.getBinding ? this.getBinding(target_id) : null;

    const replayPoint = {
      id: target_id,
      name: point.target_name || target_id,
      color: point.color || '#3498db',
      lng: point.lng,
      lat: point.lat,
      bearing: point.bearing || 0,
      timestamp: point.timestamp,
      group_id: point.group_id || null,
      group_name: point.group_name || null,
      group_color: point.group_color || null,
      is_replay: true
    };

    this.broadcast({
      type: 'replay_position',
      data: replayPoint
    });

    if (currentIndex % 10 === 0 || currentIndex === points.length - 1) {
      const status = this.getCurrentReplay();
      this.broadcast({ type: 'replay_progress', data: status });
    }

    this.currentReplay.currentIndex++;
  }

  pauseReplay() {
    if (!this.currentReplay) {
      throw new Error('当前没有进行中的回放');
    }
    this.paused = true;
    const status = this.getCurrentReplay();
    this.broadcast({ type: 'replay_paused', data: status });
    return status;
  }

  resumeReplay() {
    if (!this.currentReplay) {
      throw new Error('当前没有进行中的回放');
    }
    if (!this.paused) {
      return this.getCurrentReplay();
    }
    this.paused = false;
    const status = this.getCurrentReplay();
    this.broadcast({ type: 'replay_resumed', data: status });
    return status;
  }

  seekToIndex(index) {
    if (!this.currentReplay) {
      throw new Error('当前没有进行中的回放');
    }
    const { points } = this.currentReplay;
    const safeIndex = Math.max(0, Math.min(index, points.length - 1));
    this.currentReplay.currentIndex = safeIndex;

    const point = points[safeIndex];
    const replayPoint = {
      id: this.currentReplay.target_id,
      name: point.target_name || this.currentReplay.target_id,
      lng: point.lng,
      lat: point.lat,
      bearing: point.bearing || 0,
      timestamp: point.timestamp,
      group_id: point.group_id || null,
      group_name: point.group_name || null,
      is_replay: true
    };

    this.broadcast({
      type: 'replay_position',
      data: replayPoint
    });

    const status = this.getCurrentReplay();
    this.broadcast({ type: 'replay_progress', data: status });
    return status;
  }

  setSpeed(speed) {
    if (!this.currentReplay) {
      throw new Error('当前没有进行中的回放');
    }
    const validSpeeds = [1, 2, 5, 10];
    const actualSpeed = validSpeeds.includes(speed) ? speed : 1;
    this.currentReplay.speed = actualSpeed;
    this.startReplayLoop();

    const status = this.getCurrentReplay();
    this.broadcast({ type: 'replay_speed_changed', data: status });
    return status;
  }

  stopReplay() {
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }

    if (!this.currentReplay) {
      return { success: true, message: '当前没有进行中的回放' };
    }

    const targetId = this.currentReplay.target_id;
    this.currentReplay = null;
    this.paused = false;

    this.broadcast({
      type: 'replay_stopped',
      data: { target_id: targetId }
    });

    return { success: true, target_id: targetId };
  }

  isTargetInReplay(targetId) {
    return this.currentReplay && this.currentReplay.target_id === targetId;
  }
}

module.exports = { ReplayManager };
