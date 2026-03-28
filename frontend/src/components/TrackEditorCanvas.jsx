import { useEffect, useMemo, useRef, useState } from 'react';
import { autoCloseTrack, distance, hasSelfIntersection } from '../utils/geometry';

const PHASE_COLORS = {
  accelerate: '#30d158',
  coast: '#ffd60a',
  brake: '#ff453a'
};

const lerp = (a, b, t) => a + (b - a) * t;

const hexToRgb = (hex) => {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
};

const rgbToHex = ({ r, g, b }) => {
  const toHex = (value) => Math.round(value).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const interpolateColor = (startHex, endHex, t) => {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  return rgbToHex({
    r: lerp(start.r, end.r, t),
    g: lerp(start.g, end.g, t),
    b: lerp(start.b, end.b, t)
  });
};

const getColorFromHeat = (heat) => {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(heat) ? heat : 0));
  if (clamped >= 0) {
    return interpolateColor(PHASE_COLORS.coast, PHASE_COLORS.accelerate, clamped);
  }

  return interpolateColor(PHASE_COLORS.coast, PHASE_COLORS.brake, Math.abs(clamped));
};

const smoothClosedPointsForRender = (points, window = 7, passes = 2) => {
  if (!points || points.length < 5) {
    return points;
  }

  const smoothArray = (values) => {
    const kernel = window % 2 === 0 ? window + 1 : window;
    const half = Math.floor(kernel / 2);
    let current = values.slice();

    for (let pass = 0; pass < passes; pass += 1) {
      const next = new Array(current.length).fill(0);
      for (let i = 0; i < current.length; i += 1) {
        let sum = 0;
        for (let offset = -half; offset <= half; offset += 1) {
          const idx = (i + offset + current.length) % current.length;
          sum += current[idx];
        }
        next[i] = sum / kernel;
      }
      current = next;
    }

    return current;
  };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const smoothX = smoothArray(xs);
  const smoothY = smoothArray(ys);

  return points.map((point, index) => ({
    ...point,
    x: smoothX[index],
    y: smoothY[index]
  }));
};

const CLOSE_SNAP_RADIUS = 28;
const MIN_POINTS_TO_SNAP_CLOSE = 10;
const MS_TO_MPH = 2.2369362921;
const RAD_TO_DEG = 180 / Math.PI;

const getPhaseBySegmentIndex = (segments, index, totalSegments) => {
  if (!segments || segments.length === 0) {
    return 'coast';
  }

  if (totalSegments <= 1) {
    return segments[0]?.phase || 'coast';
  }

  const mappedIndex = Math.floor((index / (totalSegments - 1)) * (segments.length - 1));
  return segments[mappedIndex]?.phase || 'coast';
};

const getHeatBySegmentIndex = (segments, index, totalSegments) => {
  if (!segments || segments.length === 0) {
    return 0;
  }

  if (totalSegments <= 1) {
    const only = segments[0];
    if (typeof only?.heat === 'number') {
      return only.heat;
    }
    if (only?.phase === 'accelerate') return 1;
    if (only?.phase === 'brake') return -1;
    return 0;
  }

  const mappedIndex = Math.floor((index / (totalSegments - 1)) * (segments.length - 1));
  const segment = segments[mappedIndex];
  if (typeof segment?.heat === 'number') {
    return segment.heat;
  }
  if (segment?.phase === 'accelerate') return 1;
  if (segment?.phase === 'brake') return -1;
  return 0;
};

const getPointerPosition = (event, canvas) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
};

const findNearestPointIndex = (points, target, radius = 18) => {
  let bestIndex = -1;
  let minDistance = Infinity;

  for (let i = 0; i < points.length; i += 1) {
    const d = distance(points[i], target);
    if (d <= radius && d < minDistance) {
      minDistance = d;
      bestIndex = i;
    }
  }

  return bestIndex;
};

const projectPointOnSegment = (point, start, end) => {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (lengthSquared < 1e-6) {
    return {
      point: start,
      t: 0,
      distance: distance(point, start)
    };
  }

  const tRaw =
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared;
  const t = Math.max(0, Math.min(1, tRaw));

  const projected = {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t
  };

  return {
    point: projected,
    t,
    distance: distance(point, projected)
  };
};

const findNearestSegmentTarget = (points, target, radius = 18) => {
  if (!points || points.length < 2) {
    return null;
  }

  const totalSegments = points.length > 2 ? points.length : points.length - 1;
  let best = null;

  for (let i = 0; i < totalSegments; i += 1) {
    const start = points[i];
    const end = points[(i + 1) % points.length];
    if (!start || !end) {
      continue;
    }

    const projection = projectPointOnSegment(target, start, end);
    if (projection.distance > radius) {
      continue;
    }

    if (!best || projection.distance < best.distance) {
      best = {
        type: 'segment',
        segmentIndex: i,
        insertIndex: i === points.length - 1 ? points.length : i + 1,
        point: projection.point,
        distance: projection.distance
      };
    }
  }

  return best;
};

const findNearestRenderedSegment = (segments, target, radius = 14) => {
  if (!segments || segments.length === 0) {
    return null;
  }

  let best = null;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment?.from || !segment?.to) {
      continue;
    }

    const projection = projectPointOnSegment(target, segment.from, segment.to);
    if (projection.distance > radius) {
      continue;
    }

    if (!best || projection.distance < best.distance) {
      best = {
        index: i,
        t: projection.t,
        point: projection.point,
        distance: projection.distance
      };
    }
  }

  return best;
};

const interpolateMetric = (a, b, t) => a + (b - a) * t;

const metricValue = (segment, key, fallback = 0) =>
  typeof segment?.[key] === 'number' ? segment[key] : fallback;

const getDragTarget = (points, target) => {
  const nearestPointIndex = findNearestPointIndex(points, target, 16);
  if (nearestPointIndex >= 0) {
    return {
      type: 'point',
      index: nearestPointIndex
    };
  }

  return findNearestSegmentTarget(points, target, 14);
};

const smoothDeformPoints = (points, dragIndex, newPos, influenceRadius = 80) => {
  if (dragIndex < 0 || dragIndex >= points.length) {
    return points;
  }

  const updated = [...points];
  const draggedPoint = points[dragIndex];
  const displacement = {
    x: newPos.x - draggedPoint.x,
    y: newPos.y - draggedPoint.y
  };

  updated[dragIndex] = newPos;

  for (let i = 0; i < points.length; i += 1) {
    if (i === dragIndex) continue;

    const d = distance(points[i], newPos);
    if (d > influenceRadius) continue;

    // Gaussian falloff: closer points influenced more
    const influence = Math.exp(-((d * d) / (2 * (influenceRadius * influenceRadius) * 0.25)));
    updated[i] = {
      x: points[i].x + displacement.x * influence,
      y: points[i].y + displacement.y * influence
    };
  }

  return updated;
};

const drawGrid = (ctx, width, height) => {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;

  const step = 40;
  for (let x = 0; x <= width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let y = 0; y <= height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
};

const drawFinishLineOverlay = (ctx, points) => {
  if (!points || points.length < 2) {
    return;
  }

  const start = points[0];
  const angle = Math.PI / 2;

  const lineLength = 30;
  const lineThickness = 12;
  const x = start.x;
  const y = start.y;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fillRect(-lineThickness / 2 - 2, -lineLength / 2 - 2, lineThickness + 4, lineLength + 4);

  const cellSize = 6;
  const cols = 2;
  const rows = Math.floor(lineLength / cellSize);
  const originX = -lineThickness / 2;
  const originY = -lineLength / 2;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const isDark = (row + col) % 2 === 0;
      ctx.fillStyle = isDark ? '#0b1220' : '#f8fafc';
      ctx.fillRect(originX + col * cellSize, originY + row * cellSize, cellSize, cellSize);
    }
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(originX, originY, cols * cellSize, rows * cellSize);
  ctx.restore();
};

const computeSegmentLength = (segment) => {
  if (!segment?.from || !segment?.to) {
    return 0;
  }
  return distance(segment.from, segment.to);
};

const getTopSpeedAnnotation = (segments) => {
  if (!segments || segments.length === 0) {
    return null;
  }

  let best = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment?.from || !segment?.to) {
      continue;
    }

    const speed = typeof segment.speed === 'number' ? segment.speed : NaN;
    if (!Number.isFinite(speed)) {
      continue;
    }

    const segmentLength = computeSegmentLength(segment);
    const marker = {
      index,
      speed,
      segmentLength,
      x: (segment.from.x + segment.to.x) * 0.5,
      y: (segment.from.y + segment.to.y) * 0.5
    };

    if (!best) {
      best = marker;
      continue;
    }

    if (marker.speed > best.speed + 0.12) {
      best = marker;
      continue;
    }

    if (Math.abs(marker.speed - best.speed) <= 0.12 && marker.segmentLength > best.segmentLength) {
      best = marker;
    }
  }

  return best;
};

const getSharpestTurnAnnotation = (segments) => {
  if (!segments || segments.length < 3) {
    return null;
  }

  let best = null;
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    if (!current?.from || !current?.to) {
      continue;
    }

    const curvature = typeof current.curvature === 'number' ? current.curvature : NaN;
    if (!Number.isFinite(curvature) || curvature <= 1e-9) {
      continue;
    }

    const prev = segments[(index - 1 + segments.length) % segments.length];
    const next = segments[(index + 1) % segments.length];
    const pPrev = prev?.from || current.from;
    const pMid = current.from;
    const pNext = next?.to || current.to;

    const v1 = { x: pMid.x - pPrev.x, y: pMid.y - pPrev.y };
    const v2 = { x: pNext.x - pMid.x, y: pNext.y - pMid.y };
    const mag1 = Math.hypot(v1.x, v1.y);
    const mag2 = Math.hypot(v2.x, v2.y);

    let turnDegrees = NaN;
    if (mag1 > 1e-6 && mag2 > 1e-6) {
      const dot = (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2);
      const clampedDot = Math.max(-1, Math.min(1, dot));
      const headingDelta = Math.acos(clampedDot) * RAD_TO_DEG;
      turnDegrees = headingDelta;
    }

    const marker = {
      index,
      curvature,
      radiusMeters: 1 / curvature,
      turnDegrees,
      x: pMid.x,
      y: pMid.y
    };

    if (!best || marker.curvature > best.curvature) {
      best = marker;
    }
  }

  return best;
};

const pointToRectDistance = (point, rect) => {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
};

const segmentSamples = (segment) => {
  const from = segment?.from;
  const to = segment?.to;
  if (!from || !to) {
    return [];
  }

  const samples = [];
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4;
    samples.push({
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t)
    });
  }
  return samples;
};

const chooseAnnotationRect = (ctx, anchor, width, height, segments, occupiedRects) => {
  const margin = 6;
  const candidates = [
    { dx: 20, dy: -64 },
    { dx: -20 - width, dy: -64 },
    { dx: 20, dy: 24 },
    { dx: -20 - width, dy: 24 },
    { dx: 66, dy: -12 },
    { dx: -66 - width, dy: -12 }
  ];

  const clampRect = (x, y) => ({
    x: Math.max(margin, Math.min(x, ctx.canvas.width - width - margin)),
    y: Math.max(margin, Math.min(y, ctx.canvas.height - height - margin)),
    width,
    height
  });

  const segmentPoints = segments.flatMap(segmentSamples);

  let best = clampRect(anchor.x + 20, anchor.y - 64);
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const rect = clampRect(anchor.x + candidate.dx, anchor.y + candidate.dy);

    let minTrackClearance = Infinity;
    for (const sample of segmentPoints) {
      const d = pointToRectDistance(sample, rect);
      if (d < minTrackClearance) {
        minTrackClearance = d;
      }
    }

    let minAnnotationClearance = Infinity;
    for (const occupied of occupiedRects) {
      const center = { x: occupied.x + occupied.width / 2, y: occupied.y + occupied.height / 2 };
      const d = pointToRectDistance(center, rect);
      if (d < minAnnotationClearance) {
        minAnnotationClearance = d;
      }
    }
    if (!Number.isFinite(minAnnotationClearance)) {
      minAnnotationClearance = 999;
    }

    const anchorCenter = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const leaderLength = distance(anchorCenter, anchor);

    const score = (minTrackClearance * 2.4) + (minAnnotationClearance * 1.4) - (leaderLength * 0.45);
    if (score > bestScore) {
      bestScore = score;
      best = rect;
    }
  }

  return best;
};

const drawAnnotationBubble = (ctx, x, y, value, tone = 'cyan', segments = [], occupiedRects = []) => {
  const padX = 11;
  const width = ctx.measureText(value).width + (padX * 2) + 4;
  const height = 24;
  const rect = chooseAnnotationRect(ctx, { x, y }, width, height, segments, occupiedRects);

  const border = tone === 'orange' ? 'rgba(251, 146, 60, 0.88)' : 'rgba(34, 211, 238, 0.9)';
  const point = tone === 'orange' ? '#fb923c' : '#22d3ee';

  const targetX = rect.x + rect.width / 2;
  const targetY = rect.y + rect.height / 2;

  ctx.save();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(targetX, targetY);
  ctx.stroke();

  ctx.fillStyle = point;
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(2, 6, 23, 0.94)';
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, 7);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 11px Inter, Segoe UI, sans-serif';
  ctx.fillText(value, rect.x + padX, rect.y + 15.5);
  ctx.restore();

  return rect;
};

const drawTrackAnnotations = (ctx, segments) => {
  if (!segments || segments.length === 0) {
    return;
  }

  const occupiedRects = [];

  const topSpeed = getTopSpeedAnnotation(segments);
  if (topSpeed) {
    const speedMph = topSpeed.speed * MS_TO_MPH;
    const drawnRect = drawAnnotationBubble(
      ctx,
      topSpeed.x,
      topSpeed.y,
      `${speedMph.toFixed(1)} mph`,
      'cyan',
      segments,
      occupiedRects
    );
    occupiedRects.push(drawnRect);
  }

  const sharpestTurn = getSharpestTurnAnnotation(segments);
  if (sharpestTurn) {
    const radiusText = Number.isFinite(sharpestTurn.radiusMeters)
      ? `${sharpestTurn.radiusMeters.toFixed(0)} m`
      : '--';
    const angleText = Number.isFinite(sharpestTurn.turnDegrees)
      ? `${sharpestTurn.turnDegrees.toFixed(0)}°`
      : '--';

    const drawnRect = drawAnnotationBubble(
      ctx,
      sharpestTurn.x,
      sharpestTurn.y,
      `${radiusText} • ${angleText}`,
      'orange',
      segments,
      occupiedRects
    );
    occupiedRects.push(drawnRect);
  }
};

const TrackEditorCanvas = ({
  points,
  setPoints,
  solution,
  showHeatmap,
  showAnnotations,
  mode,
  width = 920,
  height = 560,
  backgroundImage,
  onDrawingComplete,
  onDragStateChange,
  onInvalidTrack,
  onHoverTelemetryChange
}) => {
  const canvasRef = useRef(null);
  const backgroundImageRef = useRef(null);
  const dragStartPointsRef = useRef(null);
  const autoFinalizeRef = useRef(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [dragIndex, setDragIndex] = useState(-1);
  const [isHoveringDraggablePoint, setIsHoveringDraggablePoint] = useState(false);
  const [isSnapCloseActive, setIsSnapCloseActive] = useState(false);
  const [hoverTelemetry, setHoverTelemetry] = useState(null);

  useEffect(() => {
    if (onHoverTelemetryChange) {
      onHoverTelemetryChange(hoverTelemetry);
    }
  }, [hoverTelemetry, onHoverTelemetryChange]);

  useEffect(() => {
    if (!backgroundImage) {
      backgroundImageRef.current = null;
      return;
    }

    const img = new Image();
    img.onload = () => {
      backgroundImageRef.current = img;
      render();
    };
    img.src = backgroundImage;
  }, [backgroundImage]);

  const hasTrack = points.length >= 2;

  const renderedSegments = useMemo(() => solution?.segments ?? [], [solution]);
  const smoothedRenderPoints = useMemo(() => smoothClosedPointsForRender(points), [points]);

  const render = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid(ctx, canvas.width, canvas.height);

    if (backgroundImageRef.current) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(backgroundImageRef.current, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    // Draw track line with heatmap coloring if available
    if (hasTrack) {
      ctx.save();
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';

      if (showHeatmap && renderedSegments.length > 0) {
        const isActivelyDragging = dragIndex >= 0;

        if (!isActivelyDragging) {
          for (const segment of renderedSegments) {
            const from = segment.from;
            const to = segment.to;
            if (!from || !to) {
              continue;
            }

            const heat = typeof segment.heat === 'number'
              ? segment.heat
              : segment.phase === 'accelerate'
                ? 1
                : segment.phase === 'brake'
                  ? -1
                  : 0;
            const color = getColorFromHeat(heat);
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
          }
        } else {
          const drawPoints = smoothedRenderPoints;
          const loopIsExplicitlyClosed = distance(drawPoints[0], drawPoints[drawPoints.length - 1]) < 1;
          const segmentCount = loopIsExplicitlyClosed ? drawPoints.length - 1 : drawPoints.length;

          for (let i = 0; i < segmentCount; i += 1) {
            const from = drawPoints[i];
            const to = loopIsExplicitlyClosed
              ? drawPoints[i + 1]
              : drawPoints[(i + 1) % drawPoints.length];
            if (!from || !to) {
              continue;
            }

            const heat = getHeatBySegmentIndex(renderedSegments, i, segmentCount);
            const color = getColorFromHeat(heat);
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
          }
        }
      } else {
        // Draw track in neutral color if heatmap not shown
        const drawPoints = smoothedRenderPoints;
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(drawPoints[0].x, drawPoints[0].y);
        for (let i = 1; i < drawPoints.length; i += 1) {
          ctx.lineTo(drawPoints[i].x, drawPoints[i].y);
        }

        if (drawPoints.length > 2) {
          ctx.lineTo(drawPoints[0].x, drawPoints[0].y);
        }
        ctx.stroke();
      }

      ctx.restore();

      // Only show control points if no solution exists yet
      if (!solution || dragIndex >= 0) {
        ctx.save();
        for (let i = 0; i < points.length; i += 1) {
          if (solution && dragIndex >= 0 && i !== dragIndex) {
            continue;
          }

          const p = points[i];
          const active = i === dragIndex;
          ctx.fillStyle = active ? '#22d3ee' : '#94a3b8';
          ctx.beginPath();
          ctx.arc(p.x, p.y, active ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (isDrawing && points.length > 0) {
        const startPoint = points[0];
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = isSnapCloseActive ? '#f97316' : 'rgba(148, 163, 184, 0.7)';
        ctx.fillStyle = isSnapCloseActive ? 'rgba(249, 115, 22, 0.25)' : 'rgba(148, 163, 184, 0.15)';
        ctx.beginPath();
        ctx.arc(startPoint.x, startPoint.y, CLOSE_SNAP_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isSnapCloseActive ? '#fdba74' : '#cbd5e1';
        ctx.beginPath();
        ctx.arc(startPoint.x, startPoint.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (!isDrawing) {
        drawFinishLineOverlay(ctx, smoothedRenderPoints);
      }

      if (!isDrawing && showAnnotations && renderedSegments.length > 0) {
        drawTrackAnnotations(ctx, renderedSegments);
      }
    }
  };

  useEffect(() => {
    render();
  }, [points, renderedSegments, showHeatmap, showAnnotations, dragIndex, hasTrack, solution, isDrawing, isSnapCloseActive]);

  const finalizeDrawing = (rawPoints) => {
    const closedPoints = autoCloseTrack(rawPoints);

    if (hasSelfIntersection(closedPoints)) {
      setPoints([]);
      if (onInvalidTrack) {
        onInvalidTrack('draw');
      }
    } else {
      setPoints(closedPoints);
      if (onDrawingComplete) {
        onDrawingComplete(closedPoints);
      }
    }

    setIsDrawing(false);
    setIsSnapCloseActive(false);
  };

  const onPointerDown = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const pos = getPointerPosition(event, canvas);

    if (mode === 'drag') {
      const dragTarget = getDragTarget(points, pos);
      if (dragTarget?.type === 'point') {
        dragStartPointsRef.current = points.map((point) => ({ ...point }));
        setDragIndex(dragTarget.index);
        setIsHoveringDraggablePoint(true);
        if (onDragStateChange) {
          onDragStateChange(true);
        }
      } else if (dragTarget?.type === 'segment') {
        dragStartPointsRef.current = points.map((point) => ({ ...point }));
        setPoints((current) => {
          const next = [...current];
          next.splice(dragTarget.insertIndex, 0, dragTarget.point);
          return next;
        });
        setDragIndex(dragTarget.insertIndex);
        setIsHoveringDraggablePoint(true);
        if (onDragStateChange) {
          onDragStateChange(true);
        }
      } else {
        setIsHoveringDraggablePoint(false);
      }
      return;
    }

    const canStartDrawing = mode === 'draw' || (mode !== 'drag' && points.length === 0);
    if (canStartDrawing) {
      autoFinalizeRef.current = false;
      setIsDrawing(true);
      setIsSnapCloseActive(false);
      setPoints([pos]);
    }
  };

  const onPointerMove = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const pos = getPointerPosition(event, canvas);

    if (showHeatmap && renderedSegments.length > 0) {
      const hit = findNearestRenderedSegment(renderedSegments, pos, 15);
      if (hit) {
        const current = renderedSegments[hit.index];
        const next = renderedSegments[(hit.index + 1) % renderedSegments.length] || current;

        const speed = interpolateMetric(
          metricValue(current, 'speed', 0),
          metricValue(next, 'speed', metricValue(current, 'speed', 0)),
          hit.t
        );
        const accel = interpolateMetric(
          metricValue(current, 'acceleration', 0),
          metricValue(next, 'acceleration', metricValue(current, 'acceleration', 0)),
          hit.t
        );
        const lateralG = interpolateMetric(
          metricValue(current, 'lateralG', 0),
          metricValue(next, 'lateralG', metricValue(current, 'lateralG', 0)),
          hit.t
        );
        const curvature = interpolateMetric(
          metricValue(current, 'curvature', 0),
          metricValue(next, 'curvature', metricValue(current, 'curvature', 0)),
          hit.t
        );
        const heat = interpolateMetric(
          metricValue(current, 'heat', 0),
          metricValue(next, 'heat', metricValue(current, 'heat', 0)),
          hit.t
        );

        const phase =
          heat > 0.12 ? 'Accelerate' : heat < -0.12 ? 'Brake' : 'Coast';

        setHoverTelemetry({
          speed,
          acceleration: accel,
          lateralG,
          curvature,
          heat,
          phase
        });
      } else {
        setHoverTelemetry(null);
      }
    } else {
      setHoverTelemetry(null);
    }

    if (mode === 'drag') {
      if (dragIndex < 0) {
        const dragTarget = getDragTarget(points, pos);
        setIsHoveringDraggablePoint(Boolean(dragTarget));
        return;
      }

      setPoints((current) => smoothDeformPoints(current, dragIndex, pos));
      return;
    }

    if (!isDrawing) {
      return;
    }

    const canSnapClose = points.length >= MIN_POINTS_TO_SNAP_CLOSE;
    const closeToStart = canSnapClose ? distance(pos, points[0]) <= CLOSE_SNAP_RADIUS : false;
    setIsSnapCloseActive(closeToStart);

    if (closeToStart) {
      const last = points[points.length - 1];
      const nextPoints = distance(last, pos) < 4 ? points : [...points, pos];
      autoFinalizeRef.current = true;
      finalizeDrawing(nextPoints);
      return;
    }

    setPoints((current) => {
      if (current.length === 0) {
        return [pos];
      }

      const last = current[current.length - 1];
      if (distance(last, pos) < 4) {
        return current;
      }

      return [...current, pos];
    });
  };

  const stopInteraction = () => {
    if (isDrawing) {
      if (autoFinalizeRef.current) {
        autoFinalizeRef.current = false;
      } else {
        finalizeDrawing(points);
      }
    }

    if (dragIndex >= 0) {
      if (hasSelfIntersection(points)) {
        const safePoints = dragStartPointsRef.current;
        if (safePoints && safePoints.length > 0) {
          setPoints(safePoints);
        }
        if (onInvalidTrack) {
          onInvalidTrack('drag');
        }
      }

      setDragIndex(-1);
      dragStartPointsRef.current = null;
      if (onDragStateChange) {
        onDragStateChange(false);
      }
    }

    setIsHoveringDraggablePoint(false);
    setHoverTelemetry(null);
  };

  return (
    <div className="canvas-wrapper">
      <canvas
        ref={canvasRef}
        className={`track-canvas ${mode === 'drag' ? 'drag-mode' : 'draw-mode'} ${
          mode === 'drag' && isHoveringDraggablePoint ? 'drag-hover' : ''
        } ${mode === 'drag' && dragIndex >= 0 ? 'drag-active' : ''}`}
        width={width}
        height={height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopInteraction}
        onPointerLeave={stopInteraction}
      />
      <div className="canvas-hint">
        {mode === 'drag'
          ? 'Hover near the track to see tug cursor, then drag to reshape.'
          : 'Click and drag to draw. Move near the start circle to snap-close instantly.'}
      </div>
    </div>
  );
};

export default TrackEditorCanvas;
