const MetricCard = ({ label, value, hint, accent = 'default', variant = 'default' }) => {
  return (
    <div className={`metric-card metric-${accent} metric-${variant}`}>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      {hint ? <p className="metric-hint">{hint}</p> : null}
    </div>
  );
};

export default MetricCard;
