from typing import List

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from solver.optimizer import optimize_lap_time
from solver.types import Car
from solver.utils import build_segment_payload, build_track, preprocess_track_points


router = APIRouter(prefix="/api/track", tags=["solve-track"])


class PointModel(BaseModel):
	x: float
	y: float


class SolveTrackRequest(BaseModel):
	points: List[PointModel]
	width: float = Field(gt=0)
	height: float = Field(gt=0)
	isClosedLoop: bool = True
	trackScaleMiles: float = Field(default=2.0, ge=2.0, le=4.0)


def default_car() -> Car:
	return Car(
		max_power=750_000.0,
		max_speed=97.5,
		max_accel=12.0,
		max_brake=15.0,
		mu=1.5,
		downforce_coef=2.9,
		drag_coef=0.925,
		mass=798.0,
	)


@router.post("/solve")
@router.post("/solve-track")
def solve_track(payload: SolveTrackRequest):
	try:
		if len(payload.points) < 3:
			raise ValueError("At least 3 points are required")

		points = [(point.x, point.y) for point in payload.points]
		track_length_miles = payload.trackScaleMiles
		track = build_track(points, track_length_miles)
		result = optimize_lap_time(track, default_car())

		points_norm = preprocess_track_points(points)
		segments = build_segment_payload(
			points_norm=points_norm,
			heatmap=result.solution.heatmap,
			speeds=result.speeds,
			segment_times=result.segment_times,
			control_profile=result.control_profile,
			curvature=track.curvature,
		)

		return {"minTimeSeconds": result.solution.min_time, "segments": segments}
	except ValueError as exc:
		return JSONResponse(status_code=400, content={"message": str(exc)})
	except Exception as exc:
		return JSONResponse(
			status_code=500,
			content={"message": f"Solver failed: {type(exc).__name__}"},
		)

