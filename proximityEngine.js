const { distance } = require('./geometry');
const {
  ProximityThresholdConfigModel,
  ProximityEventModel,
  TargetBindingModel
} = require('./database');

const DEFAULT_GLOBAL_THRESHOLD = 0.005;
const DEDUPLICATION_WINDOW_MS = 10 * 60 * 1000;

class ProximityEngine {
  constructor(onProximityEvent, onLeaveEvent, onStatusUpdate) {
    this.onProximityEvent = onProximityEvent;
    this.onLeaveEvent = onLeaveEvent;
    this.onStatusUpdate = onStatusUpdate;

    this.globalThreshold = DEFAULT_GLOBAL_THRESHOLD;
    this.groupPairThresholds = new Map();

    this.targetPositions = new Map();
    this.lastDistances = new Map();
    this.lastAlertTimes = new Map();
    this.activePairs = new Map();

    this.fenceEngine = null;
    this.targetStatusProvider = null;
  }

  setFenceEngine(fenceEngine) {
    this.fenceEngine = fenceEngine;
  }

  setTargetStatusProvider(provider) {
    this.targetStatusProvider = provider;
  }

  async init() {
    const globalCfg = await ProximityThresholdConfigModel.getGlobalConfig();
    if (globalCfg) {
      this.globalThreshold = globalCfg.threshold;
    }
    const pairCfgs = await ProximityThresholdConfigModel.getAllGroupPairConfigs();
    pairCfgs.forEach(cfg => {
      const key = this._pairKey(cfg.group_id_a, cfg.group_id_b);
      this.groupPairThresholds.set(key, cfg.threshold);
    });
    console.log(`[Proximity] 初始化完成: 全局阈值=${this.globalThreshold}, 分组对配置=${this.groupPairThresholds.size}个`);
  }

  async reloadConfigs() {
    const globalCfg = await ProximityThresholdConfigModel.getGlobalConfig();
    if (globalCfg) {
      this.globalThreshold = globalCfg.threshold;
    }
    this.groupPairThresholds.clear();
    const pairCfgs = await ProximityThresholdConfigModel.getAllGroupPairConfigs();
    pairCfgs.forEach(cfg => {
      const key = this._pairKey(cfg.group_id_a, cfg.group_id_b);
      this.groupPairThresholds.set(key, cfg.threshold);
    });
  }

  getThreshold(groupIdA, groupIdB) {
    if (groupIdA !== undefined && groupIdA !== null &&
        groupIdB !== undefined && groupIdB !== null) {
      const key = this._pairKey(groupIdA, groupIdB);
      if (this.groupPairThresholds.has(key)) {
        return this.groupPairThresholds.get(key);
      }
    }
    return this.globalThreshold;
  }

  _pairKey(a, b) {
    const x = Math.min(Number(a), Number(b));
    const y = Math.max(Number(a), Number(b));
    return `${x}_${y}`;
  }

  _targetPairKey(a, b) {
    const x = a < b ? a : b;
    const y = a < b ? b : a;
    return `${x}|${y}`;
  }

  async processPositionUpdate(position) {
    const { id: targetId, lng, lat, timestamp } = position;
    this.targetPositions.set(targetId, { ...position });

    const bindingA = await TargetBindingModel.getBinding(targetId);
    const groupIdA = bindingA ? bindingA.group_id : null;

    const results = [];

    for (const [otherId, otherPos] of this.targetPositions.entries()) {
      if (otherId === targetId) continue;

      if (this.targetStatusProvider) {
        const status = this.targetStatusProvider(otherId);
        if (status && status !== 'online') continue;
      }

      const pairKey = this._targetPairKey(targetId, otherId);
      const currentDist = distance({ lng, lat }, { lng: otherPos.lng, lat: otherPos.lat });

      const bindingB = await TargetBindingModel.getBinding(otherId);
      const groupIdB = bindingB ? bindingB.group_id : null;
      const threshold = this.getThreshold(groupIdA, groupIdB);

      const prevDist = this.lastDistances.get(pairKey);
      this.lastDistances.set(pairKey, currentDist);

      const now = timestamp || Date.now();
      const lastAlertAt = this.lastAlertTimes.get(pairKey);
      const inDedupWindow = lastAlertAt && (now - lastAlertAt) < DEDUPLICATION_WINDOW_MS;

      if (prevDist !== undefined &&
          currentDist < prevDist &&
          currentDist < threshold &&
          !inDedupWindow) {

        this.lastAlertTimes.set(pairKey, now);

        const event = await this._createProximityEvent(
          targetId, otherId,
          bindingA, bindingB,
          currentDist, prevDist, threshold,
          position, otherPos,
          now
        );

        this.activePairs.set(pairKey, event);

        if (this.onProximityEvent) {
          this.onProximityEvent(event);
        }
        if (this.onStatusUpdate) {
          this.onStatusUpdate(this.getAllActivePairs());
        }
        results.push(event);
      } else if (this.activePairs.has(pairKey) && currentDist >= threshold) {
        const existing = this.activePairs.get(pairKey);
        this.activePairs.delete(pairKey);
        if (this.onLeaveEvent) {
          this.onLeaveEvent({
            target_id_a: existing.target_id_a,
            target_name_a: existing.target_name_a,
            target_id_b: existing.target_id_b,
            target_name_b: existing.target_name_b,
            distance: currentDist,
            threshold: threshold,
            timestamp: now,
            leave_from_fence_id: existing.fence_id,
            leave_from_fence_name: existing.fence_name
          });
        }
        if (this.onStatusUpdate) {
          this.onStatusUpdate(this.getAllActivePairs());
        }
      }
    }

    return results;
  }

  async _createProximityEvent(
    targetIdA, targetIdB,
    bindingA, bindingB,
    currentDist, prevDist, threshold,
    posA, posB,
    timestamp
  ) {
    let fenceId = null;
    let fenceName = null;
    let fenceType = null;
    let isConfrontation = false;
    let level = 'info';

    if (this.fenceEngine) {
      const commonFences = this._findCommonFences(posA, posB);
      if (commonFences.length > 0) {
        const f = commonFences[0];
        fenceId = f.id;
        fenceName = f.name;
        fenceType = f.type;
      }

      if (bindingA && bindingB && bindingA.group_id !== bindingB.group_id && fenceId !== null) {
        isConfrontation = true;
        level = fenceType === 'forbidden_enter' ? 'critical' : 'warning';
      }
    }

    const data = {
      target_id_a: targetIdA,
      target_name_a: posA.name,
      target_id_b: targetIdB,
      target_name_b: posB.name,
      group_id_a: bindingA ? bindingA.group_id : null,
      group_name_a: bindingA ? bindingA.group_name : null,
      group_id_b: bindingB ? bindingB.group_id : null,
      group_name_b: bindingB ? bindingB.group_name : null,
      distance: currentDist,
      prev_distance: prevDist,
      threshold: threshold,
      is_confrontation: isConfrontation,
      fence_id: fenceId,
      fence_name: fenceName,
      fence_type: fenceType,
      level: level,
      lng_a: posA.lng,
      lat_a: posA.lat,
      lng_b: posB.lng,
      lat_b: posB.lat,
      timestamp: timestamp
    };

    const saved = await ProximityEventModel.create(data);
    return saved;
  }

  _findCommonFences(posA, posB) {
    if (!this.fenceEngine || !this.fenceEngine.fences) return [];
    const common = [];
    for (const fence of this.fenceEngine.fences) {
      const inA = this._isTargetInFence(posA, fence);
      const inB = this._isTargetInFence(posB, fence);
      if (inA && inB) {
        common.push(fence);
      }
    }
    return common;
  }

  _isTargetInFence(pos, fence) {
    if (!this.fenceEngine || !this.fenceEngine.targetStates) return false;
    const fenceMap = this.fenceEngine.targetStates.get(pos.id);
    if (fenceMap) {
      const inside = fenceMap.get(fence.id);
      if (inside !== undefined) return inside;
    }
    const { pointInPolygon } = require('./geometry');
    return pointInPolygon({ lng: pos.lng, lat: pos.lat }, fence.vertices);
  }

  getAllActivePairs() {
    const result = [];
    for (const event of this.activePairs.values()) {
      result.push({
        id: event.id,
        target_id_a: event.target_id_a,
        target_name_a: event.target_name_a,
        target_id_b: event.target_id_b,
        target_name_b: event.target_name_b,
        group_id_a: event.group_id_a,
        group_name_a: event.group_name_a,
        group_id_b: event.group_id_b,
        group_name_b: event.group_name_b,
        distance: event.distance,
        threshold: event.threshold,
        is_confrontation: event.is_confrontation,
        fence_id: event.fence_id,
        fence_name: event.fence_name,
        fence_type: event.fence_type,
        level: event.level,
        lng_a: event.lng_a,
        lat_a: event.lat_a,
        lng_b: event.lng_b,
        lat_b: event.lat_b,
        timestamp: event.timestamp
      });
    }
    return result;
  }

  removeTarget(targetId) {
    this.targetPositions.delete(targetId);
    const toRemove = [];
    for (const key of this.lastDistances.keys()) {
      if (key.includes(targetId)) toRemove.push(key);
    }
    toRemove.forEach(k => this.lastDistances.delete(k));
    for (const key of this.lastAlertTimes.keys()) {
      if (key.includes(targetId)) toRemove.push(key);
    }
    toRemove.forEach(k => this.lastAlertTimes.delete(k));
    for (const key of this.activePairs.keys()) {
      if (key.includes(targetId)) toRemove.push(key);
    }
    toRemove.forEach(k => this.activePairs.delete(k));
  }
}

module.exports = { ProximityEngine };
