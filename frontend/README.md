# F1 Theoretical Lap Frontend

React frontend for drawing or selecting an F1 track, visualizing segment behavior (accelerate/coast/brake), and showing theoretical minimum lap time.

## Features

- Freehand track drawing directly on a canvas.
- Real-time tug/edit mode for adjusting track points and instant recompute.
- Real-track selection from FastF1 telemetry (GPS X/Y centerline points).
- Backend integration for:
  - Track catalog retrieval + selected track point extraction.
  - Theoretical minimum lap time + segment heatmap data.
- Local fallback solver if backend is unavailable.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start development server:

```bash
npm run dev
```

3. Build for production:

```bash
npm run build
```

## Environment

Optional env variable:

- `VITE_API_BASE_URL` (default: `http://localhost:8000`)

Create `.env` in `frontend/` if needed:

```bash
VITE_API_BASE_URL=http://localhost:8000
```

## Expected backend contracts

### POST `/api/track/solve`

Request:

```json
{
  "points": [{ "x": 0.12, "y": 0.45 }],
  "width": 920,
  "height": 560,
  "isClosedLoop": true
}
```

Response:

```json
{
  "minTimeSeconds": 73.428,
  "segments": [
    {
      "from": { "x": 0.12, "y": 0.45 },
      "to": { "x": 0.13, "y": 0.46 },
      "phase": "accelerate",
      "speed": 88.4,
      "seconds": 0.038
    }
  ]
}
```

### GET `/api/track/catalog`

Response:

```json
{
  "tracks": [
    { "id": "bahrain_2024", "name": "Bahrain GP (Sakhir)", "year": 2024, "round": 1, "session": "R" }
  ]
}
```

### POST `/api/track/extract`

Request:

```json
{
  "trackId": "bahrain_2024"
}
```

Response:

```json
{
  "trackId": "bahrain_2024",
  "name": "Bahrain GP (Sakhir)",
  "trackLengthMiles": 3.36,
  "points": [{ "x": 0.11, "y": 0.49 }]
}
```
