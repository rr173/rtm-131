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
    this.pendingPairs = new Set();

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
    let statusChanged = false;

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

      const isBelowThreshold = currentDist < threshold;
      const wasBelowThreshold = this.activePairs.has(pairKey);
      const isConverging = prevDist !== undefined && currentDist < prevDist;

      if (isBelowThreshold) {
        if (!wasBelowThreshold && !this.pendingPairs.has(pairKey)) {
          this.pendingPairs.add(pairKey);
          try {
            const event = await this._createProximityEvent(
              targetId, otherId,
              bindingA, bindingB,
              currentDist, prevDist, threshold,
              position, otherPos,
              now
            );
            this.activePairs.set(pairKey, event);
            this.lastAlertTimes.set(pairKey, now);
            results.push(event);
            statusChanged = true;
            if (this.onProximityEvent) {
              this.onProximityEvent(event);
            }
          } finally {
            this.pendingPairs.delete(pairKey);
          }
        } else if (wasBelowThreshold) {
          const existing = this.activePairs.get(pairKey);
          const updated = {
            ...existing,
            distance: currentDist,
            lng_a: position.lng,
            lat_a: position.lat,
            lng_b: otherPos.lng,
            lat_b: otherPos.lat,
            timestamp: now
          };
          this.activePairs.set(pairKey, updated);
        }

        if (isConverging && !inDedupWindow && wasBelowThreshold && !this.pendingPairs.has(pairKey)) {
          this.pendingPairs.add(pairKey);
          try {
            this.lastAlertTimes.set(pairKey, now);
            const event = await this._createProximityEvent(
              targetId, otherId,
              bindingA, bindingB,
              currentDist, prevDist, threshold,
              position, otherPos,
              now
            );
            results.push(event);
            if (this.onProximityEvent) {
              this.onProximityEvent(event);
            }
          } finally {
            this.pendingPairs.delete(pairKey);
          }
        }
      } else if (wasBelowThreshold) {
        const existing = this.activePairs.get(pairKey);
        this.activePairs.delete(pairKey);
        statusChanged = true;
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
      }
    }

    if (statusChanged && this.onStatusUpdate) {
      this.onStatusUpdate(this.getAllActivePairs());
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
    let finalTargetIdA = targetIdA;
    let finalTargetIdB = targetIdB;
    let finalBindingA = bindingA;
    let finalBindingB = bindingB;
    let finalPosA = posA;
    let finalPosB = posB;

    if (targetIdA > targetIdB) {
      finalTargetIdA = targetIdB;
      finalTargetIdB = targetIdA;
      finalBindingA = bindingB;
      finalBindingB = bindingA;
      finalPosA = posB;
      finalPosB = posA;
    }

    let fenceId = null;
    let fenceName = null;
    let fenceType = null;
    let isConfrontation = false;
    let level = 'info';

    if (this.fenceEngine) {
      const commonFences = this._findCommonFences(finalPosA, finalPosB);
      if (commonFences.length > 0) {
        const f = commonFences[0];
        fenceId = f.id;
        fenceName = f.name;
        fenceType = f.type;
      }

      if (finalBindingA && finalBindingB && finalBindingA.group_id !== finalBindingB.group_id && fenceId !== null) {
        isConfrontation = true;
        level = fenceType === 'forbidden_enter' ? 'critical' : 'warning';
      }
    }

    const data = {
      target_id_a: finalTargetIdA,
      target_name_a: finalPosA.name,
      target_id_b: finalTargetIdB,
      target_name_b: finalPosB.name,
      group_id_a: finalBindingA ? finalBindingA.group_id : null,
      group_name_a: finalBindingA ? finalBindingA.group_name : null,
      group_id_b: finalBindingB ? finalBindingB.group_id : null,
      group_name_b: finalBindingB ? finalBindingB.group_name : null,
      distance: currentDist,
      prev_distance: prevDist,
      threshold: threshold,
      is_confrontation: isConfrontation,
      fence_id: fenceId,
      fence_name: fenceName,
      fence_type: fenceType,
      level: level,
      lng_a: finalPosA.lng,
      lat_a: finalPosA.lat,
      lng_b: finalPosB.lng,
      lat_b: finalPosB.lat,
      timestamp: timestamp
    };

    const saved = await ProximityEventModel.create(data);
    return saved;
  }

  _findCommonFences(posA, posB) {
    if (!this.fenceEngine || !this.fenceEngine.fences) return [];
    const common = [];
    const now = new Date();
    for (const fence of this.fenceEngine.fences) {
      if (!this.fenceEngine.isFenceActive(fence.id, now)) continue;
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
