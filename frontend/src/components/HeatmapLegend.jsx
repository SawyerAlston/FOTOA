import { useEffect, useRef } from 'react';

const HeatmapLegend = () => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Create gradient from brake (left) → coast (middle) → accelerate (right)
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#ff453a');   // brake (red)
    gradient.addColorStop(0.5, '#ffd60a'); // coast (yellow)
    gradient.addColorStop(1, '#30d158');   // accelerate (green)

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }, []);

  return (
    <div className="legend">
      <p className="legend-title">Heatmap Gradient</p>
      <canvas ref={canvasRef} className="gradient-bar" width={280} height={16} />
      <div className="legend-labels">
        <span>Brake</span>
        <span>Coast</span>
        <span>Accelerate</span>
      </div>
    </div>
  );
};

export default HeatmapLegend;
