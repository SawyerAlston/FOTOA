const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const parseResponse = async (response) => {
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.message || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
};

export const solveTrack = async ({ points, width, height, isClosedLoop, trackScaleMiles }) => {
  const response = await fetch(`${API_BASE_URL}/api/track/solve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      points,
      width,
      height,
      isClosedLoop,
      trackScaleMiles
    })
  });

  return parseResponse(response);
};

export const fetchTrackCatalog = async () => {
  const response = await fetch(`${API_BASE_URL}/api/track/catalog`, {
    method: 'GET'
  });

  return parseResponse(response);
};

export const extractTrackFromCatalog = async (trackId) => {
  const response = await fetch(`${API_BASE_URL}/api/track/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ trackId })
  });

  return parseResponse(response);
};

export { API_BASE_URL };
