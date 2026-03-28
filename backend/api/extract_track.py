from __future__ import annotations

from datetime import date
import json
from pathlib import Path
import threading
from typing import Dict, List

import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from solver.utils import preprocess_track_points


router = APIRouter(prefix="/api/track", tags=["extract-track"])


FALLBACK_TRACK_CATALOG: List[dict] = [
	{"id": "2024_r01_race", "name": "2024 Bahrain GP", "year": 2024, "round": 1, "session": "R"},
	{"id": "2024_r02_race", "name": "2024 Saudi Arabian GP", "year": 2024, "round": 2, "session": "R"},
	{"id": "2024_r03_race", "name": "2024 Australian GP", "year": 2024, "round": 3, "session": "R"},
	{"id": "2024_r04_race", "name": "2024 Japanese GP", "year": 2024, "round": 4, "session": "R"},
	{"id": "2024_r08_race", "name": "2024 Monaco GP", "year": 2024, "round": 8, "session": "R"},
	{"id": "2024_r12_race", "name": "2024 British GP", "year": 2024, "round": 12, "session": "R"},
	{"id": "2024_r14_race", "name": "2024 Belgian GP", "year": 2024, "round": 14, "session": "R"},
	{"id": "2024_r16_race", "name": "2024 Italian GP", "year": 2024, "round": 16, "session": "R"},
	{"id": "2024_r21_race", "name": "2024 São Paulo GP", "year": 2024, "round": 21, "session": "R"},
]

TRACK_CATALOG_CACHE: List[dict] | None = None
TRACK_POINTS_CACHE: Dict[str, dict] = {}
TRACK_POINTS_CACHE_DIR = Path(__file__).resolve().parents[1] / ".track_points_cache"
TRACK_POINTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
PREWARM_STARTED = False


class TrackSelectionRequest(BaseModel):
	trackId: str


def _get_fastf1_module():
	try:
		import fastf1
		return fastf1
	except ImportError as exc:
		raise RuntimeError(
			"fastf1 is not installed in the backend environment. Install it with `pip install fastf1`."
		) from exc


def _build_track_catalog() -> List[dict]:
	global TRACK_CATALOG_CACHE
	if TRACK_CATALOG_CACHE is not None:
		return TRACK_CATALOG_CACHE

	try:
		fastf1 = _get_fastf1_module()
		catalog: List[dict] = []
		current_year = date.today().year
		for year in range(2018, current_year + 1):
			try:
				schedule = fastf1.get_event_schedule(year, include_testing=False)
			except Exception:
				continue

			for _, row in schedule.iterrows():
				round_value = row.get("RoundNumber")
				event_name = row.get("EventName")
				event_date = row.get("EventDate")
				session_date = row.get("Session5Date")

				if round_value is None or event_name is None:
					continue

				final_date = session_date if session_date is not None else event_date
				if final_date is not None:
					try:
						if getattr(final_date, "date", lambda: final_date)() > date.today():
							continue
					except Exception:
						pass

				try:
					round_number = int(round_value)
				except (TypeError, ValueError):
					continue

				if round_number <= 0:
					continue

				catalog.append(
					{
						"id": f"{year}_r{round_number:02d}_race",
						"name": f"{year} {str(event_name)}",
						"year": year,
						"round": round_number,
						"session": "R",
					}
				)

		catalog.sort(key=lambda track: (track["year"], track["round"]), reverse=True)
		TRACK_CATALOG_CACHE = catalog if catalog else FALLBACK_TRACK_CATALOG
	except Exception:
		TRACK_CATALOG_CACHE = FALLBACK_TRACK_CATALOG

	return TRACK_CATALOG_CACHE


def _get_track_by_id(track_id: str) -> dict | None:
	for track in _build_track_catalog():
		if track["id"] == track_id:
			return track
	return None


def _track_cache_file(track_id: str) -> Path:
	safe_id = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in track_id)
	return TRACK_POINTS_CACHE_DIR / f"{safe_id}.json"


def _load_track_points_from_disk(track_id: str) -> dict | None:
	cache_file = _track_cache_file(track_id)
	if not cache_file.exists():
		return None

	try:
		content = json.loads(cache_file.read_text(encoding="utf-8"))
		if isinstance(content, dict):
			points = content.get("points")
			track_length_miles = content.get("trackLengthMiles")
		else:
			points = None
			track_length_miles = None

		if not isinstance(points, list) or len(points) < 3:
			return None

		length_value = None
		if isinstance(track_length_miles, (int, float)) and np.isfinite(track_length_miles):
			length_value = float(track_length_miles)

		return {
			"points": points,
			"trackLengthMiles": length_value,
		}
	except Exception:
		return None


def _save_track_points_to_disk(track_id: str, track_name: str, points: List[dict], track_length_miles: float | None) -> None:
	cache_file = _track_cache_file(track_id)
	payload = {
		"trackId": track_id,
		"name": track_name,
		"pointCount": len(points),
		"trackLengthMiles": track_length_miles,
		"points": points,
	}
	cache_file.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def _get_or_load_track_points(track: dict) -> dict:
	track_id = track["id"]
	if track_id in TRACK_POINTS_CACHE:
		cached = TRACK_POINTS_CACHE[track_id]
		if cached.get("trackLengthMiles") is not None:
			return cached
		try:
			refreshed = _load_track_points_from_fastf1(track)
			TRACK_POINTS_CACHE[track_id] = refreshed
			_save_track_points_to_disk(track_id, track["name"], refreshed["points"], refreshed.get("trackLengthMiles"))
			return refreshed
		except Exception:
			return cached

	disk_payload = _load_track_points_from_disk(track_id)
	if disk_payload is not None:
		if disk_payload.get("trackLengthMiles") is not None:
			TRACK_POINTS_CACHE[track_id] = disk_payload
			return disk_payload

		try:
			refreshed = _load_track_points_from_fastf1(track)
			TRACK_POINTS_CACHE[track_id] = refreshed
			_save_track_points_to_disk(track_id, track["name"], refreshed["points"], refreshed.get("trackLengthMiles"))
			return refreshed
		except Exception:
			TRACK_POINTS_CACHE[track_id] = disk_payload
			return disk_payload

	payload = _load_track_points_from_fastf1(track)
	TRACK_POINTS_CACHE[track_id] = payload
	_save_track_points_to_disk(track_id, track["name"], payload["points"], payload.get("trackLengthMiles"))
	return payload


def _prewarm_recent_tracks(limit: int = 24) -> None:
	catalog = _build_track_catalog()
	for track in catalog[: max(0, int(limit))]:
		try:
			_get_or_load_track_points(track)
		except Exception:
			continue


def _normalize_to_unit(points: np.ndarray, padding: float = 0.04) -> np.ndarray:
	x = points[:, 0]
	y = points[:, 1]

	x_min = float(np.min(x))
	x_max = float(np.max(x))
	y_min = float(np.min(y))
	y_max = float(np.max(y))
	x_span = max(x_max - x_min, 1e-9)
	y_span = max(y_max - y_min, 1e-9)

	x_norm = (x - x_min) / x_span
	y_norm = (y - y_min) / y_span

	pad = float(np.clip(padding, 0.0, 0.2))
	if pad > 0.0:
		scale = 1.0 - (2.0 * pad)
		x_norm = (x_norm * scale) + pad
		y_norm = (y_norm * scale) + pad

	return np.column_stack((x_norm, y_norm))


def _estimate_track_length_miles(telemetry, processed_xy: np.ndarray) -> float | None:
	if telemetry is not None and not telemetry.empty and "Distance" in telemetry:
		try:
			distance_series = telemetry["Distance"].to_numpy(dtype=float)
			finite = distance_series[np.isfinite(distance_series)]
			if len(finite) >= 2:
				span_m = float(np.max(finite) - np.min(finite))
				if 2000.0 <= span_m <= 9000.0:
					return span_m / 1609.344
		except Exception:
			pass

	if len(processed_xy) >= 3:
		deltas = np.roll(processed_xy, -1, axis=0) - processed_xy
		meters = float(np.sum(np.linalg.norm(deltas, axis=1)))
		if 2000.0 <= meters <= 9000.0:
			return meters / 1609.344

	return None


def _load_track_points_from_fastf1(track_meta: dict) -> dict:
	fastf1 = _get_fastf1_module()

	cache_dir = Path(__file__).resolve().parents[1] / ".fastf1_cache"
	cache_dir.mkdir(parents=True, exist_ok=True)
	fastf1.Cache.enable_cache(str(cache_dir))

	session = fastf1.get_session(track_meta["year"], track_meta["round"], track_meta["session"])
	session.load(laps=True, telemetry=True, weather=False, messages=False)

	fastest_lap = session.laps.pick_fastest()
	if fastest_lap is None:
		raise RuntimeError("FastF1 returned no laps for this session.")

	telemetry = fastest_lap.get_telemetry()
	if telemetry is None or telemetry.empty or "X" not in telemetry or "Y" not in telemetry:
		position_data = fastest_lap.get_pos_data()
		if position_data is None or position_data.empty or "X" not in position_data or "Y" not in position_data:
			raise RuntimeError("FastF1 telemetry does not include usable X/Y position data.")
		raw_xy = position_data[["X", "Y"]].to_numpy(dtype=float)
	else:
		raw_xy = telemetry[["X", "Y"]].to_numpy(dtype=float)

	if raw_xy.size == 0:
		raise RuntimeError("No telemetry points found for this track.")

	finite_mask = np.isfinite(raw_xy).all(axis=1)
	raw_xy = raw_xy[finite_mask]
	if len(raw_xy) < 12:
		raise RuntimeError("Too few valid telemetry coordinates returned by FastF1.")

	processed = preprocess_track_points(raw_xy.tolist())
	normalized = _normalize_to_unit(processed)
	track_length_miles = _estimate_track_length_miles(telemetry, processed)

	return {
		"points": [{"x": float(pt[0]), "y": float(pt[1])} for pt in normalized],
		"trackLengthMiles": float(track_length_miles) if track_length_miles is not None else None,
	}


@router.get("/catalog")
def get_track_catalog():
	global PREWARM_STARTED
	catalog = _build_track_catalog()
	if not PREWARM_STARTED:
		PREWARM_STARTED = True
		thread = threading.Thread(target=_prewarm_recent_tracks, kwargs={"limit": 24}, daemon=True)
		thread.start()

	return {
		"tracks": [
			{
				"id": track["id"],
				"name": track["name"],
				"year": track["year"],
				"round": track["round"],
				"session": track["session"],
			}
			for track in catalog
		]
	}


@router.post("/extract")
def extract_track(payload: TrackSelectionRequest):
	global TRACK_CATALOG_CACHE
	track = _get_track_by_id(payload.trackId)
	if track is None:
		TRACK_CATALOG_CACHE = None
		track = _get_track_by_id(payload.trackId)

	if track is None:
		return JSONResponse(status_code=404, content={"message": "Unknown track id"})

	try:
		if payload.trackId not in TRACK_POINTS_CACHE:
			_get_or_load_track_points(track)
		track_payload = TRACK_POINTS_CACHE[payload.trackId]

		return {
			"trackId": track["id"],
			"name": track["name"],
			"trackLengthMiles": track_payload.get("trackLengthMiles"),
			"points": track_payload.get("points", []),
		}
	except RuntimeError as exc:
		return JSONResponse(status_code=500, content={"message": str(exc)})
	except Exception as exc:
		return JSONResponse(
			status_code=500,
			content={"message": f"Failed to load FastF1 telemetry: {type(exc).__name__}"},
		)

