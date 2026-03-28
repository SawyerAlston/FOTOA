import numpy as np

from .utils import drag_deceleration


def backward_speed_pass(v_seed: np.ndarray, v_limit: np.ndarray, ds: np.ndarray, car) -> np.ndarray:
	v = np.minimum(v_seed.copy(), v_limit)
	n = len(v)

	for i in range(n - 1, -1, -1):
		prev_i = (i - 1) % n
		braking_cap = car.max_brake + drag_deceleration(np.array([v[i]]), car)[0]
		braking_cap = max(braking_cap, 1e-6)

		v_prev_max_sq = max(v[i] * v[i] + 2.0 * braking_cap * ds[prev_i], 1e-6)
		v_prev_max = np.sqrt(v_prev_max_sq)

		v[prev_i] = min(v[prev_i], v_prev_max, v_limit[prev_i], car.max_speed)

	return np.maximum(v, 1e-3)

