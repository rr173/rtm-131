const { distance } = require('./geometry');
const { pointInPolygon } = require('./geometry');
const { FormationModel, FormationMemberModel, FormationEventModel, FenceModel } = require('./database');

class FormationEngine {
  constructor(onFormationEvent, onFormationUpdate) {
    this.onFormationEvent = onFormationEvent;
    this.onFormationUpdate = onFormationUpdate;
    this.formations = new Map();
    this.memberDetachStatus = new Map();
    this.memberPositions = new Map();
    this.targetStatusProvider = null;
    this.spreadRadiusSamples = new Map();
  }

  setTargetStatusProvider(provider) {
    this.targetStatusProvider = provider;
  }

  async init() {
    await this.reloadFormations();
  }

  async reloadFormations() {
    const allFormations = await FormationModel.getAll();
    this.formations.clear();
    this.memberDetachStatus.clear();
    this.memberPositions.clear();
    this.spreadRadiusSamples.clear();

    for (const formation of allFormations) {
      if (formation.status === 'dissolved') continue;
      const members = await FormationMemberModel.getByFormationId(formation.id);
      this.formations.set(formation.id, {
        ...formation,
        members: members.map(m => ({
          target_id: m.target_id,
          target_name: m.target_name
        }))
      });
      for (const m of members) {
        const key = `${formation.id}_${m.target_id}`;
        this.memberDetachStatus.set(key, false);
      }
      this.spreadRadiusSamples.set(formation.id, { total: 0, count: 0 });
    }
    console.log(`[Formation] 已加载 ${this.formations.size} 个编队`);
  }

  async createFormation({ name, target_ids, radius_threshold, activate, route_fence_ids }) {
    if (!name || !Array.isArray(target_ids) || target_ids.length < 2) {
      throw new Error('编队名称和至少2个目标ID是必填项');
    }

    const existing = await FormationModel.getByName(name);
    if (existing) {
      throw new Error(`编队名称 "${name}" 已存在`);
    }

    for (const tid of target_ids) {
      const existingMember = await FormationMemberModel.getByTargetId(tid);
      if (existingMember) {
        const existingFormation = await FormationModel.getById(existingMember.formation_id);
        throw new Error(`目标 ${tid} 已在编队 "${existingFormation ? existingFormation.name : existingMember.formation_id}" 中，一个目标只能属于一个编队`);
      }
    }

    const status = activate ? 'monitoring' : 'inactive';
    const formation = await FormationModel.create({
      name,
      radius_threshold: radius_threshold || 0.01,
      status,
      route_fence_ids: route_fence_ids || null
    });

    const { getPresetTargets } = require('./gpsSimulator');
    const presetTargets = getPresetTargets();
    const members = [];
    for (const tid of target_ids) {
      const preset = presetTargets.find(t => t.id === tid);
      members.push({
        target_id: tid,
        target_name: preset ? preset.name : tid
      });
    }

    await FormationMemberModel.batchCreate(formation.id, members);
    const dbMembers = await FormationMemberModel.getByFormationId(formation.id);

    const now = Date.now();
    this.formations.set(formation.id, {
      ...formation,
      members: dbMembers.map(m => ({
        target_id: m.target_id,
        target_name: m.target_name
      }))
    });

    for (const m of dbMembers) {
      const key = `${formation.id}_${m.target_id}`;
      this.memberDetachStatus.set(key, false);
    }
    this.spreadRadiusSamples.set(formation.id, { total: 0, count: 0 });

    if (activate) {
      await FormationModel.update(formation.id, { activated_at: now, status: 'monitoring' });
      const updated = await FormationModel.getById(formation.id);
      this.formations.set(formation.id, {
        ...updated,
        members: dbMembers.map(m => ({
          target_id: m.target_id,
          target_name: m.target_name
        }))
      });
    }

    const result = this.getFormationDetail(formation.id);
    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_created',
        formation: result
      });
    }
    console.log(`[Formation] 创建编队 "${name}"(${formation.id})，状态: ${status}，成员: ${target_ids.join(',')}`);
    return result;
  }

  async activateFormation(formationId) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }
    if (formation.status === 'monitoring') {
      throw new Error('编队已在监控中');
    }
    if (formation.status === 'dissolved') {
      throw new Error('编队已解散，无法激活');
    }

    const now = Date.now();
    await FormationModel.update(formationId, { status: 'monitoring', activated_at: now });
    formation.status = 'monitoring';
    formation.activated_at = now;

    for (const m of formation.members) {
      const key = `${formationId}_${m.target_id}`;
      this.memberDetachStatus.set(key, false);
    }

    const result = this.getFormationDetail(formationId);
    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_activated',
        formation: result
      });
    }
    console.log(`[Formation] 编队 "${formation.name}"(${formationId}) 已激活监控`);
    return result;
  }

  async deactivateFormation(formationId) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }
    if (formation.status !== 'monitoring') {
      throw new Error('只有监控中的编队可以停用');
    }

    await FormationModel.update(formationId, { status: 'inactive' });
    formation.status = 'inactive';

    for (const m of formation.members) {
      const key = `${formationId}_${m.target_id}`;
      this.memberDetachStatus.set(key, false);
    }

    const result = this.getFormationDetail(formationId);
    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_deactivated',
        formation: result
      });
    }
    console.log(`[Formation] 编队 "${formation.name}"(${formationId}) 已停用`);
    return result;
  }

  async dissolveFormation(formationId) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }
    if (formation.status === 'dissolved') {
      throw new Error('编队已解散');
    }

    const now = Date.now();
    await FormationModel.update(formationId, { status: 'dissolved', dissolved_at: now });
    await FormationMemberModel.deleteByFormationId(formationId);

    for (const m of formation.members) {
      const key = `${formationId}_${m.target_id}`;
      this.memberDetachStatus.delete(key);
      this.memberPositions.delete(`${formationId}_${m.target_id}`);
    }
    this.formations.delete(formationId);
    this.spreadRadiusSamples.delete(formationId);

    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_dissolved',
        formation_id: formationId,
        formation_name: formation.name
      });
    }
    console.log(`[Formation] 编队 "${formation.name}"(${formationId}) 已解散`);
    return { formation_id: formationId, formation_name: formation.name, status: 'dissolved', dissolved_at: now };
  }

  async addMember(formationId, targetId, targetName) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }
    if (formation.status === 'dissolved') {
      throw new Error('已解散的编队不能添加成员');
    }

    const existingMember = await FormationMemberModel.getByTargetId(targetId);
    if (existingMember) {
      const existingFormation = await FormationModel.getById(existingMember.formation_id);
      throw new Error(`目标 ${targetId} 已在编队 "${existingFormation ? existingFormation.name : existingMember.formation_id}" 中`);
    }

    const { getPresetTargets } = require('./gpsSimulator');
    const presetTargets = getPresetTargets();
    const preset = presetTargets.find(t => t.id === targetId);

    await FormationMemberModel.create({
      formation_id: formationId,
      target_id: targetId,
      target_name: targetName || (preset ? preset.name : targetId)
    });

    formation.members.push({
      target_id: targetId,
      target_name: targetName || (preset ? preset.name : targetId)
    });

    const key = `${formationId}_${targetId}`;
    this.memberDetachStatus.set(key, false);

    const result = this.getFormationDetail(formationId);
    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_member_added',
        formation: result
      });
    }
    return result;
  }

  async removeMember(formationId, targetId) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }

    const memberIndex = formation.members.findIndex(m => m.target_id === targetId);
    if (memberIndex === -1) {
      throw new Error(`目标 ${targetId} 不在该编队中`);
    }

    await FormationMemberModel.deleteByTargetId(targetId);
    formation.members.splice(memberIndex, 1);

    const key = `${formationId}_${targetId}`;
    this.memberDetachStatus.delete(key);
    this.memberPositions.delete(key);

    const result = this.getFormationDetail(formationId);
    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_member_removed',
        formation: result
      });
    }
    return result;
  }

  async setRoute(formationId, fenceIds) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }
    if (!Array.isArray(fenceIds) || fenceIds.length === 0) {
      throw new Error('路线围栏列表不能为空');
    }

    for (const fid of fenceIds) {
      const fence = await FenceModel.getById(fid);
      if (!fence) {
        throw new Error(`围栏 ${fid} 不存在`);
      }
    }

    const routeProgress = fenceIds.map(() => false);
    await FormationModel.update(formationId, {
      route_fence_ids: fenceIds,
      route_progress: routeProgress
    });

    formation.route_fence_ids = fenceIds;
    formation.route_progress = routeProgress;

    const result = this.getFormationDetail(formationId);
    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_route_set',
        formation: result
      });
    }
    return result;
  }

  async processPositionUpdate(position) {
    const { id: targetId, lng, lat, timestamp } = position;

    for (const [formationId, formation] of this.formations.entries()) {
      if (formation.status !== 'monitoring') continue;

      const isMember = formation.members.some(m => m.target_id === targetId);
      if (!isMember) continue;

      const posKey = `${formationId}_${targetId}`;
      this.memberPositions.set(posKey, { lng, lat, timestamp });

      await this._evaluateFormation(formationId, timestamp);
    }
  }

  async _evaluateFormation(formationId, timestamp) {
    const formation = this.formations.get(formationId);
    if (!formation || formation.status !== 'monitoring') return;

    const onlineMembers = [];
    for (const m of formation.members) {
      const posKey = `${formationId}_${m.target_id}`;
      const pos = this.memberPositions.get(posKey);
      const isOnline = this.targetStatusProvider
        ? this.targetStatusProvider(m.target_id) === 'online'
        : !!pos;
      if (isOnline && pos) {
        onlineMembers.push({ ...m, lng: pos.lng, lat: pos.lat });
      }
    }

    if (onlineMembers.length < 2) return;

    const center = this._calculateCenter(onlineMembers);
    const spreadRadius = this._calculateSpreadRadius(onlineMembers, center);

    const samples = this.spreadRadiusSamples.get(formationId);
    if (samples) {
      samples.total += spreadRadius;
      samples.count += 1;
    }

    const memberStatuses = [];
    for (const m of onlineMembers) {
      const dist = distance({ lng: center.lng, lat: center.lat }, { lng: m.lng, lat: m.lat });
      const isDetached = dist > formation.radius_threshold;
      const detachKey = `${formationId}_${m.target_id}`;
      const wasDetached = this.memberDetachStatus.get(detachKey) || false;

      if (isDetached && !wasDetached) {
        this.memberDetachStatus.set(detachKey, true);
        const event = await FormationEventModel.create({
          formation_id: formationId,
          formation_name: formation.name,
          target_id: m.target_id,
          target_name: m.target_name,
          event_type: 'detached',
          center_lng: center.lng,
          center_lat: center.lat,
          member_lng: m.lng,
          member_lat: m.lat,
          deviation: dist,
          timestamp
        });
        if (this.onFormationEvent) {
          this.onFormationEvent({
            type: 'formation_detached',
            ...event,
            timestamp: event.timestamp
          });
        }
        console.log(`[Formation] ${m.target_name}(${m.target_id}) 掉队，偏离 ${dist.toFixed(5)}°，阈值 ${formation.radius_threshold}`);
      } else if (!isDetached && wasDetached) {
        this.memberDetachStatus.set(detachKey, false);
        const event = await FormationEventModel.create({
          formation_id: formationId,
          formation_name: formation.name,
          target_id: m.target_id,
          target_name: m.target_name,
          event_type: 'returned',
          center_lng: center.lng,
          center_lat: center.lat,
          member_lng: m.lng,
          member_lat: m.lat,
          deviation: dist,
          timestamp
        });
        if (this.onFormationEvent) {
          this.onFormationEvent({
            type: 'formation_returned',
            ...event,
            timestamp: event.timestamp
          });
        }
        console.log(`[Formation] ${m.target_name}(${m.target_id}) 归队`);
      }

      memberStatuses.push({
        target_id: m.target_id,
        target_name: m.target_name,
        lng: m.lng,
        lat: m.lat,
        distance_from_center: Math.round(dist * 100000) / 100000,
        is_detached: isDetached
      });
    }

    await this._checkRouteArrival(formationId, center);

    const update = {
      formation_id: formationId,
      formation_name: formation.name,
      status: formation.status,
      center: { lng: Math.round(center.lng * 100000) / 100000, lat: Math.round(center.lat * 100000) / 100000 },
      radius_threshold: formation.radius_threshold,
      spread_radius: Math.round(spreadRadius * 100000) / 100000,
      online_members: onlineMembers.length,
      total_members: formation.members.length,
      member_statuses: memberStatuses,
      timestamp
    };

    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_status',
        ...update
      });
    }
  }

  async _checkRouteArrival(formationId, center) {
    const formation = this.formations.get(formationId);
    if (!formation || !formation.route_fence_ids || formation.route_fence_ids.length === 0) return;

    let changed = false;
    const currentProgress = formation.route_progress || formation.route_fence_ids.map(() => false);

    for (let i = 0; i < formation.route_fence_ids.length; i++) {
      if (currentProgress[i]) continue;

      const fence = await FenceModel.getById(formation.route_fence_ids[i]);
      if (!fence) continue;

      if (pointInPolygon({ lng: center.lng, lat: center.lat }, fence.vertices)) {
        currentProgress[i] = true;
        changed = true;
        console.log(`[Formation] 编队 "${formation.name}" 中心到达路线围栏 "${fence.name}"`);
      }
    }

    if (changed) {
      await FormationModel.update(formationId, { route_progress: currentProgress });
      formation.route_progress = currentProgress;

      const allArrived = currentProgress.every(v => v);
      if (allArrived) {
        console.log(`[Formation] 编队 "${formation.name}" 路线全部完成！`);
        if (this.onFormationEvent) {
          this.onFormationEvent({
            type: 'formation_route_completed',
            formation_id: formationId,
            formation_name: formation.name,
            timestamp: Date.now()
          });
        }
      }
    }
  }

  _calculateCenter(members) {
    let sumLng = 0;
    let sumLat = 0;
    for (const m of members) {
      sumLng += m.lng;
      sumLat += m.lat;
    }
    return {
      lng: sumLng / members.length,
      lat: sumLat / members.length
    };
  }

  _calculateSpreadRadius(members, center) {
    let totalDist = 0;
    for (const m of members) {
      totalDist += distance({ lng: center.lng, lat: center.lat }, { lng: m.lng, lat: m.lat });
    }
    return members.length > 0 ? totalDist / members.length : 0;
  }

  getFormationDetail(formationId) {
    const formation = this.formations.get(formationId);
    if (!formation) return null;

    const memberStatuses = formation.members.map(m => {
      const detachKey = `${formationId}_${m.target_id}`;
      const posKey = `${formationId}_${m.target_id}`;
      const pos = this.memberPositions.get(posKey);
      return {
        target_id: m.target_id,
        target_name: m.target_name,
        lng: pos ? pos.lng : null,
        lat: pos ? pos.lat : null,
        is_detached: this.memberDetachStatus.get(detachKey) || false
      };
    });

    const onlineMembers = memberStatuses.filter(m => m.lng !== null && m.lat !== null);
    let center = null;
    let spreadRadius = 0;
    if (onlineMembers.length >= 2) {
      center = this._calculateCenter(onlineMembers);
      spreadRadius = this._calculateSpreadRadius(onlineMembers, center);
    }

    const samples = this.spreadRadiusSamples.get(formationId);
    const avgSpreadRadius = samples && samples.count > 0 ? samples.total / samples.count : 0;

    const runtimeSeconds = formation.activated_at && formation.status === 'monitoring'
      ? Math.round((Date.now() - formation.activated_at) / 1000)
      : 0;

    return {
      id: formation.id,
      name: formation.name,
      radius_threshold: formation.radius_threshold,
      status: formation.status,
      center: center ? { lng: Math.round(center.lng * 100000) / 100000, lat: Math.round(center.lat * 100000) / 100000 } : null,
      spread_radius: Math.round(spreadRadius * 100000) / 100000,
      avg_spread_radius: Math.round(avgSpreadRadius * 100000) / 100000,
      members: memberStatuses,
      online_count: onlineMembers.length,
      total_members: formation.members.length,
      route_fence_ids: formation.route_fence_ids,
      route_progress: formation.route_progress,
      route_completed: formation.route_progress ? formation.route_progress.every(v => v) : null,
      activated_at: formation.activated_at,
      dissolved_at: formation.dissolved_at,
      created_at: formation.created_at,
      runtime_seconds: runtimeSeconds
    };
  }

  async getFormationStats(formationId) {
    const formation = this.formations.get(formationId);
    if (!formation) return null;

    const detachStats = await FormationEventModel.getDetachStats(formationId);
    const totalDetachCount = await FormationEventModel.getTotalDetachCount(formationId);

    const samples = this.spreadRadiusSamples.get(formationId);
    const avgSpreadRadius = samples && samples.count > 0 ? samples.total / samples.count : 0;

    const runtimeSeconds = formation.activated_at && formation.status === 'monitoring'
      ? Math.round((Date.now() - formation.activated_at) / 1000)
      : (formation.dissolved_at && formation.activated_at
        ? Math.round((formation.dissolved_at - formation.activated_at) / 1000)
        : 0);

    return {
      formation_id: formationId,
      formation_name: formation.name,
      status: formation.status,
      runtime_seconds: runtimeSeconds,
      total_detach_count: totalDetachCount,
      avg_spread_radius: Math.round(avgSpreadRadius * 100000) / 100000,
      member_detach_ranking: detachStats
    };
  }

  getAllFormations() {
    const result = [];
    for (const [formationId] of this.formations.entries()) {
      result.push(this.getFormationDetail(formationId));
    }
    return result;
  }

  async getFormationEvents(formationId, { limit = 100, offset = 0, event_type, start_time, end_time } = {}) {
    return FormationEventModel.query({
      formation_id: formationId,
      event_type,
      start_time,
      end_time,
      limit,
      offset
    });
  }

  async deleteFormation(formationId) {
    const formation = this.formations.get(formationId);
    if (!formation) {
      throw new Error('编队不存在');
    }

    for (const m of formation.members) {
      const key = `${formationId}_${m.target_id}`;
      this.memberDetachStatus.delete(key);
      this.memberPositions.delete(key);
    }
    this.formations.delete(formationId);
    this.spreadRadiusSamples.delete(formationId);

    await FormationMemberModel.deleteByFormationId(formationId);
    await FormationModel.delete(formationId);

    if (this.onFormationUpdate) {
      this.onFormationUpdate({
        type: 'formation_deleted',
        formation_id: formationId,
        formation_name: formation.name
      });
    }
    console.log(`[Formation] 编队 "${formation.name}"(${formationId}) 已删除`);
    return { formation_id: formationId, formation_name: formation.name, deleted: true };
  }
}

module.exports = { FormationEngine };
