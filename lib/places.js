// Busca de empresas no Google Maps pela Places API (New) - API oficial, paga por uso.
// Requer GOOGLE_PLACES_API_KEY. Retorna só dados comerciais do estabelecimento.
const { HttpError } = require("./http");

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

const FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "nextPageToken",
].join(",");

function placesConfigured() {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY);
}

function component(p, type, short) {
  const c = (p.addressComponents || []).find((x) => (x.types || []).includes(type));
  return c ? (short ? c.shortText : c.longText) : null;
}

function toResult(p) {
  return {
    placeId: p.id,
    name: p.displayName?.text || "",
    address: p.formattedAddress || null,
    city: component(p, "administrative_area_level_2") || component(p, "locality"),
    uf: component(p, "administrative_area_level_1", true),
    phone: p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    category: p.primaryTypeDisplayName?.text || null,
    rating: p.rating ?? null,
    ratings: p.userRatingCount ?? 0,
    status: p.businessStatus || null,
  };
}

async function searchPlaces(textQuery, pageToken) {
  if (!placesConfigured()) throw new HttpError(503, "places_not_configured");
  let res;
  try {
    res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": FIELDS,
      },
      body: JSON.stringify({ textQuery, languageCode: "pt-BR", regionCode: "BR", pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "places_unavailable");
  }
  if (!res.ok) {
    console.error("Places API error:", res.status, (await res.text()).slice(0, 500));
    throw new HttpError(res.status === 429 ? 429 : 502, res.status === 429 ? "places_rate_limited" : "places_error");
  }
  const data = await res.json();
  return {
    results: (data.places || []).filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY").map(toResult),
    nextPageToken: data.nextPageToken || null,
  };
}

module.exports = { searchPlaces, placesConfigured, setFetch };
