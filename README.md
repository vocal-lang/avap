# VOCAL-S26

## Inline resource maps (optional speed-up)

Each resource card on the Home page has a **View on map** button that opens an inline Leaflet map for that single address. Geocoding runs in the browser using only the resource's public address (no user data is sent). To speed up loading:

1. **Firestore** — Add **Latitude** / **Longitude** fields on resources so the map does not need to call a geocoder.
2. **Google Geocoding API** — Set `VITE_GOOGLE_MAPS_GEOCODING_KEY` in `.env` (see [.env.example](.env.example)). Use a referrer-restricted key.

If the key is unset, OpenStreetMap Nominatim is used (one request per second rate limit).
