import { useEffect, useState } from "react";

export default function LocationsPage() {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchLocations() {
      try {
        const res = await fetch("https://atomicfizzcaps.xyz/api/locations");
        if (!res.ok) throw new Error("Failed to fetch locations");
        const data = await res.json();
        setLocations(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchLocations();
  }, []);

  if (loading) return <p>Loading locations...</p>;
  if (error) return <p style={{ color: "red" }}>Error: {error}</p>;

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Game Locations</h1>
      <ul>
        {locations.map((loc, idx) => (
          <li key={idx}>
            <strong>{loc.n}</strong> — Level {loc.lvl} ({loc.rarity})
            <br />
            Lat: {loc.lat}, Lng: {loc.lng}
          </li>
        ))}
      </ul>
    </div>
  );
}
