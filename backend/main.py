from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.extract_track import router as extract_router
from api.solve_track import router as solve_router


app = FastAPI(title="CQ Hacks F1 Solver API")

app.add_middleware(
	CORSMiddleware,
	allow_origins=["*"],
	allow_credentials=True,
	allow_methods=["*"],
	allow_headers=["*"],
)

app.include_router(solve_router)
app.include_router(extract_router)


@app.get("/health")
def health():
	return {"status": "ok"}

