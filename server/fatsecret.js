import { kv } from './db.js';

const FS_TOKEN_KEY = 'fs_token';

async function getToken() {
  const raw = kv.get(FS_TOKEN_KEY);
  if (raw) {
    const data = JSON.parse(raw);
    if (Date.now() < data.expires_at - 60_000) return data.access_token;
  }
  const creds = Buffer.from(`${process.env.FS_CLIENT_ID}:${process.env.FS_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=basic',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('FatSecret token fetch failed');
  kv.put(FS_TOKEN_KEY, JSON.stringify({
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 86400) * 1000,
  }));
  return data.access_token;
}

async function fsGet(params) {
  const token = await getToken();
  const qs = new URLSearchParams({ ...params, format: 'json' }).toString();
  const res = await fetch(`https://platform.fatsecret.com/rest/server.api?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export async function fsSearch(q) {
  try {
    const data = await fsGet({ method: 'foods.search', search_expression: q, max_results: 10 });
    if (data?.error) return { results: [], _fs_error: data.error };
    const raw = toArray(data?.foods?.food);
    return {
      results: raw.filter(f => f?.food_id).map(f => ({
        id: String(f.food_id),
        name: f.food_name ?? '',
        brand: f.brand_name ?? null,
        description: [f.food_type, f.brand_name].filter(Boolean).join(' · '),
      })),
    };
  } catch (e) {
    return { results: [], _fs_error: e.message };
  }
}

export async function fsFood(id) {
  try {
    const data = await fsGet({ method: 'food.get.v4', food_id: id });
    const food = data?.food;
    if (!food) return null;
    const servings = toArray(food?.servings?.serving).map(s => ({
      id: String(s.serving_id ?? '0'),
      description: s.serving_description ?? '1 serving',
      // Exact measured equivalent of this serving ("1 slice" → 28 g) straight from FatSecret —
      // lets the client scale recipe amounts against any serving without guessing.
      metricAmount: Number(s.metric_serving_amount) || null,
      metricUnit: s.metric_serving_unit || null,
      nutrition: {
        kcal:         Number(s.calories            ?? 0),
        protein:      Number(s.protein             ?? 0),
        carbs:        Number(s.carbohydrate        ?? 0),
        fat:          Number(s.fat                 ?? 0),
        fiber:        Number(s.fiber               ?? 0),
        sugar:        Number(s.sugar               ?? 0),
        saturatedFat: Number(s.saturated_fat       ?? 0),
        polyunsatFat: Number(s.polyunsaturated_fat ?? 0),
        cholesterol:  Number(s.cholesterol         ?? 0),
        sodium:       Number(s.sodium              ?? 0),
        potassium:    Number(s.potassium           ?? 0),
      },
    }));
    return { id: String(food.food_id ?? id), name: food.food_name ?? '', brand: food.brand_name ?? null, servings };
  } catch {
    return null;
  }
}
