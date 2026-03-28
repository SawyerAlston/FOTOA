import numpy as np

from .utils import drag_deceleration, power_limited_acceleration


def forward_speed_pass(v_seed: np.ndarray, v_limit: np.ndarray, ds: np.ndarray, car) -> np.ndarray:
	v = np.minimum(v_seed.copy(), v_limit)
	n = len(v)

	for i in range(n):
		j = (i + 1) % n
		accel_engine = power_limited_acceleration(np.array([v[i]]), car)[0]
		accel_long = min(car.max_accel, accel_engine)
		accel_eff = max(accel_long - drag_deceleration(np.array([v[i]]), car)[0], -car.max_brake)

		v_next_sq = max(v[i] * v[i] + 2.0 * accel_eff * ds[i], 1e-6)
		v_next = np.sqrt(v_next_sq)
		v[j] = min(v[j], v_next, v_limit[j], car.max_speed)

	return np.maximum(v, 1e-3)

