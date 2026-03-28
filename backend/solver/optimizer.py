from dataclasses import dataclass

import numpy as np

from .backward_pass import backward_speed_pass
from .forward_pass import forward_speed_pass
from .types import Solution, Track
from .utils import compute_segment_times, drag_deceleration, find_cornering_speed


@dataclass
class OptimizationResult:
	solution: Solution
	speeds: np.ndarray
	segment_times: np.ndarray
	control_profile: np.ndarray


def _circular_moving_average(values: np.ndarray, window: int = 5) -> np.ndarray:
	if window <= 1 or len(values) < 3:
		return values
	if window % 2 == 0:
		window += 1

	half = window // 2
	smoothed = np.zeros_like(values)
	for offset in range(-half, half + 1):
		smoothed += np.roll(values, offset)
	return smoothed / window

'''
The main optimization loop. Takes in the car and track paramters and continuousl iterates applying our
forward and backward passes until we converge on a solution. Then, for this solution I compute the accel
profule, heatmap, and segment times to return.
'''
def optimize_lap_time(track: Track, car, max_iter: int = 140, tol: float = 1e-4) -> OptimizationResult:
	v_corner = find_cornering_speed(track.curvature, car)
	v = v_corner.copy()

	for x in range(max_iter):
		prev = v.copy()
		v = forward_speed_pass(v, v_corner, track.density, car)
		v = backward_speed_pass(v, v_corner, track.density, car)

		if np.max(np.abs(v - prev)) < tol:
			break

	v_next = np.roll(v, -1)
	accel_profile = (np.square(v_next) - np.square(v)) / (2.0 * np.maximum(track.density, 1e-6))

	# Convert from net longitudinal acceleration to control demand.
	# This adds back drag so constant-speed high-throttle sections (common in long F1 bends)
	# are represented as acceleration demand rather than coast.
	v_avg = np.maximum((v + v_next) * 0.5, 1e-3)
	drag_profile = drag_deceleration(v_avg, car)
	control_profile = accel_profile + drag_profile

	control_profile = _circular_moving_average(control_profile, window=7)

	accel_heat = np.maximum(control_profile, 0.0) / max(car.max_accel * 0.65, 1e-6)
	brake_heat = np.maximum(-control_profile, 0.0) / max(car.max_brake * 0.65, 1e-6)
	heatmap = np.clip(accel_heat - brake_heat, -1.0, 1.0)
	segment_times = compute_segment_times(track.density, v)
	min_time = float(np.sum(segment_times))

	return OptimizationResult(
		solution=Solution(min_time=min_time, heatmap=heatmap),
		speeds=v,
		segment_times=segment_times,
		control_profile=control_profile,
	)

