const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { FenceModel, AlertModel, POIModel } = require('./database');
const { FenceEngine } = require('./fenceEngine');
const { GPSSimulator } = require('./gpsSimulator');
const { isPolygonSelfIntersecting } = require('./geometry');
const { initPresetData } = require('./presetData');

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

async function main() {
  await initPresetData(FenceModel, POIModel);

  fenceEngine = new FenceEngine(async (alert) => {
    broadcast({ type: 'alert', data: alert });
  });
  await fenceEngine.reloadFences();

  gpsSimulator = new GPSSimulator(async (position) => {
    fenceEngine.processPositionUpdate(position);
    broadcast({ type: 'position', data: position });
  });

  wss.on('connection', async (ws) => {
    clients.add(ws);
    console.log(`[WS] 客户端连接，当前连接数: ${clients.size}`);
    const targets = gpsSimulator.getAllTargets();
    targets.forEach(target => {
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
          trajectory: target.trajectory
        }
      }));
    });
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] 客户端断开，当前连接数: ${clients.size}`);
    });
    ws.on('error', (err) => {
      console.error('[WS] 错误:', err);
    });
  });

  app.get('/api/fences', async (req, res) => {
    res.json(await FenceModel.getAll());
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

  app.get('/api/alerts', async (req, res) => {
    const { target_id, fence_id, start_time, end_time, level, limit, offset } = req.query;
    const alerts = await AlertModel.query({
      target_id,
      fence_id: fence_id ? parseInt(fence_id) : undefined,
      start_time,
      end_time,
      level,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0
    });
    res.json(alerts);
  });

  app.get('/api/statistics', (req, res) => {
    res.json(fenceEngine.getStatistics());
  });

  app.get('/api/status', async (req, res) => {
    res.json({
      online_targets: 5,
      total_alerts: await AlertModel.getTodayCount(),
      ws_connections: clients.size,
      simulator_running: gpsSimulator.isRunning
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

  const PORT = process.env.PORT || 3000;

  server.listen(PORT, () => {
    console.log(`[Server] 服务已启动，端口: ${PORT}`);
    console.log(`[Server] http://localhost:${PORT}`);
    gpsSimulator.start();
    console.log('[GPS] 模拟器已启动，5个目标正在移动');
  });

  process.on('SIGINT', () => {
    console.log('\n[Server] 正在关闭...');
    gpsSimulator.stop();
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
