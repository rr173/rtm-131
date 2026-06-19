const MAP_LNG_MIN = 116.0;
const MAP_LNG_MAX = 116.8;
const MAP_LAT_MIN = 39.5;
const MAP_LAT_MAX = 40.2;

const state = {
  currentTool: 'select',
  fences: [],
  pois: [],
  targets: new Map(),
  alerts: [],
  statistics: [],
  drawingVertices: [],
  selectedFence: null,
  draggingVertex: -1,
  draggingFence: false,
  dragStartPos: null,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  panning: false,
  panStart: null,
  panOffset: { x: 0, y: 0 },
  flashingFences: new Map(),
  highlightedTargets: new Set(),
  showTrajectory: true,
  ws: null,
  filterLevel: '',
  filterTarget: '',
  editingFenceId: null,
  fenceActiveStatus: new Map(),
  groups: [],
  showHeatmap: false,
  heatmapData: null,
  replayTarget: '',
  replaySpeed: 1,
  replayRange: 300,
  isReplaying: false,
  replayPaused: false,
  replayProgress: 0,
  replayCurrentTime: 0,
  replayTrajectory: [],
  replayPosition: null
};

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const container = canvas.parentElement;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);

function lngToX(lng) {
  const range = MAP_LNG_MAX - MAP_LNG_MIN;
  return ((lng - MAP_LNG_MIN) / range) * canvas.width * state.scale + state.panOffset.x + state.offsetX;
}

function latToY(lat) {
  const range = MAP_LAT_MAX - MAP_LAT_MIN;
  return canvas.height - ((lat - MAP_LAT_MIN) / range) * canvas.height * state.scale + state.panOffset.y + state.offsetY;
}

function xToLng(x) {
  const range = MAP_LNG_MAX - MAP_LNG_MIN;
  return ((x - state.panOffset.x - state.offsetX) / (canvas.width * state.scale)) * range + MAP_LNG_MIN;
}

function yToLat(y) {
  const range = MAP_LAT_MAX - MAP_LAT_MIN;
  return ((canvas.height - y + state.panOffset.y + state.offsetY) / (canvas.height * state.scale)) * range + MAP_LAT_MIN;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  if (state.showHeatmap && state.heatmapData) {
    drawHeatmap();
  }
  drawFences();
  drawPOIs();
  drawTrajectories();
  drawReplayTrajectory();
  drawTargets();
  if (state.currentTool === 'draw-fence' && state.drawingVertices.length > 0) {
    drawDrawingFence();
  }
  if (state.selectedFence && state.currentTool === 'select') {
    drawSelectedFenceHandles();
  }
}

function drawGrid() {
  ctx.fillStyle = '#0f0f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1e1e35';
  ctx.lineWidth = 1;
  const lngStep = 0.1;
  const latStep = 0.1;
  ctx.beginPath();
  for (let lng = Math.ceil(MAP_LNG_MIN / lngStep) * lngStep; lng <= MAP_LNG_MAX; lng += lngStep) {
    const x = lngToX(lng);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
  }
  for (let lat = Math.ceil(MAP_LAT_MIN / latStep) * latStep; lat <= MAP_LAT_MAX; lat += latStep) {
    const y = latToY(lat);
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#4a4a6a';
  ctx.font = '10px monospace';
  for (let lng = Math.ceil(MAP_LNG_MIN / lngStep) * lngStep; lng <= MAP_LNG_MAX; lng += lngStep) {
    const x = lngToX(lng);
    ctx.fillText(lng.toFixed(1), x + 4, 14);
  }
  for (let lat = Math.ceil(MAP_LAT_MIN / latStep) * latStep; lat <= MAP_LAT_MAX; lat += latStep) {
    const y = latToY(lat);
    ctx.fillText(lat.toFixed(1), 4, y - 4);
  }
  ctx.strokeStyle = '#3a3a5a';
  ctx.lineWidth = 2;
  ctx.strokeRect(
    lngToX(MAP_LNG_MIN),
    latToY(MAP_LAT_MAX),
    lngToX(MAP_LNG_MAX) - lngToX(MAP_LNG_MIN),
    latToY(MAP_LAT_MIN) - latToY(MAP_LAT_MAX)
  );
}

function drawHeatmap() {
  if (!state.heatmapData || !state.heatmapData.grid_data || !state.heatmapData.grid_data.cells) return;
  
  const cells = state.heatmapData.grid_data.cells;
  const maxValue = state.heatmapData.grid_data.max_value || 1;
  const lngStep = (MAP_LNG_MAX - MAP_LNG_MIN) / state.heatmapData.grid_lng_count;
  const latStep = (MAP_LAT_MAX - MAP_LAT_MIN) / state.heatmapData.grid_lat_count;

  cells.forEach(cell => {
    const lng = MAP_LNG_MIN + cell.grid_x * lngStep;
    const lat = MAP_LAT_MIN + cell.grid_y * latStep;
    const x = lngToX(lng);
    const y = latToY(lat + latStep);
    const w = lngToX(lng + lngStep) - x;
    const h = latToY(lat) - latToY(lat + latStep);

    const intensity = cell.value / maxValue;
    const alpha = Math.min(0.8, intensity * 0.8);
    
    let r, g, b;
    if (intensity < 0.25) {
      r = 0; g = 0; b = Math.floor(255 * (intensity * 4));
    } else if (intensity < 0.5) {
      r = 0; g = Math.floor(255 * ((intensity - 0.25) * 4)); b = 255;
    } else if (intensity < 0.75) {
      r = Math.floor(255 * ((intensity - 0.5) * 4)); g = 255; b = 255 - Math.floor(255 * ((intensity - 0.5) * 4));
    } else {
      r = 255; g = 255 - Math.floor(255 * ((intensity - 0.75) * 4)); b = 0;
    }

    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.fillRect(x, y, w, h);
  });
}

function drawFences() {
  state.fences.forEach(fence => {
    const isFlashing = state.flashingFences.has(fence.id);
    const flashColor = isFlashing ? state.flashingFences.get(fence.id) : null;
    const vertices = fence.vertices;
    const baseColor = fence.color;
    const isActive = state.fenceActiveStatus.get(fence.id) !== false;
    ctx.beginPath();
    ctx.moveTo(lngToX(vertices[0].lng), latToY(vertices[0].lat));
    for (let i = 1; i < vertices.length; i++) {
      ctx.lineTo(lngToX(vertices[i].lng), latToY(vertices[i].lat));
    }
    ctx.closePath();
    let fillColor, strokeColor, textColor;
    if (!isActive) {
      fillColor = 'rgba(100, 100, 100, 0.1)';
      strokeColor = flashColor || '#555555';
      textColor = '#666666';
    } else {
      const r = parseInt(baseColor.slice(1, 3), 16);
      const g = parseInt(baseColor.slice(3, 5), 16);
      const b = parseInt(baseColor.slice(5, 7), 16);
      fillColor = `rgba(${r}, ${g}, ${b}, 0.2)`;
      strokeColor = flashColor || baseColor;
      textColor = flashColor || baseColor;
    }
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = isFlashing ? 4 : 2;
    if (!isActive) {
      ctx.setLineDash([5, 5]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = strokeColor;
    ctx.stroke();
    ctx.setLineDash([]);
    const centerX = vertices.reduce((sum, v) => sum + v.lng, 0) / vertices.length;
    const centerY = vertices.reduce((sum, v) => sum + v.lat, 0) / vertices.length;
    ctx.fillStyle = textColor;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(fence.name + (isActive ? '' : ' (非活跃)'), lngToX(centerX), latToY(centerY));
    ctx.textAlign = 'left';
  });
}

function drawPOIs() {
  state.pois.forEach(poi => {
    const x = lngToX(poi.lng);
    const y = latToY(poi.lat);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = poi.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px sans-serif';
    ctx.fillText(poi.name, x + 10, y + 4);
  });
}

function drawTrajectories() {
  if (!state.showTrajectory) return;
  state.targets.forEach(target => {
    if (target.trajectory && target.trajectory.length > 1) {
      for (let i = 1; i < target.trajectory.length; i++) {
        const p1 = target.trajectory[i - 1];
        const p2 = target.trajectory[i];
        const alpha = i / target.trajectory.length;
        ctx.beginPath();
        ctx.moveTo(lngToX(p1.lng), latToY(p1.lat));
        ctx.lineTo(lngToX(p2.lng), latToY(p2.lat));
        const r = parseInt(target.color.slice(1, 3), 16);
        const g = parseInt(target.color.slice(3, 5), 16);
        const b = parseInt(target.color.slice(5, 7), 16);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.6})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  });
}

function drawReplayTrajectory() {
  if (!state.isReplaying || !state.replayTrajectory || state.replayTrajectory.length < 2) return;
  
  const target = state.targets.get(state.replayTarget);
  const color = target ? target.color : '#4facfe';
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  for (let i = 1; i < state.replayTrajectory.length; i++) {
    const p1 = state.replayTrajectory[i - 1];
    const p2 = state.replayTrajectory[i];
    ctx.beginPath();
    ctx.moveTo(lngToX(p1.lng), latToY(p1.lat));
    ctx.lineTo(lngToX(p2.lng), latToY(p2.lat));
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function drawTargets() {
  state.targets.forEach(target => {
    const x = lngToX(target.lng);
    const y = latToY(target.lat);
    const isHighlighted = state.highlightedTargets.has(target.id);
    const size = 12;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((target.bearing || 0) * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, size * 0.6);
    ctx.lineTo(-size * 0.3, 0);
    ctx.lineTo(-size * 0.6, -size * 0.6);
    ctx.closePath();
    ctx.fillStyle = isHighlighted ? '#ff0000' : target.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px sans-serif';
    ctx.fillText(target.name, x + 14, y + 4);
  });

  if (state.isReplaying && state.replayPosition) {
    const x = lngToX(state.replayPosition.lng);
    const y = latToY(state.replayPosition.lat);
    const size = 16;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((state.replayPosition.bearing || 0) * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, size * 0.6);
    ctx.lineTo(-size * 0.3, 0);
    ctx.lineTo(-size * 0.6, -size * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#ff6b6b';
    ctx.fill();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ffff00';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('回放: ' + (state.replayPosition.name || state.replayTarget), x + 18, y + 4);
  }
}

function drawDrawingFence() {
  const vertices = state.drawingVertices;
  if (vertices.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(lngToX(vertices[0].lng), latToY(vertices[0].lat));
  for (let i = 1; i < vertices.length; i++) {
    ctx.lineTo(lngToX(vertices[i].lng), latToY(vertices[i].lat));
  }
  ctx.strokeStyle = '#4facfe';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  vertices.forEach((v, i) => {
    const x = lngToX(v.lng);
    const y = latToY(v.lat);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#27ae60' : '#4facfe';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

function drawSelectedFenceHandles() {
  if (!state.selectedFence) return;
  state.selectedFence.vertices.forEach((v, i) => {
    const x = lngToX(v.lng);
    const y = latToY(v.lat);
    ctx.beginPath();
    ctx.rect(x - 6, y - 6, 12, 12);
    ctx.fillStyle = '#4facfe';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const lng = xToLng(x);
  const lat = yToLat(y);
  updateCoordDisplay(lng, lat);
  if (state.currentTool === 'draw-fence') {
    return;
  }
  if (state.currentTool === 'add-poi') {
    const name = prompt('请输入POI名称:');
    if (name) {
      addPOI(name, lng, lat);
    }
    return;
  }
  if (state.selectedFence) {
    for (let i = 0; i < state.selectedFence.vertices.length; i++) {
      const v = state.selectedFence.vertices[i];
      const vx = lngToX(v.lng);
      const vy = latToY(v.lat);
      if (Math.abs(x - vx) < 10 && Math.abs(y - vy) < 10) {
        state.draggingVertex = i;
        return;
      }
    }
    if (isPointInFence(lng, lat, state.selectedFence.vertices)) {
      state.draggingFence = true;
      state.dragStartPos = { lng, lat };
      return;
    }
  }
  state.panning = true;
  state.panStart = { x: e.clientX, y: e.clientY };
  canvas.classList.add('grabbing');
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const lng = xToLng(x);
  const lat = yToLat(y);
  updateCoordDisplay(lng, lat);
  if (state.currentTool === 'draw-fence') {
    render();
    if (state.drawingVertices.length > 0) {
      const lastV = state.drawingVertices[state.drawingVertices.length - 1];
      ctx.beginPath();
      ctx.moveTo(lngToX(lastV.lng), latToY(lastV.lat));
      ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(79, 172, 254, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    return;
  }
  if (state.draggingVertex >= 0 && state.selectedFence) {
    state.selectedFence.vertices[state.draggingVertex] = { lng, lat };
    render();
    return;
  }
  if (state.draggingFence && state.selectedFence && state.dragStartPos) {
    const dlng = lng - state.dragStartPos.lng;
    const dlat = lat - state.dragStartPos.lat;
    state.selectedFence.vertices = state.selectedFence.vertices.map(v => ({
      lng: v.lng + dlng,
      lat: v.lat + dlat
    }));
    state.dragStartPos = { lng, lat };
    render();
    return;
  }
  if (state.panning && state.panStart) {
    state.panOffset.x += e.clientX - state.panStart.x;
    state.panOffset.y += e.clientY - state.panStart.y;
    state.panStart = { x: e.clientX, y: e.clientY };
    render();
  }
});

canvas.addEventListener('mouseup', (e) => {
  canvas.classList.remove('grabbing');
  if (state.draggingVertex >= 0) {
    updateFence(state.selectedFence);
    state.draggingVertex = -1;
  }
  if (state.draggingFence) {
    updateFence(state.selectedFence);
    state.draggingFence = false;
    state.dragStartPos = null;
  }
  state.panning = false;
  state.panStart = null;
});

canvas.addEventListener('click', (e) => {
  if (state.currentTool !== 'draw-fence') return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const lng = xToLng(x);
  const lat = yToLat(y);
  state.drawingVertices.push({ lng, lat });
  render();
});

canvas.addEventListener('dblclick', (e) => {
  if (state.currentTool !== 'draw-fence') return;
  e.preventDefault();
  if (state.drawingVertices.length >= 3) {
    showFenceDialog();
  } else {
    alert('围栏至少需要3个顶点');
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.5, Math.min(5, state.scale * delta));
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const lng = xToLng(mouseX);
  const lat = yToLat(mouseY);
  state.scale = newScale;
  state.offsetX = mouseX - lngToX(lng) + state.offsetX;
  state.offsetY = mouseY - latToY(lat) + state.offsetY;
  document.getElementById('zoomDisplay').textContent = Math.round(state.scale * 100) + '%';
  render();
});

function isPointInFence(lng, lat, vertices) {
  const EPSILON = 1e-8;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].lng, yi = vertices[i].lat;
    const xj = vertices[j].lng, yj = vertices[j].lat;
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function findFenceAt(lng, lat) {
  for (let i = state.fences.length - 1; i >= 0; i--) {
    if (isPointInFence(lng, lat, state.fences[i].vertices)) {
      return state.fences[i];
    }
  }
  return null;
}

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.currentTool !== 'select') return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const lng = xToLng(x);
  const lat = yToLat(y);
  const fence = findFenceAt(lng, lat);
  if (fence) {
    state.selectedFence = JSON.parse(JSON.stringify(fence));
    showEditDialog(fence);
  } else {
    state.selectedFence = null;
  }
  updateFenceList();
  render();
});

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentTool = btn.dataset.tool;
    state.drawingVertices = [];
    if (state.currentTool !== 'select') {
      state.selectedFence = null;
    }
    canvas.classList.toggle('drawing', state.currentTool === 'draw-fence');
    updateFenceList();
    render();
  });
});

document.getElementById('clearTrajectory').addEventListener('click', () => {
  state.targets.forEach(t => {
    if (t.trajectory) t.trajectory = [];
  });
  render();
});

document.getElementById('toggleHeatmap').addEventListener('click', () => {
  state.showHeatmap = !state.showHeatmap;
  document.getElementById('toggleHeatmap').classList.toggle('active', state.showHeatmap);
  render();
  if (state.showHeatmap && !state.heatmapData) {
    loadHeatmap();
  }
});

document.getElementById('resetView').addEventListener('click', () => {
  state.scale = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  state.panOffset = { x: 0, y: 0 };
  document.getElementById('zoomDisplay').textContent = '100%';
  render();
});

document.getElementById('zoomIn').addEventListener('click', () => {
  state.scale = Math.min(5, state.scale * 1.2);
  document.getElementById('zoomDisplay').textContent = Math.round(state.scale * 100) + '%';
  render();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  state.scale = Math.max(0.5, state.scale / 1.2);
  document.getElementById('zoomDisplay').textContent = Math.round(state.scale * 100) + '%';
  render();
});

document.getElementById('filterLevel').addEventListener('change', (e) => {
  state.filterLevel = e.target.value;
  updateAlertList();
});

document.getElementById('filterTarget').addEventListener('change', (e) => {
  state.filterTarget = e.target.value;
  updateAlertList();
});

function updateCoordDisplay(lng, lat) {
  document.getElementById('coordDisplay').textContent =
    `${lng.toFixed(4)}, ${lat.toFixed(4)}`;
}

function showFenceDialog() {
  document.getElementById('fenceDialog').style.display = 'block';
  document.getElementById('fenceName').value = '';
  document.getElementById('fenceType').value = 'normal';
  document.getElementById('fenceColor').value = '#3498db';
}

function hideFenceDialog() {
  document.getElementById('fenceDialog').style.display = 'none';
}

document.getElementById('cancelFence').addEventListener('click', () => {
  hideFenceDialog();
  state.drawingVertices = [];
  render();
});

document.getElementById('saveFence').addEventListener('click', () => {
  const name = document.getElementById('fenceName').value.trim();
  const type = document.getElementById('fenceType').value;
  const color = document.getElementById('fenceColor').value;
  if (!name) {
    alert('请输入围栏名称');
    return;
  }
  createFence(name, type, color, state.drawingVertices);
  hideFenceDialog();
  state.drawingVertices = [];
});

function showEditDialog(fence) {
  state.editingFenceId = fence.id;
  document.getElementById('editDialog').style.display = 'block';
  document.getElementById('editFenceName').value = fence.name;
  document.getElementById('editFenceType').value = fence.type;
  document.getElementById('editFenceColor').value = fence.color;
}

function hideEditDialog() {
  document.getElementById('editDialog').style.display = 'none';
  state.editingFenceId = null;
  state.selectedFence = null;
  render();
}

document.getElementById('cancelEdit').addEventListener('click', hideEditDialog);

document.getElementById('saveEdit').addEventListener('click', () => {
  if (!state.editingFenceId || !state.selectedFence) return;
  const name = document.getElementById('editFenceName').value.trim();
  const type = document.getElementById('editFenceType').value;
  const color = document.getElementById('editFenceColor').value;
  if (!name) {
    alert('请输入围栏名称');
    return;
  }
  state.selectedFence.name = name;
  state.selectedFence.type = type;
  state.selectedFence.color = color;
  updateFence(state.selectedFence);
  hideEditDialog();
});

document.getElementById('deleteFence').addEventListener('click', () => {
  if (!state.editingFenceId) return;
  if (confirm('确定要删除这个围栏吗？')) {
    deleteFence(state.editingFenceId);
    hideEditDialog();
  }
});

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.replaySpeed = parseInt(btn.dataset.speed);
  });
});

document.getElementById('replayRange').addEventListener('change', (e) => {
  state.replayRange = parseInt(e.target.value);
});

document.getElementById('btnStartReplay').addEventListener('click', startReplay);
document.getElementById('btnPauseReplay').addEventListener('click', togglePauseReplay);
document.getElementById('btnStopReplay').addEventListener('click', stopReplay);

async function startReplay() {
  const targetId = document.getElementById('replayTarget').value;
  if (!targetId) {
    alert('请选择要回放的目标');
    return;
  }

  const now = Date.now();
  const startTime = now - state.replayRange * 1000;

  try {
    const res = await fetch('/api/replay/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_id: targetId,
        start_time: startTime,
        end_time: now,
        speed: state.replaySpeed
      })
    });

    if (!res.ok) {
      const err = await res.json();
      alert('启动回放失败: ' + err.error);
      return;
    }

    const trajRes = await fetch(`/api/trajectory?target_id=${targetId}&start_time=${startTime}&end_time=${now}&interval=5`);
    const trajData = await trajRes.json();
    state.replayTrajectory = trajData.points || [];
    state.replayTarget = targetId;
    state.isReplaying = true;
    state.replayPaused = false;

    updateReplayControls();
  } catch (e) {
    alert('启动回放失败: ' + e.message);
  }
}

function togglePauseReplay() {
  if (!state.isReplaying) return;
  
  if (state.replayPaused) {
    fetch('/api/replay/resume', { method: 'POST' });
    state.replayPaused = false;
  } else {
    fetch('/api/replay/pause', { method: 'POST' });
    state.replayPaused = true;
  }
  updateReplayControls();
}

function stopReplay() {
  fetch('/api/replay/stop', { method: 'POST' });
  state.isReplaying = false;
  state.replayPaused = false;
  state.replayPosition = null;
  state.replayTrajectory = [];
  state.replayProgress = 0;
  state.replayCurrentTime = 0;
  updateReplayControls();
  updateReplayProgress();
  render();
}

function updateReplayControls() {
  document.getElementById('btnStartReplay').disabled = state.isReplaying;
  document.getElementById('btnPauseReplay').disabled = !state.isReplaying;
  document.getElementById('btnStopReplay').disabled = !state.isReplaying;
  document.getElementById('btnPauseReplay').textContent = state.replayPaused ? '▶ 继续' : '⏸ 暂停';
}

function updateReplayProgress() {
  const fill = document.getElementById('replayProgressFill');
  const text = document.getElementById('replayProgressText');
  const time = document.getElementById('replayCurrentTime');
  
  fill.style.width = state.replayProgress + '%';
  text.textContent = Math.round(state.replayProgress) + '%';
  
  if (state.replayCurrentTime) {
    const d = new Date(state.replayCurrentTime);
    time.textContent = d.toLocaleTimeString();
  } else {
    time.textContent = '--:--:--';
  }
}

function updateReplayTargetSelect() {
  const select = document.getElementById('replayTarget');
  const currentValue = select.value;
  select.innerHTML = '<option value="">请选择目标</option>';
  state.targets.forEach(target => {
    const opt = document.createElement('option');
    opt.value = target.id;
    opt.textContent = target.name;
    if (target.id === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
}

async function loadFences() {
  const res = await fetch('/api/fences');
  state.fences = await res.json();
  state.fences.forEach(f => {
    if (f.is_active !== undefined) {
      state.fenceActiveStatus.set(f.id, f.is_active);
    }
  });
  updateFenceList();
  render();
}

async function loadPOIs() {
  const res = await fetch('/api/pois');
  state.pois = await res.json();
  render();
}

async function loadStatistics() {
  const res = await fetch('/api/statistics');
  state.statistics = await res.json();
  updateFenceList();
}

async function loadAlerts() {
  const res = await fetch('/api/alerts?limit=50');
  state.alerts = await res.json();
  updateAlertList();
  updateStatusBar();
}

async function loadHeatmap() {
  try {
    const res = await fetch('/api/heatmap');
    state.heatmapData = await res.json();
    if (state.showHeatmap) {
      render();
    }
  } catch (e) {
    console.error('加载热力图失败:', e);
  }
}

async function createFence(name, type, color, vertices) {
  try {
    const res = await fetch('/api/fences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, color, vertices })
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error);
      return;
    }
    await loadFences();
    await loadStatistics();
  } catch (e) {
    alert('创建围栏失败: ' + e.message);
  }
}

async function updateFence(fence) {
  try {
    const res = await fetch(`/api/fences/${fence.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fence.name,
        type: fence.type,
        color: fence.color,
        vertices: fence.vertices
      })
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error);
      return;
    }
    await loadFences();
    await loadStatistics();
  } catch (e) {
    alert('更新围栏失败: ' + e.message);
  }
}

async function deleteFence(id) {
  try {
    await fetch(`/api/fences/${id}`, { method: 'DELETE' });
    await loadFences();
    await loadStatistics();
  } catch (e) {
    alert('删除围栏失败: ' + e.message);
  }
}

async function addPOI(name, lng, lat) {
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  try {
    await fetch('/api/pois', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lng, lat, color })
    });
    await loadPOIs();
  } catch (e) {
    alert('添加POI失败: ' + e.message);
  }
}

function updateFenceList() {
  const listEl = document.getElementById('fenceList');
  listEl.innerHTML = '';
  const typeNames = {
    normal: '普通区',
    forbidden_enter: '禁入区',
    forbidden_leave: '禁出区'
  };
  state.fences.forEach(fence => {
    const stats = state.statistics.find(s => s.fence_id === fence.id);
    const currentTargets = stats ? stats.current_targets : 0;
    const item = document.createElement('div');
    item.className = 'fence-item';
    if (state.selectedFence && state.selectedFence.id === fence.id) {
      item.classList.add('selected');
    }
    item.style.borderLeftColor = fence.color;
    item.innerHTML = `
      <div class="fence-color" style="background: ${fence.color}"></div>
      <div class="fence-info">
        <div class="fence-name">${fence.name}</div>
        <div class="fence-meta">
          <span class="fence-type-tag type-${fence.type}">${typeNames[fence.type]}</span>
        </div>
      </div>
      <div class="fence-target-count">${currentTargets} 个</div>
    `;
    item.addEventListener('click', () => {
      if (state.currentTool === 'select') {
        state.selectedFence = JSON.parse(JSON.stringify(fence));
        updateFenceList();
        render();
      }
    });
    listEl.appendChild(item);
  });
}

function updateAlertList() {
  const listEl = document.getElementById('alertList');
  const countEl = document.getElementById('alertCount');
  let filtered = state.alerts;
  if (state.filterLevel) {
    filtered = filtered.filter(a => a.level === state.filterLevel);
  }
  if (state.filterTarget) {
    filtered = filtered.filter(a => a.target_id === state.filterTarget);
  }
  countEl.textContent = filtered.length;
  listEl.innerHTML = '';
  const eventNames = { enter: '进入', leave: '离开' };
  filtered.slice(0, 50).forEach(alert => {
    const item = document.createElement('div');
    item.className = `alert-item ${alert.level}`;
    const time = new Date(alert.timestamp).toLocaleTimeString();
    let extraInfo = '';
    if (alert.group_name) {
      extraInfo += `<div class="alert-extra"><span class="alert-tag">分组: ${alert.group_name}</span>`;
    }
    if (alert.rule_id) {
      extraInfo += ` <span class="alert-tag">规则#${alert.rule_id}</span>`;
    }
    if (extraInfo) extraInfo += '</div>';
    let customMsg = '';
    if (alert.custom_message) {
      customMsg = `<div class="alert-custom">${alert.custom_message}</div>`;
    }
    item.innerHTML = `
      <div class="alert-header">
        <span class="alert-level ${alert.level}">${alert.level}</span>
        <span class="alert-time">${time}</span>
      </div>
      <div class="alert-content">
        <span class="alert-target">${alert.target_name}</span>
        <span class="alert-event"> ${eventNames[alert.event_type]} </span>
        <span class="alert-fence">${alert.fence_name}</span>
      </div>
      ${extraInfo}
      ${customMsg}
    `;
    listEl.appendChild(item);
  });
}

function updateStatusBar() {
  document.getElementById('totalAlerts').textContent = state.alerts.length;
}

function updateTargetFilter() {
  const select = document.getElementById('filterTarget');
  const currentValue = select.value;
  select.innerHTML = '<option value="">全部目标</option>';
  state.targets.forEach(target => {
    const opt = document.createElement('option');
    opt.value = target.id;
    opt.textContent = target.name;
    if (target.id === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
  updateReplayTargetSelect();
}

function handlePositionUpdate(data) {
  if (data.is_replay) return;
  
  const existing = state.targets.get(data.id);
  if (existing) {
    if (!existing.trajectory) existing.trajectory = [];
    existing.trajectory.push({ lng: data.lng, lat: data.lat });
    if (existing.trajectory.length > 30) {
      existing.trajectory.shift();
    }
    existing.lng = data.lng;
    existing.lat = data.lat;
    existing.bearing = data.bearing;
    existing.group_id = data.group_id;
    existing.group_name = data.group_name;
    existing.group_color = data.group_color;
    if (data.trajectory) {
      existing.trajectory = data.trajectory;
    }
  } else {
    state.targets.set(data.id, {
      ...data,
      trajectory: data.trajectory || []
    });
    updateTargetFilter();
  }
  render();
}

function handleReplayPosition(data) {
  state.replayPosition = data;
  render();
}

function handleReplayProgress(data) {
  state.replayProgress = data.progress_percent || 0;
  state.replayCurrentTime = data.current_time || 0;
  state.replayPaused = data.is_paused || false;
  state.isReplaying = data.is_running || false;
  updateReplayProgress();
  updateReplayControls();
}

function handleAlert(data) {
  state.alerts.unshift(data);
  if (state.alerts.length > 100) state.alerts.pop();
  updateAlertList();
  updateStatusBar();
  state.flashingFences.set(data.fence_id, '#ff0000');
  state.highlightedTargets.add(data.target_id);
  render();
  setTimeout(() => {
    state.flashingFences.delete(data.fence_id);
    state.highlightedTargets.delete(data.target_id);
    render();
  }, 2000);
  let flashCount = 0;
  const flashInterval = setInterval(() => {
    flashCount++;
    const color = flashCount % 2 === 0 ? '#ff0000' : null;
    if (state.flashingFences.has(data.fence_id)) {
      state.flashingFences.set(data.fence_id, color);
      render();
    }
    if (flashCount >= 8) {
      clearInterval(flashInterval);
      state.flashingFences.delete(data.fence_id);
      render();
    }
  }, 250);
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  state.ws = new WebSocket(wsUrl);
  const wsStatus = document.getElementById('wsStatus');
  state.ws.onopen = () => {
    wsStatus.textContent = '已连接';
    wsStatus.className = 'status-badge connected';
  };
  state.ws.onclose = () => {
    wsStatus.textContent = '连接断开';
    wsStatus.className = 'status-badge disconnected';
    setTimeout(connectWebSocket, 3000);
  };
  state.ws.onerror = () => {
    wsStatus.textContent = '连接错误';
    wsStatus.className = 'status-badge disconnected';
  };
  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'position') {
        handlePositionUpdate(msg.data);
      } else if (msg.type === 'replay_position') {
        handleReplayPosition(msg.data);
      } else if (msg.type === 'replay_progress' || msg.type === 'replay_started') {
        handleReplayProgress(msg.data);
      } else if (msg.type === 'replay_stopped') {
        if (msg.data.target_id === state.replayTarget) {
          state.isReplaying = false;
          state.replayPaused = false;
          state.replayPosition = null;
          state.replayTrajectory = [];
          state.replayProgress = 0;
          state.replayCurrentTime = 0;
          updateReplayControls();
          updateReplayProgress();
          render();
        }
      } else if (msg.type === 'replay_paused' || msg.type === 'replay_resumed' || msg.type === 'replay_speed_changed') {
        handleReplayProgress(msg.data);
      } else if (msg.type === 'alert') {
        handleAlert(msg.data);
      } else if (msg.type === 'poi_created') {
        loadPOIs();
      } else if (msg.type === 'poi_deleted') {
        loadPOIs();
      } else if (msg.type === 'fence_status') {
        state.fenceActiveStatus.set(msg.data.fence_id, msg.data.is_active);
        render();
      } else if (msg.type === 'heatmap_update') {
        state.heatmapData = msg.data;
        if (state.showHeatmap) {
          render();
        }
      } else if (msg.data && msg.data.type === 'cycle_warning') {
        console.warn('[CycleWarning]', msg.data.message);
      } else if (msg.data && msg.data.type === 'speed_limit') {
        console.log('[SpeedLimit]', msg.data);
      }
    } catch (e) {
      console.error('消息解析失败:', e);
    }
  };
}

async function init() {
  resizeCanvas();
  await loadFences();
  await loadPOIs();
  await loadAlerts();
  await loadStatistics();
  connectWebSocket();
  setInterval(loadStatistics, 2000);
  setInterval(() => {
    if (state.selectedFence) {
      const fresh = state.fences.find(f => f.id === state.selectedFence.id);
      if (!fresh) {
        state.selectedFence = null;
        updateFenceList();
      }
    }
  }, 1000);
}

init();
