const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export const autoCloseTrack = (points) => {
  if (points.length < 3) {
    return points;
  }

  const start = points[0];
  const end = points[points.length - 1];
  const closeThreshold = 30;

  // Already connected (within threshold of start point)
  if (distance(start, end) < closeThreshold) {
    return points;
  }

  const closingDistance = distance(end, start);
  const segmentLength = 10;
  const interpolationCount = Math.max(1, Math.ceil(closingDistance / segmentLength) - 1);
  const interpolated = [];

  for (let i = 1; i <= interpolationCount; i += 1) {
    const t = i / (interpolationCount + 1);
    interpolated.push({
      x: end.x + (start.x - end.x) * t,
      y: end.y + (start.y - end.y) * t
    });
  }

  return [...points, ...interpolated];
};

export const simplifyByDistance = (points, threshold = 8) => {
  if (!points || points.length < 3) {
    return points;
  }

  const simplified = [points[0]];
  let last = points[0];

  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i];
    if (distance(last, point) >= threshold) {
      simplified.push(point);
      last = point;
    }
  }

  simplified.push(points[points.length - 1]);
  return simplified;
};

export const normalizeTrackPoints = (points, width, height) => {
  if (!points || points.length === 0 || width <= 0 || height <= 0) {
    return [];
  }

  return points.map((point) => ({
    x: clamp(point.x / width, 0, 1),
    y: clamp(point.y / height, 0, 1)
  }));
};

export const denormalizeTrackPoints = (points, width, height) => {
  if (!points || points.length === 0 || width <= 0 || height <= 0) {
    return [];
  }

  return points.map((point) => ({
    x: clamp(point.x, 0, 1) * width,
    y: clamp(point.y, 0, 1) * height
  }));
};

export const computeCurvature = (prev, current, next) => {
  const v1x = current.x - prev.x;
  const v1y = current.y - prev.y;
  const v2x = next.x - current.x;
  const v2y = next.y - current.y;

  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);

  if (mag1 < 1e-4 || mag2 < 1e-4) {
    return 0;
  }

  const cross = Math.abs(v1x * v2y - v1y * v2x);
  const dot = v1x * v2x + v1y * v2y;
  const angle = Math.atan2(cross, dot);

  return angle / Math.max((mag1 + mag2) * 0.5, 1e-4);
};

const orientation = (a, b, c) => {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) {
    return 0;
  }
  return value > 0 ? 1 : 2;
};

const onSegment = (a, b, c) => {
  return (
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    b.x + 1e-9 >= Math.min(a.x, c.x) &&
    b.y <= Math.max(a.y, c.y) + 1e-9 &&
    b.y + 1e-9 >= Math.min(a.y, c.y)
  );
};

const segmentsIntersect = (p1, q1, p2, q2) => {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;

  return false;
};

const areAdjacentSegments = (i, j, segmentCount) => {
  if (i === j) {
    return true;
  }

  if ((i + 1) % segmentCount === j || (j + 1) % segmentCount === i) {
    return true;
  }

  return false;
};

export const hasSelfIntersection = (points) => {
  if (!points || points.length < 4) {
    return false;
  }

  const segmentCount = points.length;

  for (let i = 0; i < segmentCount; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % points.length];

    for (let j = i + 1; j < segmentCount; j += 1) {
      if (areAdjacentSegments(i, j, segmentCount)) {
        continue;
      }

      const b1 = points[j];
      const b2 = points[(j + 1) % points.length];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return false;
};

export const createFallbackSolution = (points, isClosedLoop = true) => {
  if (!points || points.length < 3) {
    return {
      minTimeSeconds: 0,
      segments: []
    };
  }

  const segments = [];
  const maxSpeed = 92;
  const minSpeed = 34;
  const accelThreshold = 0.02;
  const brakeThreshold = 0.06;

  let totalTime = 0;

  const end = isClosedLoop ? points.length : points.length - 1;
  for (let i = 0; i < end; i += 1) {
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    const prev = points[(i - 1 + points.length) % points.length];
    const next2 = points[(i + 2) % points.length];

    if (!isClosedLoop && i + 1 >= points.length) {
      break;
    }

    const segmentLength = distance(curr, next);
    const curvatureNow = computeCurvature(prev, curr, next);
    const curvatureAhead = computeCurvature(curr, next, next2);
    const weightedCurvature = curvatureNow * 0.6 + curvatureAhead * 0.4;

    const speed = clamp(maxSpeed - weightedCurvature * 420, minSpeed, maxSpeed);

    const heat = clamp((accelThreshold - weightedCurvature) / 0.06, -1, 1);
    const phase = heat > 0.12 ? 'accelerate' : heat < -0.12 ? 'brake' : 'coast';

    const time = segmentLength / Math.max(speed, 0.001);
    totalTime += time;

    segments.push({
      index: i,
      from: curr,
      to: next,
      speed,
      curvature: weightedCurvature,
      heat,
      phase,
      seconds: time
    });
  }

  return {
    minTimeSeconds: totalTime,
    segments
  };
};
