const EPSILON = 1e-8;

function pointOnSegment(px, py, x1, y1, x2, y2) {
  const cross = (py - y1) * (x2 - x1) - (px - x1) * (y2 - y1);
  if (Math.abs(cross) > EPSILON) return false;
  const dot = (px - x1) * (px - x2) + (py - y1) * (py - y2);
  return dot <= EPSILON;
}

function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d1x = x2 - x1, d1y = y2 - y1;
  const d2x = x4 - x3, d2y = y4 - y3;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPSILON) return false;
  const t = ((x3 - x1) * d2y - (y3 - y1) * d2x) / denom;
  const s = ((x3 - x1) * d1y - (y3 - y1) * d1x) / denom;
  return t > 0 && t < 1 && s > 0 && s < 1;
}

function isPolygonSelfIntersecting(vertices) {
  const n = vertices.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const x1 = vertices[i].lng, y1 = vertices[i].lat;
    const x2 = vertices[(i + 1) % n].lng, y2 = vertices[(i + 1) % n].lat;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const x3 = vertices[j].lng, y3 = vertices[j].lat;
      const x4 = vertices[(j + 1) % n].lng, y4 = vertices[(j + 1) % n].lat;
      if (segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4)) {
        return true;
      }
    }
  }
  return false;
}

function pointInPolygon(point, polygon) {
  const { lng: px, lat: py } = point;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const v1 = polygon[i];
    const v2 = polygon[(i + 1) % n];
    if (pointOnSegment(px, py, v1.lng, v1.lat, v2.lng, v2.lat)) {
      return true;
    }
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function distance(p1, p2) {
  const dx = p2.lng - p1.lng;
  const dy = p2.lat - p1.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

module.exports = {
  pointInPolygon,
  isPolygonSelfIntersecting,
  pointOnSegment,
  segmentsIntersect,
  distance
};
