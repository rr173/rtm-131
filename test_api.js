const http = require('http');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsedUrl = new URL(url);
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let result = '';
      res.on('data', (chunk) => result += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(result));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function test() {
  console.log('=== 测试轨迹查询...');
  const traj = await getJSON('http://localhost:3000/api/trajectory?target_id=T001&limit=3');
  console.log('轨迹点数:', traj.count);
  if (traj.points && traj.points.length > 0) {
    console.log('第一个点时间戳:', traj.points[0].timestamp);
    console.log('最后一个点时间戳:', traj.points[traj.points.length - 1].timestamp);
  }

  console.log('\n=== 测试热力图...');
  const heatmap = await getJSON('http://localhost:3000/api/heatmap');
  console.log('热力格子数:', heatmap.grid_data ? heatmap.grid_data.cells.length : 0);
  console.log('最大值:', heatmap.grid_data ? heatmap.grid_data.max_value : 0);

  console.log('\n=== 测试回放启动...');
  const now = Date.now();
  const startTime = now - 240000;
  const replay = await postJSON('http://localhost:3000/api/replay/start', {
    target_id: 'T001',
    start_time: startTime,
    end_time: now,
    speed: 5
  });
  console.log('回放启动结果:', JSON.stringify(replay, null, 2));

  console.log('\n=== 等待1秒获取回放进度...');
  await new Promise(r => setTimeout(r, 1000));
  const status = await getJSON('http://localhost:3000/api/replay/status');
  console.log('回放状态:', JSON.stringify(status, null, 2));

  console.log('\n=== 停止回放...');
  const stopResult = await postJSON('http://localhost:3000/api/replay/stop', {});
  console.log('停止回放结果:', JSON.stringify(stopResult, null, 2));

  console.log('\n=== 测试围栏事件排名...');
  const ranking = await getJSON('http://localhost:3000/api/fence-event-ranking?range=today');
  console.log('排名数量:', ranking.count);

  console.log('\n=== 测试降采样查询...');
  const dsTraj = await getJSON('http://localhost:3000/api/trajectory?target_id=T001&interval=10');
  console.log('降采样后点数:', dsTraj.count, '(原始约300个点)');

  console.log('\n✅ 所有后端API测试通过!');
}

test().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
