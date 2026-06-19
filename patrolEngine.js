const { pointInPolygon, distance } = require('./geometry');
const { FenceModel, PatrolTaskModel } = require('./database');

function calculateCentroid(vertices) {
  let lngSum = 0;
  let latSum = 0;
  for (const v of vertices) {
    lngSum += v.lng;
    latSum += v.lat;
  }
  return {
    lng: lngSum / vertices.length,
    lat: latSum / vertices.length
  };
}

function calculateGreedyRoute(fences) {
  if (fences.length === 0) return [];
  if (fences.length === 1) return [fences[0]];
  
  const remaining = [...fences];
  const route = [remaining.shift()];
  
  while (remaining.length > 0) {
    const last = route[route.length - 1];
    const lastCentroid = last.centroid;
    
    let nearestIdx = 0;
    let nearestDist = Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const dist = distance(lastCentroid, remaining[i].centroid);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }
    
    route.push(remaining.splice(nearestIdx, 1)[0]);
  }
  
  return route;
}

class PatrolEngine {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.activeTasks = new Map();
    this.targetInsideFences = new Map();
    this.schedulerTimer = null;
    this.isRunning = false;
  }

  async createTask({ task_name, target_id, target_name, frequency, planned_start_time, deadline_time, fence_ids }) {
    if (!fence_ids || !Array.isArray(fence_ids) || fence_ids.length === 0) {
      throw new Error('必须指定至少一个围栏');
    }

    const fences = [];
    for (const fid of fence_ids) {
      const fence = await FenceModel.getById(fid);
      if (!fence) {
        throw new Error(`围栏 ${fid} 不存在`);
      }
      const centroid = calculateCentroid(fence.vertices);
      fences.push({
        fence_id: fence.id,
        fence_name: fence.name,
        centroid,
        vertices: fence.vertices
      });
    }

    const route = calculateGreedyRoute(fences);
    
    const waypoints = route.map(f => ({
      fence_id: f.fence_id,
      fence_name: f.fence_name,
      centroid_lng: f.centroid.lng,
      centroid_lat: f.centroid.lat
    }));

    const task = await PatrolTaskModel.create({
      task_name,
      target_id,
      target_name,
      frequency,
      planned_start_time,
      deadline_time,
      waypoints
    });

    if (this.onUpdate) {
      this.onUpdate({ type: 'task_created', task });
    }

    console.log(`[Patrol] 已创建巡检任务: ${task_name}, 目标: ${target_id}, 航点数: ${waypoints.length}`);
    return task;
  }

  async cancelTask(taskId) {
    const task = await PatrolTaskModel.getById(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error('该任务状态不允许取消');
    }

    await PatrolTaskModel.update(taskId, { status: 'cancelled' });
    this.activeTasks.delete(taskId);

    const updatedTask = await PatrolTaskModel.getById(taskId);
    if (this.onUpdate) {
      this.onUpdate({ type: 'task_cancelled', task: updatedTask });
    }

    console.log(`[Patrol] 任务已取消: ${taskId}`);
    return updatedTask;
  }

  async activateTask(taskId) {
    const task = await PatrolTaskModel.getById(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }
    if (task.status !== 'pending') {
      throw new Error('只有待激活的任务才能激活');
    }

    const now = Date.now();
    await PatrolTaskModel.update(taskId, {
      status: 'active',
      actual_start_time: now,
      current_waypoint_index: 0
    });

    const activatedTask = await PatrolTaskModel.getById(taskId);
    this.activeTasks.set(taskId, activatedTask);

    if (this.onUpdate) {
      this.onUpdate({ type: 'task_activated', task: activatedTask });
    }

    console.log(`[Patrol] 任务已激活: ${taskId}, 目标: ${task.target_id}`);
    return activatedTask;
  }

  async completeTask(taskId) {
    const task = await PatrolTaskModel.getById(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }

    const now = Date.now();
    await PatrolTaskModel.update(taskId, {
      status: 'completed',
      completed_time: now
    });

    this.activeTasks.delete(taskId);

    const completedTask = await PatrolTaskModel.getById(taskId);
    
    if (this.onUpdate) {
      this.onUpdate({ type: 'task_completed', task: completedTask });
    }

    console.log(`[Patrol] 任务已完成: ${taskId}`);
    
    await this.generateNextTaskIfNeeded(completedTask);
    
    return completedTask;
  }

  async markOverdue(taskId) {
    const task = await PatrolTaskModel.getById(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }

    await PatrolTaskModel.update(taskId, { status: 'overdue' });
    this.activeTasks.delete(taskId);

    const overdueTask = await PatrolTaskModel.getById(taskId);
    
    if (this.onUpdate) {
      this.onUpdate({ type: 'task_overdue', task: overdueTask });
    }

    console.log(`[Patrol] 任务已逾期: ${taskId}`);
    
    await this.generateNextTaskIfNeeded(overdueTask);
    
    return overdueTask;
  }

  async generateNextTaskIfNeeded(task) {
    if (task.status === 'cancelled') return;
    if (task.frequency === 'once') return;

    const nextStartTime = this.getNextStartTime(task.planned_start_time, task.frequency);
    if (!nextStartTime) return;

    const duration = task.deadline_time - task.planned_start_time;
    const nextDeadline = nextStartTime + duration;

    const waypoints = task.waypoints.map(wp => ({
      fence_id: wp.fence_id,
      fence_name: wp.fence_name,
      centroid_lng: wp.centroid_lng,
      centroid_lat: wp.centroid_lat
    }));

    const nextTask = await PatrolTaskModel.create({
      task_name: task.task_name,
      target_id: task.target_id,
      target_name: task.target_name,
      frequency: task.frequency,
      planned_start_time: nextStartTime,
      deadline_time: nextDeadline,
      waypoints,
      parent_task_id: task.id
    });

    if (this.onUpdate) {
      this.onUpdate({ type: 'task_created', task: nextTask });
    }

    console.log(`[Patrol] 已生成下一期任务: ${nextTask.id}, 源任务: ${task.id}`);
    return nextTask;
  }

  getNextStartTime(baseTime, frequency) {
    const base = new Date(baseTime);
    
    if (frequency === 'daily') {
      const next = new Date(base);
      next.setDate(next.getDate() + 1);
      return next.getTime();
    } else if (frequency === 'weekly') {
      const next = new Date(base);
      next.setDate(next.getDate() + 7);
      return next.getTime();
    }
    
    return null;
  }

  processPositionUpdate(position) {
    const { id: targetId, lng, lat } = position;
    const point = { lng, lat };

    if (!this.targetInsideFences.has(targetId)) {
      this.targetInsideFences.set(targetId, new Set());
    }
    const prevInside = this.targetInsideFences.get(targetId);
    const currentInside = new Set();

    for (const [taskId, task] of this.activeTasks) {
      if (task.target_id !== targetId) continue;
      
      for (const wp of task.waypoints) {
        const fence = this._getFenceFromCache(wp.fence_id);
        if (!fence) continue;
        
        const inside = pointInPolygon(point, fence.vertices);
        if (inside) {
          currentInside.add(wp.fence_id);
          
          if (!prevInside.has(wp.fence_id)) {
            this.handleFenceEnter(taskId, wp, position);
          }
        }
      }
    }

    this.targetInsideFences.set(targetId, currentInside);
  }

  _getFenceFromCache(fenceId) {
    if (!this._fenceCache) {
      this._fenceCache = new Map();
    }
    return this._fenceCache.get(fenceId);
  }

  async reloadFenceCache() {
    const fences = await FenceModel.getAll();
    this._fenceCache = new Map();
    fences.forEach(f => {
      this._fenceCache.set(f.id, f);
    });
  }

  async handleFenceEnter(taskId, waypoint, position) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    
    const expectedIndex = task.current_waypoint_index;
    if (expectedIndex >= task.waypoints.length) return;
    
    const expectedWaypoint = task.waypoints[expectedIndex];
    if (waypoint.fence_id !== expectedWaypoint.fence_id) {
      console.log(`[Patrol] 任务 ${taskId}: 目标进入围栏 ${waypoint.fence_name}，但当前应到 ${expectedWaypoint.fence_name}，跳站不计`);
      return;
    }

    const now = Date.now();
    await PatrolTaskModel.markWaypointArrived(taskId, expectedIndex, now);
    
    const nextIndex = expectedIndex + 1;
    await PatrolTaskModel.update(taskId, {
      current_waypoint_index: nextIndex
    });

    const updatedTask = await PatrolTaskModel.getById(taskId);
    this.activeTasks.set(taskId, updatedTask);

    if (this.onUpdate) {
      this.onUpdate({
        type: 'waypoint_arrived',
        task_id: taskId,
        waypoint_index: expectedIndex,
        waypoint: waypoint,
        arrived_at: now,
        task: updatedTask
      });
    }

    console.log(`[Patrol] 任务 ${taskId}: 到达第 ${expectedIndex + 1} 站 ${waypoint.fence_name}`);

    if (nextIndex >= task.waypoints.length) {
      await this.completeTask(taskId);
    }
  }

  getTaskProgress(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      return null;
    }
    return this._calculateProgress(task);
  }

  _calculateProgress(task) {
    const now = Date.now();
    const totalWaypoints = task.waypoints.length;
    const currentIndex = task.current_waypoint_index;
    
    const arrivedCount = currentIndex;
    const progressPercent = totalWaypoints > 0 ? (arrivedCount / totalWaypoints) * 100 : 0;
    
    const elapsedMs = task.actual_start_time ? now - task.actual_start_time : 0;
    const remainingMs = task.deadline_time - now;
    
    const currentWaypoint = currentIndex < totalWaypoints ? task.waypoints[currentIndex] : null;
    const nextWaypoint = currentIndex + 1 < totalWaypoints ? task.waypoints[currentIndex + 1] : null;
    
    return {
      task_id: task.id,
      task_name: task.task_name,
      status: task.status,
      target_id: task.target_id,
      target_name: task.target_name,
      current_waypoint_index: currentIndex,
      current_waypoint: currentWaypoint,
      next_waypoint: nextWaypoint,
      arrived_count: arrivedCount,
      total_waypoints: totalWaypoints,
      progress_percent: Math.round(progressPercent * 10) / 10,
      elapsed_seconds: Math.round(elapsedMs / 1000),
      remaining_seconds: Math.max(0, Math.round(remainingMs / 1000)),
      planned_start_time: task.planned_start_time,
      deadline_time: task.deadline_time,
      actual_start_time: task.actual_start_time,
      waypoints: task.waypoints
    };
  }

  getAllActiveProgress() {
    const results = [];
    for (const task of this.activeTasks.values()) {
      results.push(this._calculateProgress(task));
    }
    return results;
  }

  startScheduler(intervalMs = 1000) {
    if (this.isRunning) return;
    this.isRunning = true;
    
    this.schedulerTimer = setInterval(() => {
      this.tick();
    }, intervalMs);
    
    console.log('[Patrol] 调度器已启动');
  }

  stopScheduler() {
    this.isRunning = false;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    console.log('[Patrol] 调度器已停止');
  }

  async tick() {
    const now = Date.now();

    try {
      const pendingTasks = await PatrolTaskModel.getPendingToActivate(now);
      for (const task of pendingTasks) {
        if (!this.activeTasks.has(task.id)) {
          await this.activateTask(task.id);
        }
      }
    } catch (err) {
      console.error('[Patrol] 激活待处理任务失败:', err.message);
    }

    try {
      const overdueTasks = await PatrolTaskModel.getOverdueTasks(now);
      for (const task of overdueTasks) {
        if (this.activeTasks.has(task.id)) {
          await this.markOverdue(task.id);
        }
      }
    } catch (err) {
      console.error('[Patrol] 标记逾期任务失败:', err.message);
    }
  }

  async loadActiveTasks() {
    const activeTasks = await PatrolTaskModel.getActiveTasks();
    for (const task of activeTasks) {
      this.activeTasks.set(task.id, task);
    }
    console.log(`[Patrol] 已加载 ${activeTasks.length} 个进行中的任务`);
  }

  async init() {
    await this.reloadFenceCache();
    await this.loadActiveTasks();
  }
}

module.exports = {
  PatrolEngine,
  calculateGreedyRoute,
  calculateCentroid
};