const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const {
  FenceModel,
  AlertModel,
  POIModel,
  TargetGroupModel,
  TargetBindingModel,
  FenceTimeWindowModel,
  FenceAlertRuleModel,
  FenceActionModel,
  FenceActivationOverrideModel,
  TrajectoryModel,
  HeatmapModel,
  DutyScheduleModel,
  WorkOrderModel,
  WorkOrderEscalationModel,
  PatrolTaskModel,
  BehaviorProfileModel,
  BehaviorAnomalyModel
} = require('./database');
const { FenceEngine } = require('./fenceEngine');
const { WorkOrderEngine } = require('./workOrderEngine');
const { GPSSimulator } = require('./gpsSimulator');
const { isPolygonSelfIntersecting } = require('./geometry');
const { initPresetData } = require('./presetData');
const { HeatmapManager } = require('./heatmapManager');
const { ReplayManager } = require('./replayManager');
const { PatrolEngine } = require('./patrolEngine');
const { BehaviorEngine } = require('./behaviorEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const clients = new Set();

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

let fenceEngine;
let gpsSimulator;
let heatmapManager;
let replayManager;
let workOrderEngine;
let patrolEngine;
let behaviorEngine;

async function main() {
  await initPresetData(FenceModel, POIModel, TargetGroupModel, TargetBindingModel, FenceTimeWindowModel, FenceAlertRuleModel, FenceActionModel, DutyScheduleModel, WorkOrderModel, WorkOrderEscalationModel, AlertModel, PatrolTaskModel);

  workOrderEngine = new WorkOrderEngine((update) => {
    broadcast({
      type: 'work_order_update',
      data: update
    });
  });

  patrolEngine = new PatrolEngine((update) => {
    broadcast({
      type: 'patrol_update',
      data: update
    });
  });
  await patrolEngine.init();

  fenceEngine = new FenceEngine(
    (alert) => {
      broadcast({ type: 'alert', data: alert });
    },
    (status) => {
      broadcast({ type: 'fence_status', data: status });
    },
    (alert) => {
      workOrderEngine.createWorkOrderFromAlert(alert).catch(err => {
        console.error('[Server] 创建工单失败:', err.message);
      });
    }
  );
  await fenceEngine.reloadFences();

  replayManager = new ReplayManager(
    broadcast,
    (targetId) => gpsSimulator.getTargetState(targetId),
    async (targetId) => await TargetBindingModel.getBinding(targetId)
  );

  heatmapManager = new HeatmapManager((heatmapData) => {
    broadcast({ type: 'heatmap_update', data: heatmapData });
  });

  behaviorEngine = new BehaviorEngine(
    (anomaly) => {
      broadcast({ type: 'behavior_anomaly', data: anomaly });
    },
    (profile) => {
      broadcast({ type: 'behavior_profile_update', data: profile });
    }
  );
  await behaviorEngine.init();

  gpsSimulator = new GPSSimulator(async (position) => {
    if (!replayManager.isTargetInReplay(position.id)) {
      fenceEngine.processPositionUpdate(position);
      patrolEngine.processPositionUpdate(position);
      behaviorEngine.processPositionUpdate(position).catch(err => {
        console.error('[Behavior] 异常检测处理失败:', err.message);
      });
      const binding = await TargetBindingModel.getBinding(position.id);
      const posWithGroup = {
        ...position,
        group_id: binding ? binding.group_id : null,
        group_name: binding ? binding.group_name : null,
        group_color: binding ? binding.group_color : null
      };
      broadcast({ type: 'position', data: posWithGroup });
    }
  }, { enableTrajectoryPersistence: true });

  wss.on('connection', async (ws) => {
    clients.add(ws);
    console.log(`[WS] 客户端连接，当前连接数: ${clients.size}`);
    const targets = gpsSimulator.getAllTargets();
    for (const target of targets) {
      const binding = await TargetBindingModel.getBinding(target.id);
      ws.send(JSON.stringify({
        type: 'position',
        data: {
          id: target.id,
          name: target.name,
          color: target.color,
          lng: target.lng,
          lat: target.lat,
          bearing: target.bearing,
          timestamp: Date.now(),
          trajectory: target.trajectory,
          group_id: binding ? binding.group_id : null,
          group_name: binding ? binding.group_name : null,
          group_color: binding ? binding.group_color : null
        }
      }));
    }
    fenceEngine.getAllFenceStatus().forEach(status => {
      ws.send(JSON.stringify({ type: 'fence_status', data: status }));
    });
    const latestHeatmap = heatmapManager.getLatest();
    if (latestHeatmap) {
      ws.send(JSON.stringify({ type: 'heatmap_update', data: latestHeatmap }));
    }
    const currentReplay = replayManager.getCurrentReplay();
    if (currentReplay) {
      ws.send(JSON.stringify({ type: 'replay_started', data: currentReplay }));
    }
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] 客户端断开，当前连接数: ${clients.size}`);
    });
    ws.on('error', (err) => {
      console.error('[WS] 错误:', err);
    });
  });

  app.get('/api/fences', async (req, res) => {
    const fences = await FenceModel.getAll();
    const fencesWithDetails = [];
    for (const fence of fences) {
      const timeWindow = await FenceTimeWindowModel.getByFenceId(fence.id);
      const rules = await FenceAlertRuleModel.getByFenceId(fence.id);
      const actions = await FenceActionModel.getByFenceId(fence.id);
      const isActive = fenceEngine.getFenceActiveStatus(fence.id);
      fencesWithDetails.push({
        ...fence,
        time_window: timeWindow,
        alert_rules: rules,
        actions: actions,
        is_active: isActive
      });
    }
    res.json(fencesWithDetails);
  });

  app.post('/api/fences', async (req, res) => {
    const { name, type, color, vertices } = req.body;
    if (!name || !type || !color || !Array.isArray(vertices) || vertices.length < 3) {
      return res.status(400).json({ error: '参数不完整，围栏至少需要3个顶点' });
    }
    if (isPolygonSelfIntersecting(vertices)) {
      return res.status(400).json({ error: '多边形不能自交' });
    }
    const fence = await FenceModel.create({ name, type, color, vertices });
    await fenceEngine.reloadFences();
    res.status(201).json(fence);
  });

  app.put('/api/fences/:id', async (req, res) => {
    const { id } = req.params;
    const { name, type, color, vertices } = req.body;
    const existing = await FenceModel.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '围栏不存在' });
    }
    if (vertices && isPolygonSelfIntersecting(vertices)) {
      return res.status(400).json({ error: '多边形不能自交' });
    }
    const fence = await FenceModel.update(id, {
      name: name || existing.name,
      type: type || existing.type,
      color: color || existing.color,
      vertices: vertices || existing.vertices
    });
    await fenceEngine.reloadFences();
    res.json(fence);
  });

  app.delete('/api/fences/:id', async (req, res) => {
    const { id } = req.params;
    const existing = await FenceModel.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '围栏不存在' });
    }
    await FenceModel.delete(id);
    await fenceEngine.reloadFences();
    res.json({ success: true });
  });

  app.get('/api/fences/:id/time-window', async (req, res) => {
    const { id } = req.params;
    const tw = await FenceTimeWindowModel.getByFenceId(id);
    res.json(tw || { mode: 'all_day' });
  });

  app.put('/api/fences/:id/time-window', async (req, res) => {
    const { id } = req.params;
    const { mode, start_time, end_time, weekdays } = req.body;
    if (!mode || !['all_day', 'time_range', 'weekday_time'].includes(mode)) {
      return res.status(400).json({ error: '无效的时间窗口模式' });
    }
    if (mode !== 'all_day' && (!start_time || !end_time)) {
      return res.status(400).json({ error: '时间段模式需要指定start_time和end_time' });
    }
    if (mode === 'weekday_time' && !Array.isArray(weekdays)) {
      return res.status(400).json({ error: '工作日模式需要指定weekdays数组' });
    }
    const tw = await FenceTimeWindowModel.set(id, { mode, start_time, end_time, weekdays });
    await fenceEngine.reloadFences();
    res.json(tw);
  });

  app.delete('/api/fences/:id/time-window', async (req, res) => {
    const { id } = req.params;
    await FenceTimeWindowModel.delete(id);
    await fenceEngine.reloadFences();
    res.json({ success: true });
  });

  app.get('/api/fences/:id/rules', async (req, res) => {
    const { id } = req.params;
    const rules = await FenceAlertRuleModel.getByFenceId(id);
    res.json(rules);
  });

  app.post('/api/fences/:id/rules', async (req, res) => {
    const { id } = req.params;
    const { group_id, enter_level, leave_level, message_template } = req.body;
    if (group_id === undefined) {
      return res.status(400).json({ error: '需要指定group_id' });
    }
    const validLevels = ['none', 'info', 'warning', 'critical'];
    if (enter_level !== undefined && !validLevels.includes(enter_level)) {
      return res.status(400).json({ error: `enter_level 无效，合法值: ${validLevels.join(', ')}` });
    }
    if (leave_level !== undefined && !validLevels.includes(leave_level)) {
      return res.status(400).json({ error: `leave_level 无效，合法值: ${validLevels.join(', ')}` });
    }
    try {
      const rule = await FenceAlertRuleModel.create({
        fence_id: id,
        group_id,
        enter_level,
        leave_level,
        message_template
      });
      await fenceEngine.reloadFences();
      res.status(201).json(rule);
    } catch (err) {
      console.error('[API] 创建告警规则失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/rules/:id', async (req, res) => {
    const { id } = req.params;
    const { enter_level, leave_level, message_template } = req.body;
    const validLevels = ['none', 'info', 'warning', 'critical'];
    if (enter_level !== undefined && !validLevels.includes(enter_level)) {
      return res.status(400).json({ error: `enter_level 无效，合法值: ${validLevels.join(', ')}` });
    }
    if (leave_level !== undefined && !validLevels.includes(leave_level)) {
      return res.status(400).json({ error: `leave_level 无效，合法值: ${validLevels.join(', ')}` });
    }
    try {
      const rule = await FenceAlertRuleModel.update(id, { enter_level, leave_level, message_template });
      if (!rule) {
        return res.status(404).json({ error: '规则不存在' });
      }
      await fenceEngine.reloadFences();
      res.json(rule);
    } catch (err) {
      console.error('[API] 更新告警规则失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/rules/:id', async (req, res) => {
    const { id } = req.params;
    await FenceAlertRuleModel.delete(id);
    await fenceEngine.reloadFences();
    res.json({ success: true });
  });

  app.get('/api/fences/:id/actions', async (req, res) => {
    const { id } = req.params;
    const actions = await FenceActionModel.getByFenceId(id);
    res.json(actions);
  });

  app.post('/api/fences/:id/actions', async (req, res) => {
    const { id } = req.params;
    const { action_type, trigger_condition, target_group_id, action_config } = req.body;
    if (!action_type || !['webhook', 'speed_limit', 'fence_activate'].includes(action_type)) {
      return res.status(400).json({ error: '无效的动作类型' });
    }
    if (!trigger_condition || !['enter', 'leave', 'both'].includes(trigger_condition)) {
      return res.status(400).json({ error: '无效的触发条件' });
    }
    if (!action_config) {
      return res.status(400).json({ error: '需要指定action_config' });
    }
    const action = await FenceActionModel.create({
      fence_id: id,
      action_type,
      trigger_condition,
      target_group_id,
      action_config
    });
    await fenceEngine.reloadFences();
    res.status(201).json(action);
  });

  app.put('/api/actions/:id', async (req, res) => {
    const { id } = req.params;
    const { trigger_condition, target_group_id, action_config } = req.body;
    const action = await FenceActionModel.update(id, { trigger_condition, target_group_id, action_config });
    if (!action) {
      return res.status(404).json({ error: '动作不存在' });
    }
    await fenceEngine.reloadFences();
    res.json(action);
  });

  app.delete('/api/actions/:id', async (req, res) => {
    const { id } = req.params;
    await FenceActionModel.delete(id);
    await fenceEngine.reloadFences();
    res.json({ success: true });
  });

  app.get('/api/groups', async (req, res) => {
    const groups = await TargetGroupModel.getAll();
    res.json(groups);
  });

  app.get('/api/groups/:id', async (req, res) => {
    const { id } = req.params;
    const group = await TargetGroupModel.getById(id);
    if (!group) {
      return res.status(404).json({ error: '分组不存在' });
    }
    res.json(group);
  });

  app.post('/api/groups', async (req, res) => {
    const { name, color, description, default_level } = req.body;
    if (!name || !color) {
      return res.status(400).json({ error: '名称和颜色是必填项' });
    }
    const existing = await TargetGroupModel.getByName(name);
    if (existing) {
      return res.status(400).json({ error: '分组名称已存在' });
    }
    const group = await TargetGroupModel.create({ name, color, description, default_level });
    res.status(201).json(group);
  });

  app.put('/api/groups/:id', async (req, res) => {
    const { id } = req.params;
    const { name, color, description, default_level } = req.body;
    const existing = await TargetGroupModel.getById(id);
    if (!existing) {
      return res.status(404).json({ error: '分组不存在' });
    }
    if (name && name !== existing.name) {
      const nameExists = await TargetGroupModel.getByName(name);
      if (nameExists) {
        return res.status(400).json({ error: '分组名称已存在' });
      }
    }
    const group = await TargetGroupModel.update(id, { name, color, description, default_level });
    res.json(group);
  });

  app.delete('/api/groups/:id', async (req, res) => {
    const { id } = req.params;
    try {
      await TargetGroupModel.delete(id);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/groups/:id/summary', async (req, res) => {
    const { id } = req.params;
    const group = await TargetGroupModel.getById(id);
    if (!group) {
      return res.status(404).json({ error: '分组不存在' });
    }
    const levelStats = await AlertModel.getTodayGroupStats(id);
    const topFences = await AlertModel.getGroupFenceStats(id, 3);
    const targets = gpsSimulator.getAllTargets();
    const groupTargets = await TargetBindingModel.getGroupTargets(id);
    const targetIds = new Set(groupTargets.map(gt => gt.target_id));
    const positionSnapshot = targets
      .filter(t => targetIds.has(t.id))
      .map(t => ({
        id: t.id,
        name: t.name,
        lng: t.lng,
        lat: t.lat,
        bearing: t.bearing,
        timestamp: Date.now()
      }));
    res.json({
      group,
      today_alerts_by_level: levelStats,
      top_fences: topFences,
      position_snapshot: positionSnapshot
    });
  });

  app.get('/api/targets', async (req, res) => {
    const targets = gpsSimulator.getAllTargets();
    const result = [];
    for (const target of targets) {
      const binding = await TargetBindingModel.getBinding(target.id);
      result.push({
        id: target.id,
        name: target.name,
        color: target.color,
        lng: target.lng,
        lat: target.lat,
        bearing: target.bearing,
        timestamp: Date.now(),
        group_id: binding ? binding.group_id : null,
        group_name: binding ? binding.group_name : null,
        group_color: binding ? binding.group_color : null,
        bound_at: binding ? binding.bound_at : null
      });
    }
    res.json(result);
  });

  app.put('/api/targets/:id/bind', async (req, res) => {
    const { id } = req.params;
    const { group_id } = req.body;
    if (!group_id) {
      return res.status(400).json({ error: '需要指定group_id' });
    }
    const group = await TargetGroupModel.getById(group_id);
    if (!group) {
      return res.status(404).json({ error: '分组不存在' });
    }
    const binding = await TargetBindingModel.bind(id, group_id);
    res.json(binding);
  });

  app.put('/api/targets/:id/unbind', async (req, res) => {
    const { id } = req.params;
    await TargetBindingModel.unbind(id);
    res.json({ success: true });
  });

  app.get('/api/alerts', async (req, res) => {
    const { target_id, fence_id, start_time, end_time, level, limit, offset, group_id } = req.query;
    const alerts = await AlertModel.query({
      target_id,
      fence_id: fence_id ? parseInt(fence_id) : undefined,
      start_time,
      end_time,
      level,
      group_id: group_id ? parseInt(group_id) : undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0
    });
    res.json(alerts);
  });

  app.get('/api/statistics', (req, res) => {
    res.json(fenceEngine.getStatistics());
  });

  app.get('/api/status', async (req, res) => {
    const targets = gpsSimulator.getAllTargets();
    const pendingOrders = await WorkOrderModel.query({ status: 'pending', limit: 1 });
    const escalatedOrders = await WorkOrderModel.query({ status: 'escalated', limit: 1 });
    const patrolTasks = await PatrolTaskModel.count();
    const activePatrolTasks = patrolEngine ? patrolEngine.getAllActiveProgress().length : 0;
    const behaviorProfiles = behaviorEngine ? behaviorEngine.getAllProfiles() : [];
    const todayAnomalies = await BehaviorAnomalyModel.query({
      start_time: new Date().setHours(0, 0, 0, 0),
      limit: 1
    });
    res.json({
      online_targets: targets.length,
      total_alerts: await AlertModel.getTodayCount(),
      total_work_orders: await WorkOrderModel.count(),
      pending_work_orders: pendingOrders.length,
      escalated_work_orders: escalatedOrders.length,
      total_patrol_tasks: patrolTasks,
      active_patrol_tasks: activePatrolTasks,
      ws_connections: clients.size,
      simulator_running: gpsSimulator.isRunning,
      replay_active: replayManager.isReplaying(),
      escalation_scanner_running: workOrderEngine ? workOrderEngine.escalationTimer !== null : false,
      patrol_scheduler_running: patrolEngine ? patrolEngine.isRunning : false,
      behavior_profile_count: behaviorProfiles.length,
      today_behavior_anomalies: todayAnomalies.length,
      behavior_hourly_update_running: behaviorEngine ? behaviorEngine.hourlyTimer !== null : false
    });
  });

  app.get('/api/pois', async (req, res) => {
    res.json(await POIModel.getAll());
  });

  app.post('/api/pois', async (req, res) => {
    const { name, lng, lat, color } = req.body;
    if (!name || lng === undefined || lat === undefined) {
      return res.status(400).json({ error: '参数不完整' });
    }
    const poi = await POIModel.create({ name, lng: parseFloat(lng), lat: parseFloat(lat), color });
    broadcast({ type: 'poi_created', data: poi });
    res.status(201).json(poi);
  });

  app.delete('/api/pois/:id', async (req, res) => {
    const { id } = req.params;
    await POIModel.delete(id);
    broadcast({ type: 'poi_deleted', data: { id: parseInt(id) } });
    res.json({ success: true });
  });

  app.get('/api/trajectory', async (req, res) => {
    const { target_id, start_time, end_time, group_id, interval, limit } = req.query;
    if (!target_id) {
      return res.status(400).json({ error: '需要指定target_id' });
    }
    try {
      const points = await TrajectoryModel.query({
        target_id,
        start_time: start_time ? parseInt(start_time) : undefined,
        end_time: end_time ? parseInt(end_time) : undefined,
        group_id: group_id !== undefined ? parseInt(group_id) : undefined,
        interval: interval ? parseInt(interval) : 0,
        limit: limit ? parseInt(limit) : 10000
      });
      res.json({
        target_id,
        count: points.length,
        points
      });
    } catch (err) {
      console.error('[API] 轨迹查询失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/trajectory/stays', async (req, res) => {
    const { target_id, start_time, end_time, stay_radius, min_duration } = req.query;
    if (!target_id) {
      return res.status(400).json({ error: '需要指定target_id' });
    }
    try {
      const stays = await TrajectoryModel.getStays({
        target_id,
        start_time: start_time ? parseInt(start_time) : undefined,
        end_time: end_time ? parseInt(end_time) : undefined,
        stay_radius: stay_radius ? parseFloat(stay_radius) : 0.0005,
        min_duration: min_duration ? parseInt(min_duration) : 60000
      });
      res.json({
        target_id,
        count: stays.length,
        stays
      });
    } catch (err) {
      console.error('[API] 停留点分析失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/replay/status', (req, res) => {
    try {
      const status = replayManager.getCurrentReplay();
      res.json(status || { is_running: false });
    } catch (err) {
      console.error('[API] 获取回放状态失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/replay/start', async (req, res) => {
    const { target_id, start_time, end_time, speed } = req.body;
    if (!target_id) {
      return res.status(400).json({ error: '需要指定target_id' });
    }
    if (!start_time || !end_time) {
      return res.status(400).json({ error: '需要指定start_time和end_time' });
    }
    try {
      const result = await replayManager.startReplay({
        target_id,
        start_time: parseInt(start_time),
        end_time: parseInt(end_time),
        speed: speed ? parseInt(speed) : 1
      });
      res.json(result);
    } catch (err) {
      console.error('[API] 启动回放失败:', err);
      if (err.message === '当前已有回放任务在进行中，请先停止') {
        res.status(409).json({ error: err.message });
      } else {
        res.status(400).json({ error: err.message });
      }
    }
  });

  app.post('/api/replay/pause', (req, res) => {
    try {
      const result = replayManager.pauseReplay();
      res.json(result);
    } catch (err) {
      console.error('[API] 暂停回放失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/replay/resume', (req, res) => {
    try {
      const result = replayManager.resumeReplay();
      res.json(result);
    } catch (err) {
      console.error('[API] 恢复回放失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/replay/seek', (req, res) => {
    const { index } = req.body;
    if (index === undefined) {
      return res.status(400).json({ error: '需要指定index' });
    }
    try {
      const result = replayManager.seekToIndex(parseInt(index));
      res.json(result);
    } catch (err) {
      console.error('[API] 跳转回放失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/replay/speed', (req, res) => {
    const { speed } = req.body;
    if (speed === undefined) {
      return res.status(400).json({ error: '需要指定speed' });
    }
    try {
      const result = replayManager.setSpeed(parseInt(speed));
      res.json(result);
    } catch (err) {
      console.error('[API] 设置回放速度失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/replay/stop', (req, res) => {
    try {
      const result = replayManager.stopReplay();
      res.json(result);
    } catch (err) {
      console.error('[API] 停止回放失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/heatmap', async (req, res) => {
    try {
      const latest = await heatmapManager.getLatestSnapshot();
      if (!latest) {
        return res.json({ cells: [], max_value: 0, total_points: 0 });
      }
      res.json(latest);
    } catch (err) {
      console.error('[API] 获取热力图失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/heatmap/refresh', async (req, res) => {
    try {
      const result = await heatmapManager.aggregateHeatmap();
      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[API] 刷新热力图失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/fence-event-ranking', async (req, res) => {
    const { start_time, end_time, group_id, event_type, limit, range } = req.query;
    let startTime, endTime;
    const now = Date.now();

    if (range === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      startTime = today.getTime();
      endTime = now;
    } else if (range === 'week') {
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      startTime = weekAgo.getTime();
      endTime = now;
    } else {
      startTime = start_time ? parseInt(start_time) : undefined;
      endTime = end_time ? parseInt(end_time) : undefined;
    }

    try {
      const ranking = await TrajectoryModel.getFenceEventRanking({
        start_time: startTime,
        end_time: endTime,
        group_id: group_id !== undefined && group_id !== '' ? parseInt(group_id) : undefined,
        event_type: event_type || undefined,
        limit: limit ? parseInt(limit) : 20
      });
      res.json({
        range: range || 'custom',
        start_time: startTime,
        end_time: endTime,
        count: ranking.length,
        ranking
      });
    } catch (err) {
      console.error('[API] 围栏事件排名失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/duty-schedules', async (req, res) => {
    try {
      const schedules = await DutyScheduleModel.getAll();
      res.json(schedules);
    } catch (err) {
      console.error('[API] 查询排班失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/duty-schedules/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const schedule = await DutyScheduleModel.getById(parseInt(id));
      if (!schedule) return res.status(404).json({ error: '排班记录不存在' });
      res.json(schedule);
    } catch (err) {
      console.error('[API] 查询排班失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/duty-schedules/fence/:fence_id/current', async (req, res) => {
    try {
      const { fence_id } = req.params;
      const fenceId = parseInt(fence_id);
      const fence = await FenceModel.getById(fenceId);
      if (!fence) return res.status(404).json({ error: '围栏不存在' });
      const schedules = await DutyScheduleModel.getByFenceIdsAndTime([fenceId]);
      res.json({
        fence_id: fenceId,
        fence_name: fence.name,
        query_time: new Date().toISOString(),
        on_duty_officers: schedules
      });
    } catch (err) {
      console.error('[API] 查询当前值班人失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/duty-schedules', async (req, res) => {
    try {
      const { officer_name, contact, fence_ids, time_slots, priority } = req.body;
      if (!officer_name || !contact) {
        return res.status(400).json({ error: '值班人姓名和联系方式是必填项' });
      }
      if (!Array.isArray(fence_ids) || fence_ids.length === 0) {
        return res.status(400).json({ error: '必须指定至少一个负责的围栏' });
      }
      if (!Array.isArray(time_slots) || time_slots.length === 0) {
        return res.status(400).json({ error: '必须指定至少一个生效时段' });
      }
      for (const slot of time_slots) {
        if (!Array.isArray(slot.weekdays) || !slot.start_time || !slot.end_time) {
          return res.status(400).json({ error: '时段格式错误，需要 weekdays + start_time + end_time' });
        }
      }
      const schedule = await DutyScheduleModel.create({
        officer_name, contact, fence_ids, time_slots,
        priority: priority !== undefined ? parseInt(priority) : 1
      });
      res.status(201).json(schedule);
    } catch (err) {
      console.error('[API] 创建排班失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/duty-schedules/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { officer_name, contact, fence_ids, time_slots, priority } = req.body;
      const existing = await DutyScheduleModel.getById(parseInt(id));
      if (!existing) return res.status(404).json({ error: '排班记录不存在' });
      if (time_slots !== undefined) {
        if (!Array.isArray(time_slots) || time_slots.length === 0) {
          return res.status(400).json({ error: '必须指定至少一个生效时段' });
        }
        for (const slot of time_slots) {
          if (!Array.isArray(slot.weekdays) || !slot.start_time || !slot.end_time) {
            return res.status(400).json({ error: '时段格式错误' });
          }
        }
      }
      if (fence_ids !== undefined && (!Array.isArray(fence_ids) || fence_ids.length === 0)) {
        return res.status(400).json({ error: '必须指定至少一个负责的围栏' });
      }
      const schedule = await DutyScheduleModel.update(parseInt(id), {
        officer_name, contact, fence_ids, time_slots,
        priority: priority !== undefined ? parseInt(priority) : undefined
      });
      res.json(schedule);
    } catch (err) {
      console.error('[API] 更新排班失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/duty-schedules/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await DutyScheduleModel.getById(parseInt(id));
      if (!existing) return res.status(404).json({ error: '排班记录不存在' });
      await DutyScheduleModel.delete(parseInt(id));
      res.json({ success: true });
    } catch (err) {
      console.error('[API] 删除排班失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/work-orders', async (req, res) => {
    try {
      const { officer, fence_id, status, start_time, end_time, limit, offset } = req.query;
      const orders = await WorkOrderModel.query({
        officer,
        fence_id: fence_id !== undefined ? parseInt(fence_id) : undefined,
        status,
        start_time: start_time ? parseInt(start_time) : undefined,
        end_time: end_time ? parseInt(end_time) : undefined,
        limit: limit ? parseInt(limit) : 100,
        offset: offset ? parseInt(offset) : 0
      });
      res.json(orders);
    } catch (err) {
      console.error('[API] 查询工单失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/work-orders/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const order = await WorkOrderModel.getById(parseInt(id));
      if (!order) return res.status(404).json({ error: '工单不存在' });
      res.json(order);
    } catch (err) {
      console.error('[API] 查询工单失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/work-orders/:id/lifecycle', async (req, res) => {
    try {
      const { id } = req.params;
      const lifecycle = await workOrderEngine.getWorkOrderLifecycle(parseInt(id));
      if (!lifecycle) return res.status(404).json({ error: '工单不存在' });
      res.json(lifecycle);
    } catch (err) {
      console.error('[API] 查询工单生命周期失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/work-orders/:id/claim', async (req, res) => {
    try {
      const { id } = req.params;
      const { officer_name } = req.body;
      if (!officer_name) return res.status(400).json({ error: '必须提供值班人姓名 officer_name' });
      const updated = await workOrderEngine.claimWorkOrder(parseInt(id), officer_name);
      res.json(updated);
    } catch (err) {
      console.error('[API] 认领工单失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/work-orders/:id/process', async (req, res) => {
    try {
      const { id } = req.params;
      const { officer_name } = req.body;
      if (!officer_name) return res.status(400).json({ error: '必须提供值班人姓名 officer_name' });
      const updated = await workOrderEngine.startProcessing(parseInt(id), officer_name);
      res.json(updated);
    } catch (err) {
      console.error('[API] 处理工单失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/work-orders/:id/resolve', async (req, res) => {
    try {
      const { id } = req.params;
      const { officer_name, resolution_note } = req.body;
      if (!officer_name) return res.status(400).json({ error: '必须提供值班人姓名 officer_name' });
      if (!resolution_note) return res.status(400).json({ error: '必须填写处理备注 resolution_note' });
      const updated = await workOrderEngine.resolveWorkOrder(parseInt(id), officer_name, resolution_note);
      res.json(updated);
    } catch (err) {
      console.error('[API] 关闭工单失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/work-orders-stats/officers', async (req, res) => {
    try {
      const { start_time, end_time } = req.query;
      const stats = await WorkOrderModel.getOfficerStats(
        start_time ? parseInt(start_time) : undefined,
        end_time ? parseInt(end_time) : undefined
      );
      res.json(stats);
    } catch (err) {
      console.error('[API] 值班人统计失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/patrol-tasks', async (req, res) => {
    try {
      const { target_id, status, start_time, end_time, limit, offset } = req.query;
      const tasks = await PatrolTaskModel.query({
        target_id,
        status,
        start_time: start_time ? parseInt(start_time) : undefined,
        end_time: end_time ? parseInt(end_time) : undefined,
        limit: limit ? parseInt(limit) : 100,
        offset: offset ? parseInt(offset) : 0
      });
      res.json(tasks);
    } catch (err) {
      console.error('[API] 查询巡检任务失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/patrol-tasks/active/progress', async (req, res) => {
    try {
      const progressList = patrolEngine.getAllActiveProgress();
      res.json({ count: progressList.length, items: progressList });
    } catch (err) {
      console.error('[API] 获取进行中任务进度失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/patrol-tasks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const task = await PatrolTaskModel.getById(parseInt(id));
      if (!task) {
        return res.status(404).json({ error: '任务不存在' });
      }
      res.json(task);
    } catch (err) {
      console.error('[API] 获取巡检任务失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/patrol-tasks', async (req, res) => {
    try {
      const { task_name, target_id, target_name, frequency, planned_start_time, deadline_time, fence_ids } = req.body;
      
      if (!task_name || !target_id || !planned_start_time || !deadline_time || !fence_ids) {
        return res.status(400).json({ error: '参数不完整，需要 task_name、target_id、planned_start_time、deadline_time、fence_ids' });
      }
      
      if (!Array.isArray(fence_ids) || fence_ids.length === 0) {
        return res.status(400).json({ error: 'fence_ids 必须是非空数组' });
      }
      
      if (frequency && !['once', 'daily', 'weekly'].includes(frequency)) {
        return res.status(400).json({ error: 'frequency 只能是 once、daily、weekly' });
      }
      
      const task = await patrolEngine.createTask({
        task_name,
        target_id,
        target_name,
        frequency: frequency || 'once',
        planned_start_time: parseInt(planned_start_time),
        deadline_time: parseInt(deadline_time),
        fence_ids: fence_ids.map(Number)
      });
      
      res.status(201).json(task);
    } catch (err) {
      console.error('[API] 创建巡检任务失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/patrol-tasks/:id/cancel', async (req, res) => {
    try {
      const { id } = req.params;
      const task = await patrolEngine.cancelTask(parseInt(id));
      res.json(task);
    } catch (err) {
      console.error('[API] 取消巡检任务失败:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/patrol-tasks/:id/progress', async (req, res) => {
    try {
      const { id } = req.params;
      const progress = patrolEngine.getTaskProgress(parseInt(id));
      if (!progress) {
        const task = await PatrolTaskModel.getById(parseInt(id));
        if (!task) {
          return res.status(404).json({ error: '任务不存在' });
        }
        const totalWaypoints = task.waypoints.length;
        const arrivedCount = task.waypoints.filter(w => w.arrived_at).length;
        res.json({
          task_id: task.id,
          task_name: task.task_name,
          status: task.status,
          target_id: task.target_id,
          target_name: task.target_name,
          current_waypoint_index: task.current_waypoint_index,
          current_waypoint: task.current_waypoint_index < totalWaypoints ? task.waypoints[task.current_waypoint_index] : null,
          next_waypoint: task.current_waypoint_index + 1 < totalWaypoints ? task.waypoints[task.current_waypoint_index + 1] : null,
          arrived_count: arrivedCount,
          total_waypoints: totalWaypoints,
          progress_percent: totalWaypoints > 0 ? Math.round((arrivedCount / totalWaypoints) * 1000) / 10 : 0,
          elapsed_seconds: task.actual_start_time ? Math.round((Date.now() - task.actual_start_time) / 1000) : 0,
          remaining_seconds: Math.max(0, Math.round((task.deadline_time - Date.now()) / 1000)),
          planned_start_time: task.planned_start_time,
          deadline_time: task.deadline_time,
          actual_start_time: task.actual_start_time,
          completed_time: task.completed_time,
          waypoints: task.waypoints
        });
        return;
      }
      res.json(progress);
    } catch (err) {
      console.error('[API] 获取任务进度失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/patrol-stats/targets', async (req, res) => {
    try {
      const { start_time, end_time } = req.query;
      const stats = await PatrolTaskModel.getTargetStats(
        start_time ? parseInt(start_time) : undefined,
        end_time ? parseInt(end_time) : undefined
      );
      res.json(stats);
    } catch (err) {
      console.error('[API] 获取目标巡检统计失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/patrol-stats/fence-coverage', async (req, res) => {
    try {
      const { start_time, end_time } = req.query;
      const stats = await PatrolTaskModel.getFenceCoverageStats(
        start_time ? parseInt(start_time) : undefined,
        end_time ? parseInt(end_time) : undefined
      );
      res.json(stats);
    } catch (err) {
      console.error('[API] 获取围栏覆盖统计失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-profiles', async (req, res) => {
    try {
      const profiles = behaviorEngine.getAllProfiles();
      res.json({ count: profiles.length, profiles });
    } catch (err) {
      console.error('[API] 获取行为画像列表失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-profiles/:target_id', async (req, res) => {
    try {
      const { target_id } = req.params;
      const { limit } = req.query;
      if (limit !== undefined) {
        const profiles = await BehaviorProfileModel.getByTarget(target_id, parseInt(limit));
        res.json({ target_id, count: profiles.length, profiles });
      } else {
        const profile = behaviorEngine.getProfile(target_id);
        if (!profile) {
          return res.status(404).json({ error: '未找到该目标的行为画像' });
        }
        res.json(profile);
      }
    } catch (err) {
      console.error('[API] 获取行为画像失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/behavior-profiles/refresh', async (req, res) => {
    try {
      const count = await behaviorEngine.updateAllProfiles();
      res.json({ success: true, updated_count: count });
    } catch (err) {
      console.error('[API] 刷新行为画像失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/behavior-profiles/:target_id/refresh', async (req, res) => {
    try {
      const { target_id } = req.params;
      const profile = await behaviorEngine.buildProfile(target_id);
      if (!profile) {
        return res.status(404).json({ error: '未找到该目标的轨迹数据' });
      }
      res.json(profile);
    } catch (err) {
      console.error('[API] 刷新目标行为画像失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-profiles/compare/:target_id1/:target_id2', async (req, res) => {
    try {
      const { target_id1, target_id2 } = req.params;
      const result = await behaviorEngine.compareProfiles(target_id1, target_id2);
      if (!result) {
        return res.status(404).json({ error: '未找到目标画像，无法对比' });
      }
      res.json(result);
    } catch (err) {
      console.error('[API] 画像对比失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-anomalies', async (req, res) => {
    try {
      const { target_id, anomaly_type, start_time, end_time, group_id, limit, offset } = req.query;
      const anomalies = await BehaviorAnomalyModel.query({
        target_id,
        anomaly_type,
        start_time: start_time ? parseInt(start_time) : undefined,
        end_time: end_time ? parseInt(end_time) : undefined,
        group_id: group_id !== undefined && group_id !== '' ? parseInt(group_id) : undefined,
        limit: limit ? parseInt(limit) : 100,
        offset: offset ? parseInt(offset) : 0
      });
      res.json({ count: anomalies.length, anomalies });
    } catch (err) {
      console.error('[API] 查询异常事件失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-anomalies/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const anomaly = await BehaviorAnomalyModel.getById(parseInt(id));
      if (!anomaly) {
        return res.status(404).json({ error: '异常事件不存在' });
      }
      res.json(anomaly);
    } catch (err) {
      console.error('[API] 获取异常事件详情失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-anomaly-stats/targets', async (req, res) => {
    try {
      const { start_time, end_time } = req.query;
      const stats = await BehaviorAnomalyModel.getTargetStats(
        start_time ? parseInt(start_time) : undefined,
        end_time ? parseInt(end_time) : undefined
      );
      res.json(stats);
    } catch (err) {
      console.error('[API] 获取目标异常统计失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/behavior-anomaly-stats/types', async (req, res) => {
    try {
      const { start_time, end_time } = req.query;
      const stats = await BehaviorAnomalyModel.getTypeDistribution(
        start_time ? parseInt(start_time) : undefined,
        end_time ? parseInt(end_time) : undefined
      );
      res.json(stats);
    } catch (err) {
      console.error('[API] 获取异常类型分布失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const PORT = process.env.PORT || 3000;

  server.listen(PORT, async () => {
    console.log(`[Server] 服务已启动，端口: ${PORT}`);
    console.log(`[Server] http://localhost:${PORT}`);

    console.log('[Data] 正在生成历史轨迹数据...');
    try {
      await gpsSimulator.generateHistoricalTrajectory(300);
    } catch (err) {
      console.error('[Data] 生成历史轨迹数据失败:', err.message);
    }

    console.log('[Behavior] 正在构建初始行为画像...');
    try {
      await behaviorEngine.updateAllProfiles();
    } catch (err) {
      console.error('[Behavior] 初始画像构建失败:', err.message);
    }

    console.log('[Behavior] 正在预置异常事件...');
    try {
      await behaviorEngine.initPresetAnomalies();
    } catch (err) {
      console.error('[Behavior] 预置异常事件失败:', err.message);
    }

    gpsSimulator.start();
    console.log('[GPS] 模拟器已启动，5个目标正在移动');

    heatmapManager.start();
    console.log('[Heatmap] 热力聚合器已启动');

    workOrderEngine.startEscalationScanner(30000);
    patrolEngine.startScheduler(1000);
    console.log('[Patrol] 巡检任务调度器已启动');

    behaviorEngine.startHourlyUpdate();
  });

  process.on('SIGINT', () => {
    console.log('\n[Server] 正在关闭...');
    gpsSimulator.stop();
    heatmapManager.stop();
    replayManager.stopReplay();
    if (workOrderEngine) workOrderEngine.stopEscalationScanner();
    if (patrolEngine) patrolEngine.stopScheduler();
    if (behaviorEngine) behaviorEngine.stopHourlyUpdate();
    server.close(() => {
      console.log('[Server] 已关闭');
      process.exit(0);
    });
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
