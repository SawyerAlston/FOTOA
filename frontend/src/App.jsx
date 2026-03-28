import { useEffect, useRef, useState } from 'react';
import HeatmapLegend from './components/HeatmapLegend';
import MetricCard from './components/MetricCard';
import TrackEditorCanvas from './components/TrackEditorCanvas';
import {
  API_BASE_URL,
  extractTrackFromCatalog,
  fetchTrackCatalog,
  solveTrack
} from './utils/api';
import {
  createFallbackSolution,
  denormalizeTrackPoints,
  normalizeTrackPoints,
  simplifyByDistance
} from './utils/geometry';

const CANVAS_WIDTH = 920;
const CANVAS_HEIGHT = 560;
const MIN_POINTS_FOR_SOLVE = 6;
const MIN_TRACK_SCALE_MILES = 2;
const MAX_TRACK_SCALE_MILES = 4;
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '--';
  }
  return `${seconds.toFixed(3)} s`;
};

const formatMetric = (value, digits = 2, suffix = '') => {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return `${value.toFixed(digits)}${suffix}`;
};

const MS_TO_MPH = 2.2369362921;
const METERS_TO_FEET = 3.280839895;

const formatSpeedMph = (speedMs) => {
  if (!Number.isFinite(speedMs)) {
    return '--';
  }
  return `${(speedMs * MS_TO_MPH).toFixed(1)} mph`;
};

const formatHeatHuman = (heat) => {
  if (!Number.isFinite(heat)) {
    return '--';
  }

  const magnitude = Math.min(100, Math.abs(heat) * 100);
  if (heat > 0.03) {
    return `${magnitude.toFixed(0)}% throttle`;
  }
  if (heat < -0.03) {
    return `${magnitude.toFixed(0)}% brake`;
  }
  return 'Coasting';
};

const formatTurnRadius = (curvature) => {
  if (!Number.isFinite(curvature) || curvature <= 1e-9) {
    return '--';
  }

  const radiusMeters = 1 / curvature;
  if (!Number.isFinite(radiusMeters) || radiusMeters > 5000) {
    return 'Straight';
  }

  const radiusFeet = radiusMeters * METERS_TO_FEET;
  return `${radiusMeters.toFixed(0)} m (${radiusFeet.toFixed(0)} ft)`;
};

const App = () => {
  const [points, setPoints] = useState([]);
  const [solution, setSolution] = useState(null);
  const [mode, setMode] = useState('idle');
  const [isDraggingTrack, setIsDraggingTrack] = useState(false);
  const [trackScaleMiles, setTrackScaleMiles] = useState(2);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [status, setStatus] = useState('Click and drag on the canvas to draw a track.');
  const [toast, setToast] = useState({ visible: false, message: '' });
  const [hoverTelemetry, setHoverTelemetry] = useState(null);
  const [isSolving, setIsSolving] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackOptions, setTrackOptions] = useState([]);
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [trackPointCache, setTrackPointCache] = useState({});
  const [backendEnabled, setBackendEnabled] = useState(true);
  const [backendConnected, setBackendConnected] = useState(null);

  const clampTrackScaleMiles = (value) => {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(MIN_TRACK_SCALE_MILES, Math.min(MAX_TRACK_SCALE_MILES, Number(value)));
  };

  const solveTimerRef = useRef(null);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (solveTimerRef.current) {
        clearTimeout(solveTimerRef.current);
      }

      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!backendEnabled) {
      return;
    }

    let cancelled = false;

    const loadCatalog = async () => {
      setCatalogLoading(true);
      try {
        const response = await fetchTrackCatalog();
        const tracks = Array.isArray(response?.tracks) ? response.tracks : [];
        if (cancelled) {
          return;
        }

        setBackendConnected(true);

        setTrackOptions(tracks);
        setSelectedTrackId((previous) => {
          if (previous && tracks.some((track) => track.id === previous)) {
            return previous;
          }
          return tracks[0]?.id || '';
        });
      } catch {
        if (!cancelled) {
          setBackendConnected(false);
          setTrackOptions([]);
          setSelectedTrackId('');
          setStatus('Could not load track catalog from backend. Drawing still works normally.');
        }
      } finally {
        if (!cancelled) {
          setCatalogLoading(false);
        }
      }
    };

    loadCatalog();

    return () => {
      cancelled = true;
    };
  }, [backendEnabled]);

  const showToast = (message) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    setToast({ visible: true, message });
    toastTimerRef.current = setTimeout(() => {
      setToast({ visible: false, message: '' });
    }, 2800);
  };

  const clearTrack = () => {
    setPoints([]);
    setSolution(null);
    setIsDraggingTrack(false);
    setMode('idle');
    setStatus('Track cleared. Click and drag on the canvas to draw again.');
  };

  const handleDrawingComplete = (closedPoints) => {
    if (closedPoints.length >= MIN_POINTS_FOR_SOLVE) {
      setPoints(closedPoints);
      setMode('drag');
      setStatus('Drawing complete. Drag points to adjust your track.');
    }
  };

  const scaleFallbackSolution = (baseSolution, scaleMiles) => {
    const baselineMiles = 3;
    const factor = scaleMiles / baselineMiles;
    return {
      ...baseSolution,
      minTimeSeconds: baseSolution.minTimeSeconds * factor,
      segments: baseSolution.segments.map((segment) => ({
        ...segment,
        seconds: segment.seconds * factor
      }))
    };
  };

  const runFallbackSolver = (rawPoints) => {
    const simplified = simplifyByDistance(rawPoints, 2);
    const localSolution = scaleFallbackSolution(
      createFallbackSolution(simplified, true),
      trackScaleMiles
    );
    setSolution(localSolution);
    setStatus('Using local fallback solver. Backend unavailable or disabled.');
  };

  const requestSolve = async (rawPoints) => {
    if (!rawPoints || rawPoints.length < MIN_POINTS_FOR_SOLVE) {
      setSolution(null);
      return;
    }

    const simplified = simplifyByDistance(rawPoints, 2);

    setIsSolving(true);

    if (!backendEnabled) {
      runFallbackSolver(simplified);
      setIsSolving(false);
      return;
    }

    try {
      const normalizedPoints = normalizeTrackPoints(simplified, CANVAS_WIDTH, CANVAS_HEIGHT);
      const response = await solveTrack({
        points: normalizedPoints,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        isClosedLoop: true,
        trackScaleMiles
      });

      const backendSegments = Array.isArray(response?.segments) ? response.segments : [];
      const denormalizedSegments = backendSegments
        .map((segment) => {
          const [from] = denormalizeTrackPoints([segment.from], CANVAS_WIDTH, CANVAS_HEIGHT);
          const [to] = denormalizeTrackPoints([segment.to], CANVAS_WIDTH, CANVAS_HEIGHT);

          if (!from || !to) {
            return null;
          }

          return {
            ...segment,
            from,
            to,
            heat:
              typeof segment.heat === 'number'
                ? Math.max(-1, Math.min(1, segment.heat))
                : segment.phase === 'accelerate'
                  ? 1
                  : segment.phase === 'brake'
                    ? -1
                    : 0,
            acceleration:
              typeof segment.acceleration === 'number' ? segment.acceleration : 0,
            lateralG:
              typeof segment.lateralG === 'number' ? segment.lateralG : 0,
            curvature:
              typeof segment.curvature === 'number' ? segment.curvature : 0,
            phase:
              segment.phase ||
              (segment.heat > 0.12
                ? 'accelerate'
                : segment.heat < -0.12
                  ? 'brake'
                  : 'coast')
          };
        })
        .filter(Boolean);

      const finalSolution = {
        minTimeSeconds:
          typeof response?.minTimeSeconds === 'number'
            ? response.minTimeSeconds
            : scaleFallbackSolution(createFallbackSolution(simplified, true), trackScaleMiles)
                .minTimeSeconds,
        segments:
          denormalizedSegments.length > 0
            ? denormalizedSegments
            : scaleFallbackSolution(createFallbackSolution(simplified, true), trackScaleMiles)
                .segments
      };

      setSolution(finalSolution);
      setBackendConnected(true);
      setStatus('Solved with backend model and rendered heatmap.');
    } catch {
      setBackendConnected(false);
      runFallbackSolver(simplified);
    } finally {
      setIsSolving(false);
    }
  };

  useEffect(() => {
    if (solveTimerRef.current) {
      clearTimeout(solveTimerRef.current);
    }

    if (mode !== 'drag') {
      return;
    }

    if (points.length < MIN_POINTS_FOR_SOLVE) {
      if (points.length > 0) {
        setStatus(`Add at least ${MIN_POINTS_FOR_SOLVE - points.length} more points to compute lap time.`);
      }
      setSolution(null);
      return;
    }

    if (isDraggingTrack) {
      return;
    }

    solveTimerRef.current = setTimeout(() => {
      requestSolve(points);
    }, 160);
  }, [points, backendEnabled, isDraggingTrack, trackScaleMiles, mode]);

  const onSelectTrack = async () => {
    if (!selectedTrackId || !backendEnabled) {
      return;
    }

    const cachedTrack = trackPointCache[selectedTrackId];
    if (cachedTrack && Array.isArray(cachedTrack.points) && cachedTrack.points.length > 0) {
      const mapped = denormalizeTrackPoints(cachedTrack.points, CANVAS_WIDTH, CANVAS_HEIGHT);
      setPoints(mapped);
      setMode('drag');

      const cachedScale = clampTrackScaleMiles(cachedTrack.trackLengthMiles);
      if (cachedScale !== null) {
        setTrackScaleMiles(cachedScale);
      }

      setStatus(`${cachedTrack.name || 'Track'} loaded from local cache. Tug to refine.`);
      return;
    }

    setTrackLoading(true);
    try {
      const response = await extractTrackFromCatalog(selectedTrackId);
      const normalized = response?.points || [];
      if (normalized.length > 0) {
        const mapped = denormalizeTrackPoints(normalized, CANVAS_WIDTH, CANVAS_HEIGHT);
        setPoints(mapped);
        setMode('drag');

        const suggestedScale = clampTrackScaleMiles(response?.trackLengthMiles);
        if (suggestedScale !== null) {
          setTrackScaleMiles(suggestedScale);
        }

        setTrackPointCache((previous) => ({
          ...previous,
          [selectedTrackId]: {
            name: response?.name || 'Track',
            points: normalized,
            trackLengthMiles: suggestedScale
          }
        }));
        setStatus(
          suggestedScale !== null
            ? `${response?.name || 'Track'} loaded. Track scale set to ${suggestedScale.toFixed(2)} miles from FastF1 data.`
            : `${response?.name || 'Track'} loaded from FastF1 telemetry. Tug to refine.`
        );
      } else {
        setStatus('Track selection returned no points. Please choose a different track.');
      }
    } catch (error) {
      setStatus(error?.message || 'Track load failed. You can still draw manually.');
    } finally {
      setTrackLoading(false);
    }
  };

  const useDragMode = () => setMode('drag');

  const handleInvalidTrack = (source) => {
    setSolution(null);
    setIsDraggingTrack(false);

    if (source === 'draw') {
      setMode('idle');
      setStatus('Invalid track: overlapping paths are not allowed. Track cleared.');
      showToast('Invalid track: overlap detected. Track cleared.');
      return;
    }

    setMode('drag');
    setStatus('Invalid track: overlap detected. Most recent tug was undone.');
    showToast('Invalid tug: overlap detected. Last tug was undone.');
  };

  const telemetrySource = (() => {
    if (hoverTelemetry) {
      return hoverTelemetry;
    }

    const segments = solution?.segments ?? [];
    if (segments.length === 0) {
      return null;
    }

    const average = (selector) => {
      const values = segments
        .map(selector)
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      if (values.length === 0) {
        return NaN;
      }
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    const avgHeat = average((segment) => segment.heat);
    const phase = avgHeat > 0.12 ? 'Accelerate' : avgHeat < -0.12 ? 'Brake' : 'Coast';

    return {
      phase,
      speed: average((segment) => segment.speed),
      acceleration: average((segment) => segment.acceleration),
      lateralG: average((segment) => segment.lateralG),
      curvature: average((segment) => segment.curvature),
      heat: avgHeat
    };
  })();

  const backendState =
    backendConnected === null ? 'Checking' : backendConnected ? 'Connected' : 'Offline';

  const frontendState = 'Running';

  return (
    <main className="app-shell">
      {toast.visible ? (
        <div className="global-toast" role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}

      <header className="app-header">
        <div className="app-branding">
          <h1>
            <span className="brand-char">F</span>
            <span className="brand-char">O</span>
            <span className="brand-char">T</span>
            <span className="brand-char brand-stopwatch" aria-label="stopwatch" role="img">⏱</span>
            <span className="brand-char">A</span>
          </h1>
          <p>Formula One Track Optimization &amp; Analysis</p>
        </div>
        <div className="runtime-widgets" aria-label="runtime status">
          <div className="runtime-widget">
            <span className={`runtime-dot ${backendConnected ? 'online' : backendConnected === false ? 'offline' : 'pending'}`} />
            <span className="runtime-name">Backend</span>
            <strong>{backendState}</strong>
          </div>
          <div className="runtime-widget">
            <span className="runtime-dot online" />
            <span className="runtime-name">Frontend</span>
            <strong>{frontendState}</strong>
          </div>
        </div>
      </header>

      <section className="metrics-grid">
        <MetricCard
          label="Theoretical Min Lap"
          value={isSolving ? 'Solving...' : formatTime(solution?.minTimeSeconds || 0)}
          hint="Combined over all track segments"
          accent="primary"
          variant="hero"
        />
        <div className="metric-card metric-telemetry">
          <p className="metric-label">Track Telemetry</p>
          <div className="telemetry-grid">
            <div className="telemetry-item"><span>Phase</span><strong>{telemetrySource?.phase || '--'}</strong></div>
            <div className="telemetry-item"><span>Speed</span><strong>{formatSpeedMph(telemetrySource?.speed)}</strong></div>
            <div className="telemetry-item"><span>Acceleration</span><strong>{formatMetric(telemetrySource?.acceleration, 2, ' m/s²')}</strong></div>
            <div className="telemetry-item"><span>Lateral G</span><strong>{formatMetric(telemetrySource?.lateralG, 2, ' g')}</strong></div>
            <div className="telemetry-item"><span>Turn Radius</span><strong>{formatTurnRadius(telemetrySource?.curvature)}</strong></div>
            <div className="telemetry-item"><span>Control Input</span><strong>{formatHeatHuman(telemetrySource?.heat)}</strong></div>
          </div>
          <p className="metric-hint">
            {hoverTelemetry
              ? 'Showing hovered segment telemetry.'
              : 'Showing average telemetry for the full track.'}
          </p>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="control-panel">
          <h2>Controls</h2>

          {points.length > 0 ? (
            <div className="button-row stacked">
              <button className={mode === 'drag' ? 'active' : ''} onClick={useDragMode}>
                Tug Track
              </button>
              <button onClick={clearTrack}>
                Clear Track
              </button>
            </div>
          ) : null}

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showHeatmap}
              onChange={(event) => setShowHeatmap(event.target.checked)}
            />
            Heatmap
          </label>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showAnnotations}
              onChange={(event) => setShowAnnotations(event.target.checked)}
            />
            Annotation
          </label>

          <div className="slider-row">
            <div className="slider-header">
              <span>Track Scale</span>
              <strong>{trackScaleMiles.toFixed(2)} miles</strong>
            </div>
            <input
              className="scale-slider"
              type="range"
              min={String(MIN_TRACK_SCALE_MILES)}
              max={String(MAX_TRACK_SCALE_MILES)}
              step="0.01"
              value={trackScaleMiles}
              onChange={(event) => setTrackScaleMiles(Number(event.target.value))}
            />
            <div className="slider-limits">
              <span>{MIN_TRACK_SCALE_MILES.toFixed(2)} mi</span>
              <span>{MAX_TRACK_SCALE_MILES.toFixed(2)} mi</span>
            </div>
          </div>

          <div className="slider-row">
            <div className="slider-header">
              <span>Real F1 Tracks</span>
              <strong>{catalogLoading ? 'Loading...' : `${trackOptions.length} available`}</strong>
            </div>
            <select
              className="track-select"
              value={selectedTrackId}
              onChange={(event) => setSelectedTrackId(event.target.value)}
              disabled={!backendEnabled || catalogLoading || trackLoading || trackOptions.length === 0}
            >
              {trackOptions.length === 0 ? (
                <option value="">No tracks available</option>
              ) : null}
              {trackOptions.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </select>
            <button
              onClick={onSelectTrack}
              disabled={!backendEnabled || trackLoading || !selectedTrackId || trackOptions.length === 0}
            >
              {trackLoading ? 'Loading Track...' : 'Select a track'}
            </button>
          </div>

          <HeatmapLegend />

          <div className="status-box">{status}</div>
        </aside>

        <section className="editor-panel">
          <TrackEditorCanvas
            points={points}
            setPoints={setPoints}
            solution={solution}
            showHeatmap={showHeatmap}
            showAnnotations={showAnnotations}
            mode={mode}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            backgroundImage=""
            onDrawingComplete={handleDrawingComplete}
            onDragStateChange={setIsDraggingTrack}
            onInvalidTrack={handleInvalidTrack}
            onHoverTelemetryChange={setHoverTelemetry}
          />
        </section>
      </section>
    </main>
  );
};

export default App;
