from __future__ import annotations

from typing import Iterable, List, Tuple

import numpy as np

from .types import Track


def _dedupe_consecutive(points: np.ndarray, eps: float = 1e-9) -> np.ndarray:
    if len(points) <= 1:
        return points

    keep = [0]
    for i in range(1, len(points)):
        if np.linalg.norm(points[i] - points[i - 1]) > eps:
            keep.append(i)
    return points[keep]


'''
I assume that the points 4 the track from the frontend are a closed loop of unqiue points.
This isn't always the case as my frontend is not as robust so this function handles the
data cleaning and edge cases to ensure the points are in the correct format for the subsequent
solving.
'''
def prepare_closed_points(points: Iterable[Tuple[float, float]]) -> np.ndarray:
    arr = np.asarray(list(points), dtype=float)
    if arr.ndim != 2 or arr.shape[1] != 2:
        raise ValueError("Points must be an Nx2 array-like")
    if len(arr) < 3:
        raise ValueError("At least 3 points are required")

    arr = _dedupe_consecutive(arr)
    if len(arr) < 3:
        raise ValueError("Need at least 3 unique points")

    if np.linalg.norm(arr[0] - arr[-1]) < 1e-8:
        arr = arr[:-1]

    if len(arr) < 3:
        raise ValueError("Need at least 3 unique points after")

    return arr


def _segment_lengths(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    dx = np.roll(x, -1) - x
    dy = np.roll(y, -1) - y
    return np.maximum(np.hypot(dx, dy), 1e-6)


def _circular_moving_average(values: np.ndarray, window: int = 5, passes: int = 1) -> np.ndarray:
    if window <= 1 or len(values) < 3:
        return values.copy()

    if window % 2 == 0:
        window += 1

    half = window // 2
    result = values.astype(float).copy()

    for _ in range(max(1, passes)):
        smoothed = np.zeros_like(result)
        for offset in range(-half, half + 1):
            smoothed += np.roll(result, offset)
        result = smoothed / window

    return result


def smooth_closed_points(points: np.ndarray, window: int = 7, passes: int = 1) -> np.ndarray:
    if len(points) < 5:
        return points.copy()

    x = _circular_moving_average(points[:, 0], window=window, passes=passes)
    y = _circular_moving_average(points[:, 1], window=window, passes=passes)
    return np.column_stack((x, y))


def resample_closed_points(points: np.ndarray, target_count: int) -> np.ndarray:
    if len(points) < 3:
        return points.copy()

    target_count = max(24, int(target_count))
    if len(points) == target_count:
        return points.copy()

    extended = np.vstack([points, points[0]])
    segment_lengths = np.linalg.norm(extended[1:] - extended[:-1], axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(segment_lengths)))
    total_length = cumulative[-1]

    if total_length <= 1e-9:
        return points.copy()

    sample_distances = np.linspace(0.0, total_length, target_count + 1)[:-1]

    x_interp = np.interp(sample_distances, cumulative, extended[:, 0])
    y_interp = np.interp(sample_distances, cumulative, extended[:, 1])
    return np.column_stack((x_interp, y_interp))


def preprocess_track_points(points: Iterable[Tuple[float, float]]) -> np.ndarray:
    closed = prepare_closed_points(points)

    target_count = int(np.clip(len(closed), 120, 320))
    resampled = resample_closed_points(closed, target_count=target_count)
    smoothed = smooth_closed_points(resampled, window=7, passes=2)

    if np.sum(_segment_lengths(smoothed[:, 0], smoothed[:, 1])) <= 1e-8:
        return resampled

    return smoothed


'''
Find the curvature at each point along the track using the three-point formula. This helps 
me determine the limits for speed while cornering.
'''
def estimate_curvature(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    # Create arrays for previous, current, and next points w/ np.roll 4 circular indexing
    p_prev = np.column_stack((np.roll(x, 1), np.roll(y, 1)))
    p = np.column_stack((x, y))
    p_next = np.column_stack((np.roll(x, -1), np.roll(y, -1)))

    a = np.linalg.norm(p - p_prev, axis=1)
    b = np.linalg.norm(p_next - p, axis=1)
    c = np.linalg.norm(p_next - p_prev, axis=1)
    # cross product formula
    area2 = np.abs(
        (p[:, 0] - p_prev[:, 0]) * (p_next[:, 1] - p_prev[:, 1])
        - (p[:, 1] - p_prev[:, 1]) * (p_next[:, 0] - p_prev[:, 0])
    )
    # curvature formula: 2 * area / (a * b * c)
    denom = np.maximum(a * b * c, 1e-9)
    curvature = 2.0 * area2 / denom
    curvature = np.nan_to_num(curvature, nan=0.0, posinf=0.0, neginf=0.0)
    return np.maximum(curvature, 1e-8)

'''
Given the track and the total track length. This will convert it into physical measurements
(in meters) and return that as well as the curvature and point density for the track.
(density 4 the segment lengths)
'''
def build_track(points: Iterable[Tuple[float, float]], track_length_miles: float) -> Track:
    if not np.isfinite(track_length_miles):
        raise ValueError("Track length must be a finite number")
    if track_length_miles <= 0:
        raise ValueError("Track length must be positive")

    processed = preprocess_track_points(points)
    x_norm = processed[:, 0]
    y_norm = processed[:, 1]

    ds_norm = _segment_lengths(x_norm, y_norm)
    length_norm = float(np.sum(ds_norm))
    if length_norm <= 1e-8:
        raise ValueError("Track length is too small")

    total_length_m = float(track_length_miles) * 1609.344
    meters_per_norm = total_length_m / length_norm

    x_m = x_norm * meters_per_norm
    y_m = y_norm * meters_per_norm
    ds_m = ds_norm * meters_per_norm
    curvature_raw = estimate_curvature(x_m, y_m)
    curvature = np.maximum(_circular_moving_average(curvature_raw, window=9, passes=1), 1e-8)

    return Track(x=x_m, y=y_m, curvature=curvature, density=ds_m)


# The following 3 are just basic physics formulas for accel, drag, and cornering limits
def drag_deceleration(v: np.ndarray, car) -> np.ndarray:
    return (car.drag_coef * np.square(v)) / max(car.mass, 1e-6)


def power_limited_acceleration(v: np.ndarray, car) -> np.ndarray:
    v_safe = np.maximum(v, 1e-3)
    return car.max_power / (car.mass * v_safe)


def find_cornering_speed(curvature: np.ndarray, car, max_iter: int = 8) -> np.ndarray:
    n = len(curvature)
    v = np.full(n, float(car.max_speed), dtype=float)
    kappa = np.maximum(curvature, 1e-8)

    for _ in range(max_iter):
        lateral_force_limit = car.mu * car.mass * car.gravity + car.downforce_coef * np.square(v)
        v = np.sqrt(np.maximum(lateral_force_limit / np.maximum(car.mass * kappa, 1e-8), 1e-8))
        v = np.minimum(v, car.max_speed)

    return np.maximum(v, 1e-3)


def classify_heatmap(accel_profile: np.ndarray, accel_eps: float = 0.15, brake_eps: float = 0.2) -> np.ndarray:
    states = np.zeros_like(accel_profile)
    states[accel_profile > accel_eps] = 1.0
    states[accel_profile < -brake_eps] = -1.0
    return states


def heatmap_to_phase(value: float) -> str:
    if value > 0.12:
        return "accelerate"
    if value < -0.12:
        return "brake"
    return "coast"


def compute_segment_times(ds: np.ndarray, v: np.ndarray) -> np.ndarray:
    v_next = np.roll(v, -1)
    v_avg = np.maximum((v + v_next) * 0.5, 1e-3)
    return ds / v_avg


def normalize_points_for_response(track: Track) -> np.ndarray:
    x_min, x_max = float(np.min(track.x)), float(np.max(track.x))
    y_min, y_max = float(np.min(track.y)), float(np.max(track.y))
    x_span = max(x_max - x_min, 1e-9)
    y_span = max(y_max - y_min, 1e-9)

    x_norm = (track.x - x_min) / x_span
    y_norm = (track.y - y_min) / y_span
    return np.column_stack((x_norm, y_norm))


def build_segment_payload(
    points_norm: np.ndarray,
    heatmap: np.ndarray,
    speeds: np.ndarray,
    segment_times: np.ndarray,
    control_profile: np.ndarray,
    curvature: np.ndarray,
) -> List[dict]:
    n = len(points_norm)
    payload = []
    for i in range(n):
        from_pt = points_norm[i]
        to_pt = points_norm[(i + 1) % n]
        lateral_g = (float(speeds[i]) ** 2) * float(curvature[i]) / 9.81
        payload.append(
            {
                "from": {"x": float(from_pt[0]), "y": float(from_pt[1])},
                "to": {"x": float(to_pt[0]), "y": float(to_pt[1])},
                "heat": float(np.clip(heatmap[i], -1.0, 1.0)),
                "phase": heatmap_to_phase(float(heatmap[i])),
                "speed": float(speeds[i]),
                "acceleration": float(control_profile[i]),
                "curvature": float(curvature[i]),
                "lateralG": float(lateral_g),
                "seconds": float(segment_times[i]),
            }
        )
    return payload
