const { 
  TrajectoryModel, 
  BehaviorProfileModel, 
  BehaviorAnomalyModel,
  AlertModel,
  TargetBindingModel,
  FenceModel
} = require('./database');
const { pointInPolygon, distance } = require('./geometry');

const PROFILE_DAYS = 7;
const TOP_ROUTES_COUNT = 3;
const TOP_STAY_AREAS_COUNT = 3;
const SILENT_HOUR_THRESHOLD = 0.02;
const AREA_ANOMALY_STAY_DURATION = 120000;
const AREA_ANOMALY_RADIUS = 0.001;
const ANOMALY_DEDUP_WINDOW = 600000;

class BehaviorEngine {
  constructor(onAnomaly, onProfileUpdate) {
    this.onAnomaly = onAnomaly;
    this.onProfileUpdate = onProfileUpdate;
    this.fences = [];
    this.recentFenceEvents = new Map();
    this.targetFenceStates = new Map();
    this.currentStayPoints = new Map();
    this.lastAnomalyTime = new Map();
    this.hourlyTimer = null;
    this.profilesCache = new Map();
  }

  async init() {
    await this.loadFences();
    await this.loadProfilesCache();
  }

  async loadFences() {
    this.fences = await FenceModel.getAll();
  }

  async loadProfilesCache() {
    const profiles = await BehaviorProfileModel.getAllLatest();
    profiles.forEach(p => {
      this.profilesCache.set(p.target_id, p);
    });
    console.log(`[Behavior] 已加载 ${profiles.length} 个目标的行为画像缓存`);
  }

  async reloadFences() {
    await this.loadFences();
    this.targetFenceStates.clear();
  }

  startHourlyUpdate() {
    if (this.hourlyTimer) return;
    this.hourlyTimer = setInterval(() => {
      this.updateAllProfiles().catch(err => {
        console.error('[Behavior] 定时更新画像失败:', err.message);
      });
    }, 60 * 60 * 1000);
    console.log('[Behavior] 每小时画像更新任务已启动');
  }

  stopHourlyUpdate() {
    if (this.hourlyTimer) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = null;
    }
  }

  async updateAllProfiles() {
    console.log('[Behavior] 开始更新所有目标行为画像...');
    const targetIds = await this.getAllTargetIds();
    let count = 0;
    for (const targetId of targetIds) {
      try {
        await this.buildProfile(targetId);
        count++;
      } catch (err) {
        console.error(`[Behavior] 构建目标 ${targetId} 画像失败:`, err.message);
      }
    }
    console.log(`[Behavior] 画像更新完成，共处理 ${count} 个目标`);
    return count;
  }

  async getAllTargetIds() {
    const rows = await TrajectoryModel.query({
      limit: 10000,
      interval: 0
    });
    const ids = new Set();
    rows.forEach(r => ids.add(r.target_id));
    return Array.from(ids);
  }

  async buildProfile(targetId) {
    const now = Date.now();
    const startTime = now - PROFILE_DAYS * 24 * 60 * 60 * 1000;
    const profileDate = new Date(now).toISOString().split('T')[0];

    const points = await TrajectoryModel.query({
      target_id: targetId,
      start_time: startTime,
      end_time: now,
      limit: 100000
    });

    if (points.length === 0) {
      return null;
    }

    const targetName = points[0].target_name;
    const groupInfo = await TargetBindingModel.getBinding(targetId);

    const commonRoutes = await this.calculateCommonRoutes(targetId, startTime, now);
    const commonStayAreas = await this.calculateCommonStayAreas(points);
    const activeHours = this.calculateActiveHours(points);

    const profile = await BehaviorProfileModel.upsert({
      target_id: targetId,
      target_name: targetName,
      profile_date: profileDate,
      common_routes: commonRoutes,
      common_stay_areas: commonStayAreas,
      active_hours: activeHours,
      total_points: points.length,
      data_start_time: startTime,
      data_end_time: now
    });

    this.profilesCache.set(targetId, profile);

    if (this.onProfileUpdate) {
      this.onProfileUpdate(profile);
    }

    return profile;
  }

  async calculateCommonRoutes(targetId, startTime, endTime) {
    const points = await TrajectoryModel.query({
      target_id: targetId,
      start_time: startTime,
      end_time: endTime,
      limit: 100000
    });

    if (points.length < 10 || this.fences.length === 0) {
      return [];
    }

    const fenceStates = new Map();
    this.fences.forEach(fence => {
      fenceStates.set(fence.id, false);
    });

    const events = [];

    for (const point of points) {
      for (const fence of this.fences) {
        const wasInside = fenceStates.get(fence.id);
        const isInside = pointInPolygon({ lng: point.lng, lat: point.lat }, fence.vertices);
        
        if (wasInside !== isInside) {
          fenceStates.set(fence.id, isInside);
          events.push({
            fence_id: fence.id,
            fence_name: fence.name,
            event_type: isInside ? 'enter' : 'leave',
            timestamp: point.timestamp
          });
        }
      }
    }

    if (events.length < 3) {
      return [];
    }

    const routeMap = new Map();
    let currentSequence = [];

    for (const event of events) {
      const eventKey = `${event.fence_name}:${event.event_type}`;
      currentSequence.push(eventKey);
      
      if (currentSequence.length > 3) {
        currentSequence.shift();
      }

      if (currentSequence.length === 3) {
        const routeKey = currentSequence.join(' -> ');
        routeMap.set(routeKey, (routeMap.get(routeKey) || 0) + 1);
      }
    }

    const routes = Array.from(routeMap.entries())
      .map(([sequence, count]) => ({ sequence, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_ROUTES_COUNT);

    return routes;
  }

  async calculateCommonStayAreas(points) {
    if (points.length < 5) {
      return [];
    }

    const stays = [];
    let i = 0;
    
    while (i < points.length) {
      const startPoint = points[i];
      let j = i + 1;
      let centerLng = startPoint.lng;
      let centerLat = startPoint.lat;

      while (j < points.length) {
        const curr = points[j];
        const dist = distance(
          { lng: centerLng, lat: centerLat },
          { lng: curr.lng, lat: curr.lat }
        );
        
        if (dist > AREA_ANOMALY_RADIUS) {
          break;
        }

        const total = j - i + 1;
        centerLng = ((centerLng * (total - 1)) + curr.lng) / total;
        centerLat = ((centerLat * (total - 1)) + curr.lat) / total;
        j++;
      }

      const duration = points[j - 1].timestamp - startPoint.timestamp;
      if (duration >= AREA_ANOMALY_STAY_DURATION) {
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

    const clusteredStays = this.clusterStayAreas(stays);
    
    return clusteredStays
      .sort((a, b) => b.avg_duration_seconds - a.avg_duration_seconds)
      .slice(0, TOP_STAY_AREAS_COUNT);
  }

  clusterStayAreas(stays) {
    if (stays.length === 0) return [];

    const clusters = [];
    const clustered = new Set();

    for (let i = 0; i < stays.length; i++) {
      if (clustered.has(i)) continue;

      const cluster = [stays[i]];
      clustered.add(i);

      for (let j = i + 1; j < stays.length; j++) {
        if (clustered.has(j)) continue;
        
        const dist = distance(
          { lng: stays[i].center_lng, lat: stays[i].center_lat },
          { lng: stays[j].center_lng, lat: stays[j].center_lat }
        );

        if (dist < AREA_ANOMALY_RADIUS * 2) {
          cluster.push(stays[j]);
          clustered.add(j);
        }
      }

      const avgLng = cluster.reduce((sum, s) => sum + s.center_lng, 0) / cluster.length;
      const avgLat = cluster.reduce((sum, s) => sum + s.center_lat, 0) / cluster.length;
      const avgDuration = cluster.reduce((sum, s) => sum + s.duration_seconds, 0) / cluster.length;
      const maxDuration = Math.max(...cluster.map(s => s.duration_seconds));
      const totalDuration = cluster.reduce((sum, s) => sum + s.duration_seconds, 0);

      clusters.push({
        center_lng: avgLng,
        center_lat: avgLat,
        visit_count: cluster.length,
        avg_duration_seconds: Math.round(avgDuration),
        max_duration_seconds: maxDuration,
        total_duration_seconds: totalDuration
      });
    }

    return clusters;
  }

  calculateActiveHours(points) {
    const hourCounts = new Array(24).fill(0);
    let totalPoints = 0;

    for (const point of points) {
      const hour = new Date(point.timestamp).getHours();
      hourCounts[hour]++;
      totalPoints++;
    }

    const activeHours = [];
    const silentHours = [];
    const hourRatios = [];

    for (let h = 0; h < 24; h++) {
      const ratio = totalPoints > 0 ? hourCounts[h] / totalPoints : 0;
      hourRatios.push({ hour: h, count: hourCounts[h], ratio });
      
      if (ratio >= SILENT_HOUR_THRESHOLD) {
        activeHours.push(h);
      } else {
        silentHours.push(h);
      }
    }

    return {
      hour_counts: hourCounts,
      hour_ratios: hourRatios.map(h => h.ratio),
      active_hours: activeHours,
      silent_hours: silentHours,
      total_points: totalPoints
    };
  }

  async processPositionUpdate(position) {
    const { id: targetId, name: targetName, lng, lat, timestamp } = position;

    await this.detectRouteDeviation(targetId, targetName, lng, lat, timestamp);
    await this.detectAreaAnomaly(targetId, targetName, lng, lat, timestamp);
    await this.detectTimeAnomaly(targetId, targetName, lng, lat, timestamp);
  }

  async detectRouteDeviation(targetId, targetName, lng, lat, timestamp) {
    const profile = this.profilesCache.get(targetId);
    if (!profile || profile.common_routes.length === 0) {
      return;
    }

    let fenceStates = this.targetFenceStates.get(targetId);
    if (!fenceStates) {
      fenceStates = new Map();
      this.fences.forEach(fence => {
        const isInside = pointInPolygon({ lng, lat }, fence.vertices);
        fenceStates.set(fence.id, isInside);
      });
      this.targetFenceStates.set(targetId, fenceStates);
      return;
    }

    let events = this.recentFenceEvents.get(targetId) || [];
    let hasNewEvent = false;

    for (const fence of this.fences) {
      const wasInside = fenceStates.get(fence.id) || false;
      const isInside = pointInPolygon({ lng, lat }, fence.vertices);
      
      if (wasInside !== isInside) {
        fenceStates.set(fence.id, isInside);
        hasNewEvent = true;
        const eventType = isInside ? 'enter' : 'leave';
        events.push({
          fence_id: fence.id,
          fence_name: fence.name,
          event_type: eventType,
          timestamp: timestamp
        });

        if (events.length > 3) {
          events.shift();
        }
      }
    }

    if (hasNewEvent && events.length >= 3) {
      const recentSequence = events.map(e => `${e.fence_name}:${e.event_type}`).join(' -> ');
      const isKnownRoute = profile.common_routes.some(r => r.sequence === recentSequence);
      
      if (!isKnownRoute) {
        await this.triggerAnomaly(
          targetId, targetName, 'route_deviation',
          `目标 ${targetName} 当前路线偏离常走路线`,
          lng, lat, timestamp,
          { recent_sequence: recentSequence, known_routes: profile.common_routes }
        );
      }
    }

    this.recentFenceEvents.set(targetId, events);
  }

  async detectAreaAnomaly(targetId, targetName, lng, lat, timestamp) {
    const profile = this.profilesCache.get(targetId);
    if (!profile || profile.common_stay_areas.length === 0) {
      return;
    }

    let currentStay = this.currentStayPoints.get(targetId);
    
    if (!currentStay) {
      currentStay = {
        start_time: timestamp,
        start_lng: lng,
        start_lat: lat,
        center_lng: lng,
        center_lat: lat,
        point_count: 1
      };
      this.currentStayPoints.set(targetId, currentStay);
      return;
    }

    const dist = distance(
      { lng: currentStay.center_lng, lat: currentStay.center_lat },
      { lng, lat }
    );

    if (dist < AREA_ANOMALY_RADIUS) {
      currentStay.point_count++;
      currentStay.center_lng = ((currentStay.center_lng * (currentStay.point_count - 1)) + lng) / currentStay.point_count;
      currentStay.center_lat = ((currentStay.center_lat * (currentStay.point_count - 1)) + lat) / currentStay.point_count;
      
      const duration = timestamp - currentStay.start_time;
      
      if (duration >= AREA_ANOMALY_STAY_DURATION) {
        const isKnownArea = profile.common_stay_areas.some(area => {
          const d = distance(
            { lng: area.center_lng, lat: area.center_lat },
            { lng: currentStay.center_lng, lat: currentStay.center_lat }
          );
          return d < AREA_ANOMALY_RADIUS * 3;
        });

        if (!isKnownArea) {
          await this.triggerAnomaly(
            targetId, targetName, 'area_anomaly',
            `目标 ${targetName} 在非历史常停区域停留超过 ${AREA_ANOMALY_STAY_DURATION / 1000} 秒`,
            lng, lat, timestamp,
            {
              stay_center: { lng: currentStay.center_lng, lat: currentStay.center_lat },
              stay_duration_seconds: Math.round(duration / 1000),
              known_areas: profile.common_stay_areas
            }
          );
        }
      }
    } else {
      this.currentStayPoints.set(targetId, {
        start_time: timestamp,
        start_lng: lng,
        start_lat: lat,
        center_lng: lng,
        center_lat: lat,
        point_count: 1
      });
    }
  }

  async detectTimeAnomaly(targetId, targetName, lng, lat, timestamp) {
    const profile = this.profilesCache.get(targetId);
    if (!profile || !profile.active_hours || !profile.active_hours.silent_hours) {
      return;
    }

    const hour = new Date(timestamp).getHours();
    const silentHours = profile.active_hours.silent_hours || [];
    
    if (silentHours.includes(hour)) {
      await this.triggerAnomaly(
        targetId, targetName, 'time_anomaly',
        `目标 ${targetName} 在沉默时段(${hour}点)异常活跃`,
        lng, lat, timestamp,
        {
          hour: hour,
          silent_hours: silentHours,
          active_hours: profile.active_hours.active_hours,
          hour_ratio: profile.active_hours.hour_ratios[hour]
        }
      );
    }
  }

  async triggerAnomaly(targetId, targetName, anomalyType, description, lng, lat, timestamp, details) {
    const dedupKey = `${targetId}_${anomalyType}`;
    const lastTime = this.lastAnomalyTime.get(dedupKey);
    
    if (lastTime && timestamp - lastTime < ANOMALY_DEDUP_WINDOW) {
      return;
    }

    this.lastAnomalyTime.set(dedupKey, timestamp);

    const groupInfo = await TargetBindingModel.getBinding(targetId);

    const anomaly = await BehaviorAnomalyModel.create({
      target_id: targetId,
      target_name: targetName,
      anomaly_type: anomalyType,
      description: description,
      lng: lng,
      lat: lat,
      timestamp: timestamp,
      details: details,
      group_id: groupInfo ? groupInfo.group_id : null,
      group_name: groupInfo ? groupInfo.group_name : null
    });

    console.log(`[Behavior] 异常检测: ${targetName}(${targetId}) - ${anomalyType}`);

    if (this.onAnomaly) {
      this.onAnomaly(anomaly);
    }

    return anomaly;
  }

  getProfile(targetId) {
    return this.profilesCache.get(targetId) || null;
  }

  getAllProfiles() {
    return Array.from(this.profilesCache.values());
  }

  async compareProfiles(targetId1, targetId2) {
    const profile1 = this.profilesCache.get(targetId1);
    const profile2 = this.profilesCache.get(targetId2);

    if (!profile1 || !profile2) {
      return null;
    }

    const routeSimilarity = this.calculateRouteSimilarity(profile1.common_routes, profile2.common_routes);
    const timeSimilarity = this.calculateTimeSimilarity(profile1.active_hours, profile2.active_hours);
    const overallSimilarity = (routeSimilarity + timeSimilarity) / 2;

    return {
      target_id_1: targetId1,
      target_id_2: targetId2,
      route_similarity: Math.round(routeSimilarity * 1000) / 1000,
      time_similarity: Math.round(timeSimilarity * 1000) / 1000,
      overall_similarity: Math.round(overallSimilarity * 1000) / 1000
    };
  }

  calculateRouteSimilarity(routes1, routes2) {
    if (routes1.length === 0 && routes2.length === 0) return 1;
    if (routes1.length === 0 || routes2.length === 0) return 0;

    const set1 = new Set(routes1.map(r => r.sequence));
    const set2 = new Set(routes2.map(r => r.sequence));

    let intersection = 0;
    set1.forEach(s => {
      if (set2.has(s)) intersection++;
    });

    const union = set1.size + set2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  calculateTimeSimilarity(active1, active2) {
    const ratios1 = active1.hour_ratios || new Array(24).fill(0);
    const ratios2 = active2.hour_ratios || new Array(24).fill(0);

    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    for (let i = 0; i < 24; i++) {
      dotProduct += ratios1[i] * ratios2[i];
      mag1 += ratios1[i] * ratios1[i];
      mag2 += ratios2[i] * ratios2[i];
    }

    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);

    if (mag1 === 0 && mag2 === 0) return 1;
    if (mag1 === 0 || mag2 === 0) return 0;

    return dotProduct / (mag1 * mag2);
  }

  async initPresetAnomalies() {
    const existing = await BehaviorAnomalyModel.query({ limit: 1 });
    if (existing.length > 0) {
      return 0;
    }

    const targetIds = await this.getAllTargetIds();
    if (targetIds.length < 2) {
      return 0;
    }

    const now = Date.now();
    const target1 = targetIds[0];
    const target2 = targetIds[1];

    const binding1 = await TargetBindingModel.getBinding(target1);
    const binding2 = await TargetBindingModel.getBinding(target2);

    await BehaviorAnomalyModel.create({
      target_id: target1,
      target_name: `车辆${target1}`,
      anomaly_type: 'route_deviation',
      description: `目标 车辆${target1} 当前路线偏离常走路线`,
      lng: 116.40,
      lat: 39.80,
      timestamp: now - 30 * 60 * 1000,
      details: { recent_sequence: '未知路线', reason: '模拟演示数据' },
      group_id: binding1 ? binding1.group_id : null,
      group_name: binding1 ? binding1.group_name : null
    });

    await BehaviorAnomalyModel.create({
      target_id: target2,
      target_name: `车辆${target2}`,
      anomaly_type: 'time_anomaly',
      description: `目标 车辆${target2} 在沉默时段异常活跃`,
      lng: 116.50,
      lat: 39.90,
      timestamp: now - 15 * 60 * 1000,
      details: { hour: 3, reason: '模拟演示数据' },
      group_id: binding2 ? binding2.group_id : null,
      group_name: binding2 ? binding2.group_name : null
    });

    console.log('[Behavior] 已预置2条异常事件');
    return 2;
  }
}

module.exports = { BehaviorEngine };
