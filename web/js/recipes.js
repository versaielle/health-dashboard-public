// ── RECIPE LIBRARY ──

async function normalizeStoredRecipes() {
  try {
    const res = await authFetch(`${BACKEND}/admin/normalize-recipes`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      alert(`Done — normalized ${data.modified} of ${data.total} recipes.`);
      await loadRecipes();
    }
  } catch (e) { alert('Error: ' + e.message); }
}

// Owner-only: derive `components` for legacy recipes that predate the field, via Haiku.
async function backfillRecipeComponents() {
  if (!confirm('This will update all legacy recipes with component data using Claude. Continue?')) return;
  state.backfillRunning = true;
  state.backfillResult = null;
  state.backfillErrorsOpen = false;
  render();
  try {
    const res = await authFetch(`${BACKEND}/admin/backfill-components`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.total !== undefined) {
      state.backfillResult = data;
      await loadRecipes(); // refresh so the log UI sees the new components immediately
    } else {
      state.backfillResult = { error: data.error || `Request failed (${res.status})` };
    }
  } catch (e) {
    state.backfillResult = { error: e.message };
  } finally {
    state.backfillRunning = false;
    render();
  }
}

// ── NUTRITION VERIFICATION BACKFILL ──
// Repair one ingredient whose nutrition can't scale:
//   (a) fsFood with a stored id but an unusable serving → re-fetch the food and re-pick the
//       serving the scaler can reconcile with the recipe amount (uses the new metric weights);
//   (b) no fsFood at all → FatSecret search (purchased product name first, then the cleaned
//       generic ingredient) and attach the first scalable match.
// Returns 'repicked' | 'matched' | null.
async function _enrichIngredient(ing, forceSearch = false) {
  // Re-pick a better serving from the already-matched food — unless the match itself is
  // suspect (wrong food entirely), in which case go straight to a fresh search.
  if (!forceSearch && ing.fsFood?.id) {
    try {
      const r = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(ing.fsFood.id)}`);
      if (r.ok) {
        const food = await r.json();
        if (food?.servings?.length) {
          const fsFood = _fsFoodFromFood(food, ing);
          if (fsFood && _fsRecipeRatio(ing, fsFood) !== null) { ing.fsFood = fsFood; return 'repicked'; }
        }
      }
    } catch {}
  }
  const queries = [];
  if (ing.krogerName) queries.push({ q: _cleanProductName(ing.krogerName), branded: 1 });
  queries.push({ q: _cleanIngredientForSearch(ing.name), branded: 0 });
  for (const { q, branded } of queries) {
    if (!q) continue;
    const food = await _fsBestFood(q, {
      branded,
      allowUnvalidated: false,
      validate: f => { const c = _fsFoodFromFood(f, ing); return !!c && _fsRecipeRatio(ing, c) !== null; },
    });
    if (food) {
      const fsFood = _fsFoodFromFood(food, ing);
      if (fsFood && _fsRecipeRatio(ing, fsFood) !== null) { ing.fsFood = fsFood; return 'matched'; }
    }
  }
  return null;
}

// Verify/repair every ingredient of one recipe that either doesn't scale OR carries a
// suspect match (fsFood naming a completely different food, e.g. honey → "Raw Vegetable",
// or a contradictory variant, e.g. whole milk → "Fat Free Milk"), then persist the
// recomputed macros. Returns true when anything changed.
async function verifyRecipeNutrition(recipe) {
  let changed = false;
  for (const ing of recipe.ingredients || []) {
    const st = _fsScalingStatus(ing).status;
    const suspect = _fsMatchSuspect(ing);
    if (st === 'spice') {
      // Zero-cal/seasoning ingredients shouldn't carry a (mis)matched food at all.
      if (ing.fsFood && _ZERO_CAL_RE.test(_baseIngredientName(String(ing.name || '')).trim())) {
        ing.fsFood = null; changed = true;
      }
      continue;
    }
    if (st === 'scaled' && !suspect) continue;
    if (await _enrichIngredient(ing, suspect)) changed = true;
    else if (suspect) { ing.fsFood = null; changed = true; } // wrong food, no better match → drop it
  }
  if (changed) {
    const body = _recipeNutritionPayload(recipe);
    await authFetch(`${BACKEND}/recipes/${recipe.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return changed;
}

// Owner action: run the repair across the whole library with progress feedback.
async function backfillRecipeNutrition() {
  if (state.nutriVerifyRunning) return;
  state.nutriVerifyRunning = true;
  state.nutriVerifyProgress = { done: 0, total: state.recipes.length, fixed: 0 };
  render();
  for (const recipe of state.recipes) {
    try { if (await verifyRecipeNutrition(recipe)) state.nutriVerifyProgress.fixed++; } catch {}
    state.nutriVerifyProgress.done++;
    render();
  }
  state.nutriVerifyRunning = false;
  render();
}

async function loadRecipes() {
  try {
    const res = await authFetch(`${BACKEND}/recipes`);
    const data = await res.json();
    state.recipes = data.recipes || [];
    render();
  } catch {}
}

async function saveRecipe(recipe) {
  const res = await authFetch(`${BACKEND}/recipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe),
  });
  const data = await res.json();
  if (data.ok) {
    state.recipes.push(data.recipe);
    state.generatedRecipe = null;
    state.recipeView = data.recipe.id;
    state.recipeSubTab = 'library';
    // Auto-verify nutrition for the new recipe in the background (FatSecret match per
    // ingredient) so generated/imported recipes don't sit unverified until a cart push.
    verifyRecipeNutrition(data.recipe).then(() => render()).catch(() => {});
  }
  render();
}

async function deleteRecipe(id) {
  await authFetch(`${BACKEND}/recipes/${id}`, { method: 'DELETE' });
  state.recipes = state.recipes.filter(r => r.id !== id);
  state.weeklyPlan.delete(id);
  if (state.recipeView === id) state.recipeView = null;
  save();
  render();
}

async function generateRecipe() {
  state.recipeGenerating = true;
  state.generatedRecipe = null;
  render();
  try {
    const existingNames = state.recipes.map(r => r.name);
    const res = await authFetch(`${BACKEND}/recipes/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state.recipeGenForm, existingNames }),
    });
    const data = await res.json();
    if (data.recipe) state.generatedRecipe = data.recipe;
  } catch {}
  state.recipeGenerating = false;
  render();
}

async function remixRecipe(id) {
  state.recipeRemixing = true;
  render();
  try {
    const res = await authFetch(`${BACKEND}/recipes/${id}/remix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: state.recipeRemixDirection }),
    });
    const data = await res.json();
    if (data.recipe) {
      state.generatedRecipe = data.recipe;
      state.recipeSubTab = 'generate';
      state.recipeView = null;
    }
  } catch {}
  state.recipeRemixing = false;
  state.recipeRemixDirection = '';
  render();
}

function viewRecipe(id) {
  state.recipeView = id;
  state.recipeSubTab = 'library';
  const recipe = state.recipes.find(r => r.id === id);
  state._recipeDraftNotes = recipe?.notes || '';
  _healRecipeNutrition(recipe);
  render();
}

// Self-heal on view: re-bake scaling and refresh the persisted perServing when either
//   (a) some fsFood was attached without scaling markers (server cart backfill path), or
//   (b) the stored header macros no longer match what the CURRENT scaling math computes —
//       happens whenever the unit/serving logic improves after a recipe was persisted.
// Cheap when in sync (one recompute, no network) and converges in one pass.
function _healRecipeNutrition(recipe) {
  if (!recipe) return;
  const missingMarker = (recipe.ingredients || []).some(ing =>
    ing.fsFood && !ing.fsFood.scaledPerRecipe && !ing.fsFood.scalingError
    && !ing.fsFood.scalingWarning && !ing.fsFood.scalingSkipped);
  let stale = false;
  if (!missingMarker) {
    const r = recalcRecipePerServingFromFs(recipe);
    if (r) {
      const p = recipe.perServing || {};
      stale = Math.abs((p.kcal    || 0) - r.perServing.kcal)    > 1
           || Math.abs((p.protein || 0) - r.perServing.protein) > 0.2
           || Math.abs((p.carbs   || 0) - r.perServing.carbs)   > 0.2
           || Math.abs((p.fat     || 0) - r.perServing.fat)     > 0.2;
    }
  }
  if (!missingMarker && !stale) return;
  const body = _recipeNutritionPayload(recipe); // mutates recipe in place, so this render is healed
  authFetch(`${BACKEND}/recipes/${recipe.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function closeRecipeView() {
  state.recipeView = null;
  state.generatedRecipe = null;
  render();
}

function setRecipeSubTab(tab) {
  state.recipeSubTab = tab;
  if (tab === 'generate') { state.recipeView = null; state.generatedRecipe = null; }
  if (tab === 'import')   { state.recipeView = null; state.generatedRecipe = null; state.recipeImport.error = null; }
  render();
}

// Import a recipe from a cooking-site URL via the server, then present it in the
// same review UI used for generated recipes (state.generatedRecipe).
async function importRecipeFromUrl() {
  const url = (state.recipeImport.url || '').trim();
  if (!url) return;
  state.recipeImport.loading = true;
  state.recipeImport.error = null;
  state.generatedRecipe = null;
  render();
  try {
    const res = await authFetch(`${BACKEND}/recipes/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (res.ok && data.recipe) {
      state.generatedRecipe = data.recipe;
      try { state.recipeImport.source = new URL(url).hostname.replace(/^www\./, ''); }
      catch { state.recipeImport.source = null; }
    } else {
      state.recipeImport.error = data.error || `Import failed (${res.status})`;
    }
  } catch (e) {
    state.recipeImport.error = e.message || 'Import failed';
  }
  state.recipeImport.loading = false;
  render();
}

function getRecipeScale(id, defaultServings) {
  return state.recipeScaleServings[id] ?? defaultServings;
}

function setRecipeScale(id, val) {
  state.recipeScaleServings[id] = Math.max(1, Math.min(24, parseInt(val) || 1));
  render();
}

function toggleWeeklyPlan(id) {
  if (state.weeklyPlan.has(id)) state.weeklyPlan.delete(id);
  else state.weeklyPlan.add(id);
  save();
  render();
}

function toggleIngredientExclude(key) {
  if (state.recipeIngredientExcludes.has(key)) state.recipeIngredientExcludes.delete(key);
  else state.recipeIngredientExcludes.add(key);
  save(); render();
}

function toggleSpiceInclude(key) {
  if (state.recipeIngredientIncludes.has(key)) state.recipeIngredientIncludes.delete(key);
  else state.recipeIngredientIncludes.add(key);
  save(); render();
}

// Assign a grocery category to a base ingredient name
function categorizeIngredient(name) {
  const n = name.toLowerCase();

  // ── Specific overrides that would mis-fire on general rules ──
  if (/\bbutter\s*lettuce\b/.test(n)) return 'produce';        // "butter lettuce" → not dairy
  if (/\b(peanut|almond|nut)\s*butter\b/.test(n)) return 'pantry'; // "peanut butter" → not dairy
  if (/\bbell\b/.test(n)) return 'produce';                    // "red bell pepper" → not spice
  if (/\b(jalape|habanero|serrano|poblano|anaheim|fresno)\b/.test(n)) return 'produce';
  if (/\b(red|green|yellow|orange|sweet)\s+pepper\b/.test(n) && !/\bflake/.test(n)) return 'produce';

  // ── Pantry overrides (before meat/produce to catch compound names) ──
  if (/\b(broth|stock)\b/.test(n)) return 'pantry';
  if (/\boil\b/.test(n)) return 'pantry';
  if (/\b(vinegar|sauce|paste|syrup|honey|molasses|extract|glaze)\b/.test(n)) return 'pantry';
  if (/\b(flour|sugar|rice|grain|noodle|pasta|bread|tortilla|chip|cracker|lentil|bean|corn\s*starch|baking)\b/.test(n)) return 'pantry';
  if (/\b(canned|coconut\s*milk|coconut\s*cream|tomato\s*sauce|tomato\s*paste|diced\s*tomato|crushed\s*tomato)\b/.test(n)) return 'pantry';

  // ── Spices & Seasonings (after produce overrides so pepper/garlic route correctly) ──
  if (/\b(salt|pepper|cumin|paprika|oregano|chili|cayenne|coriander|turmeric|cinnamon|thyme|rosemary|bay\s*leaf|allspice|nutmeg|cardamom|seasoning|spice|flakes|dried|powder)\b/.test(n)) return 'spices';

  // ── Meat & Seafood ──
  if (/\b(chicken|beef|turkey|pork|steak|ground|chorizo|sausage|bacon|ham|lamb|shrimp|fish|tuna|cod|tilapia|crab|lobster|scallop|anchov|ribeye|sirloin|tenderloin|brisket|loin|cutlet|breast|thigh|wing|drumstick)\b/.test(n)) return 'meat';

  // ── Dairy & Eggs ──
  if (/\b(cheese|milk|butter|cream|yogurt|eggs?|queso|cotija|mozzarella|cheddar|parmesan|feta|gouda|brie|ricotta|whey)\b/.test(n)) return 'dairy';

  // ── Produce ──
  if (/\b(onion|garlic|tomato|pepper|lettuce|spinach|kale|arugula|cabbage|carrot|celery|cucumber|zucchini|broccoli|cauliflower|asparagus|mushroom|potato|yam|avocado|corn|cilantro|parsley|mint|scallion|green\s*onion|shallot|leek|fennel|eggplant|squash|radish|turnip|beet|lime|lemon|orange|apple|banana|grape|strawberry|blueberry|raspberry|mango|pineapple|peach|pear|cherry|melon|grapefruit|kiwi|plum|herb)\b/.test(n)) return 'produce';

  return 'pantry';
}

// Strip preparation notes to get the base ingredient name for grouping
function _baseIngredientName(raw) {
  return raw
    .replace(/\(.*?\)/g, '')   // remove (parenthetical notes)
    .replace(/,.*$/,    '')    // remove ", minced" / ", diced" etc.
    .replace(/\s+\b(cloves?|stalks?|heads?|bunches?|links?|sprigs?|slices?|strips?|pieces?)\s*$/i, '') // strip trailing unit words
    .replace(/^\b(fresh|frozen|dried|raw|cooked|canned|large|small|medium|extra-?large|ripe|whole)\s+/i, '') // strip leading adjectives
    .replace(/\s+/g,    ' ')
    .trim();
}

// Unit normalization — convert volume/weight to a common base so same-ingredient
// entries with different units (e.g. tbsp vs cup) accumulate into one line item.
const _VOL_TSP = { tsp:1, teaspoon:1, teaspoons:1, tbsp:3, tablespoon:3, tablespoons:3, cup:48, cups:48,
                   floz:6, ml:1/4.929, milliliter:1/4.929, milliliters:1/4.929, l:202.88, liter:202.88, liters:202.88 };
const _WT_OZ   = { oz:1, ounce:1, ounces:1, lb:16, lbs:16, pound:16, pounds:16,
                   g:1/28.3495, gram:1/28.3495, grams:1/28.3495, kg:35.274, kilogram:35.274, kilograms:35.274 };

function _toBase(amount, unit) {
  const u = (unit || '').toLowerCase().trim();
  if (u in _VOL_TSP) return { val: amount * _VOL_TSP[u], type: 'vol' };
  if (u in _WT_OZ)   return { val: amount * _WT_OZ[u],   type: 'wt'  };
  return null;
}

function _fromBase(val, type) {
  if (type === 'vol') {
    if (val >= 12) return { amount: Math.round(val / 48 * 4) / 4, unit: 'cup'  };
    if (val >= 1.5) return { amount: Math.round(val / 3  * 2) / 2, unit: 'tbsp' };
    return            { amount: Math.round(val * 4) / 4,            unit: 'tsp'  };
  }
  if (type === 'wt') {
    if (val >= 16) return { amount: Math.round(val / 16 * 4) / 4, unit: 'lb' };
    return          { amount: Math.round(val * 4) / 4,            unit: 'oz' };
  }
  return null;
}

// Parse a Kroger product size string (e.g. "8 OZ", "1 LB", "16.9 FL OZ") into
// base units so we can compute what fraction of a container a recipe uses.
// Returns { val, type } where type is 'vol' (tsp), 'wt' (oz), or 'oz' (ambiguous).
function _krogerSizeInBase(sizeStr) {
  if (!sizeStr) return null;
  const m = sizeStr.match(/^([\d.]+)\s*(.+)$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!val) return null;
  const u = m[2].trim().replace(/[\s.]/g, '').toUpperCase();
  if (u === 'TSP'  || u === 'TEASPOON'  || u === 'TEASPOONS')                   return { val,         type: 'vol' };
  if (u === 'TBSP' || u === 'TBS' || u === 'TABLESPOON' || u === 'TABLESPOONS') return { val: val*3,  type: 'vol' };
  if (u === 'FLOZ' || u === 'FLOZS' || u === 'FLUIDOUNCE' || u === 'FLUIDOUNCES') return { val: val*6, type: 'vol' };
  if (u === 'CUP'  || u === 'CUPS')         return { val: val*48, type: 'vol' };
  if (u === 'PT'   || u === 'PINT'  || u === 'PINTS')  return { val: val*96,  type: 'vol' };
  if (u === 'QT'   || u === 'QTS'   || u === 'QUART' || u === 'QUARTS') return { val: val*192, type: 'vol' };
  if (u === 'GAL'  || u === 'GALLON' || u === 'GALLONS') return { val: val*768, type: 'vol' };
  if (u === 'ML'   || u === 'MILLILITER' || u === 'MILLILITERS') return { val: val/4.929,  type: 'vol' };
  if (u === 'L'    || u === 'LTR'  || u === 'LITER' || u === 'LITERS') return { val: val*202.88, type: 'vol' };
  if (u === 'LB'   || u === 'LBS'  || u === 'POUND' || u === 'POUNDS') return { val: val*16,    type: 'wt' };
  if (u === 'G'    || u === 'GR'   || u === 'GRAM'  || u === 'GRAMS')  return { val: val/28.35, type: 'wt' };
  if (u === 'KG'   || u === 'KILOGRAM' || u === 'KILOGRAMS')            return { val: val*35.274, type: 'wt' };
  // "OZ" and "OUNCE" are ambiguous (weight or fluid); resolved against the recipe unit type
  if (u === 'OZ'   || u === 'OZS' || u === 'OUNCE' || u === 'OUNCES') return { val, type: 'oz' };
  return null;
}

// Parse count-based package sizes ("12 ct", "30 count", "1 dozen", "6 pk") → item count.
function _krogerSizeCount(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).match(/^([\d.]+)\s*(ct|count|each|ea|pk|pack|dozen)\b/i);
  if (!m) return null;
  let val = parseFloat(m[1]);
  if (!val) return null;
  if (/dozen/i.test(m[2])) val *= 12;
  return val;
}

// What fraction of ONE purchased container the given recipe amount uses (can be > 1 when more
// than one container is needed). Handles count packages ("12 ct"), weight↔weight, volume↔volume,
// and volume↔weight via ingredient density. Ambiguous "OZ" sizes are treated as fluid oz only for
// liquids — solids (e.g. a 28 OZ bag of frozen diced potatoes) are weight, cross-converted via
// density. Returns null when units can't be reconciled (callers fall back to 1 container).
function _containerFraction(amount, unit, ingredientName, sizeStr) {
  const amt = parseFloat(amount) || 0;
  if (!amt || !sizeStr) return null;
  const u = (unit || '').toLowerCase().trim();
  const isCount = !u || /^(count|piece|pieces|each|whole|large|small|medium|extra-?large|xl|jumbo)$/.test(u);

  const pkgCount = _krogerSizeCount(sizeStr);
  if (pkgCount) return isCount ? amt / pkgCount : null;

  const recBase = _toBase(amt, u);
  const kroBase = _krogerSizeInBase(sizeStr);
  if (!recBase || !kroBase || kroBase.val <= 0) return null;

  let kroType = kroBase.type;
  let kroVal  = kroBase.val;
  if (kroType === 'oz') {
    // Ambiguous "OZ": weight unless the recipe side is weight-free AND the food is a liquid.
    if (recBase.type === 'wt') kroType = 'wt';
    else if (typeof _LIQUID_RE !== 'undefined' && _LIQUID_RE.test(String(ingredientName || '').toLowerCase())) {
      kroVal *= 6; kroType = 'vol'; // 1 fl oz = 6 tsp
    } else kroType = 'wt';
  }

  if (kroType === recBase.type) return recBase.val / kroVal;

  // Cross-system (recipe volume vs package weight, or vice versa) via density (g/ml).
  const density = typeof _ingredientDensity === 'function' ? _ingredientDensity(ingredientName) : null;
  if (!density) return null;
  const ML_PER_TSP = 4.929, G_PER_OZ = 28.3495;
  const toGrams = (val, type) => type === 'vol' ? val * ML_PER_TSP * density : val * G_PER_OZ;
  const recGrams = toGrams(recBase.val, recBase.type);
  const kroGrams = toGrams(kroVal, kroType);
  return kroGrams > 0 ? recGrams / kroGrams : null;
}

// Estimate servings per container from the Kroger package size and a FatSecret per-serving
// description ("1 cup (85g)" in a 28 OZ bag ≈ 9.3). null when either side is unparseable.
function _servingsPerContainer(krogerSize, servingDescription, ingredientName) {
  const parsed = _parseServing(servingDescription);
  if (!parsed || parsed.unit === 'count') return null;
  const fraction = _containerFraction(parsed.amount, parsed.unit, ingredientName, krogerSize);
  if (!fraction || fraction <= 0) return null;
  const ppu = 1 / fraction;
  return ppu >= 0.5 ? Math.round(ppu * 10) / 10 : null;
}

// Fraction of one purchased container a single full recipe batch uses — shared container math.
// null when units are incompatible/unparseable (caller falls back to 1).
function _fractionalDeduction(pantryItem, recipeIng) {
  return _containerFraction(recipeIng.amount, recipeIng.unit, recipeIng.name, pantryItem.krogerSize);
}

function _normalizeUnit(cleanName, unit) {
  const u = (unit || '').toLowerCase().trim();
  if (!u) return '';
  if (u in _VOL_TSP || u in _WT_OZ) return unit; // vol/wt handled by _toBase — leave intact
  if (/^(large|small|medium|extra-?large|xl|ripe|whole|count|piece|pieces|each)$/i.test(u)) return '';
  // Food noun used as unit: strip if unit (singularized) matches the cleaned ingredient name
  const bn = cleanName.toLowerCase();
  const uSing = u.replace(/s$/, '');
  if (bn === u || bn === uSing || bn.startsWith(uSing + ' ') || bn.startsWith(u + ' ')) return '';
  return unit;
}

function getIngredientBase(recipeId, ingIndex, storedAmount) {
  return parseFloat(state.recipeIngredientOverrides[`${recipeId}:${ingIndex}`] ?? storedAmount) || 0;
}

// Stepper increment for an ingredient, by unit type:
//   whole countable items (no unit) → 1; weight/volume/everything else → 0.25.
function ingredientStep(unit) {
  return (unit || '').trim() === '' ? 1 : 0.25;
}

// `delta` is the increment in DISPLAYED (scaled) units; `factor` converts base↔displayed.
// The stepper operates on the currently displayed amount, never drops below one step
// (so it can't reach 0), and rounds to 2 decimals after each step to avoid float drift.
function adjustIngredient(recipeId, ingIndex, delta, originalAmount, factor) {
  const f = factor || 1;
  const step = Math.abs(delta);
  const currentDisplayed = getIngredientBase(recipeId, ingIndex, originalAmount) * f;
  let nextDisplayed = Math.round((currentDisplayed + delta) * 100) / 100;
  if (nextDisplayed < step) nextDisplayed = step; // minimum is the step size — never 0
  // Store the base at finer precision so the 2-decimal displayed value round-trips
  // exactly through the servings factor (avoids e.g. 3.75 re-expanding to 3.76).
  const nextBase = Math.round((nextDisplayed / f) * 10000) / 10000;
  if (nextBase === parseFloat(originalAmount)) {
    delete state.recipeIngredientOverrides[`${recipeId}:${ingIndex}`];
  } else {
    state.recipeIngredientOverrides[`${recipeId}:${ingIndex}`] = String(nextBase);
  }
  render();
}

function saveIngredientPermanent(recipeId, ingIndex) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  if (!recipe) return;
  const newAmt = state.recipeIngredientOverrides[`${recipeId}:${ingIndex}`];
  if (!newAmt) return;
  recipe.ingredients[ingIndex].amount = newAmt;
  delete state.recipeIngredientOverrides[`${recipeId}:${ingIndex}`];
  authFetch(`${BACKEND}/recipes/${recipeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: recipe.ingredients }),
  });
  render();
}

function resetIngredient(recipeId, ingIndex) {
  delete state.recipeIngredientOverrides[`${recipeId}:${ingIndex}`];
  render();
}

// ── PER-INGREDIENT CITY MARKET SEARCH (recipe detail view) ──
// Search a single recipe ingredient against City Market, then attach the matched product's
// UPC/name and FatSecret nutrition (fsFood) directly to the recipe ingredient, persisting via
// PUT /recipes/:id (full ingredients array — the route shallow-merges).

function openIngredientSearch(recipeId, idx) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  const ing = recipe?.ingredients[idx];
  state.ingredientSearch = {
    recipeId, idx,
    term: ing ? ing.name : '',
    loading: false, results: null, selecting: false,
  };
  render();
  searchIngredientCart(recipeId, idx);
}

function closeIngredientSearch() {
  state.ingredientSearch = null;
  render();
}

async function searchIngredientCart(recipeId, idx) {
  const s = state.ingredientSearch;
  if (!s || s.recipeId !== recipeId || s.idx !== idx) return;
  const term = (s.term || '').trim();
  if (!term) return;
  s.loading = true; s.results = null; render();
  try {
    const res = await authFetch(`${BACKEND}/search-cart`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [term] }),
    });
    const data = await res.json();
    s.results = (data.results || [])[0]?.products?.slice(0, 10) || [];
  } catch { s.results = []; }
  s.loading = false; render();
}

async function selectIngredientProduct(recipeId, idx, productIdx) {
  const s = state.ingredientSearch;
  if (!s || !s.results) return;
  const product = s.results[productIdx];
  const recipe = state.recipes.find(r => r.id === recipeId);
  const ing = recipe?.ingredients[idx];
  if (!product || !ing) return;
  s.selecting = true; render();

  // Fetch FatSecret nutrition for the chosen product — relevance-ranked, preferring a food
  // whose serving the scaler can reconcile with this ingredient's amount.
  let fsFood = null;
  try {
    const food = await _fsBestFood(_cleanProductName(product.name), {
      branded: true,
      validate: f => { const c = _fsFoodFromFood(f, ing); return !!c && _fsRecipeRatio(ing, c) !== null; },
    });
    if (food) fsFood = _fsFoodFromFood(food, ing);
  } catch {}

  ing.krogerUpc  = product.upc  || null;
  ing.krogerName = product.name || null;
  ing.krogerSize = product.size || null;
  ing.fsFood     = fsFood; // null when no FatSecret match

  state.ingredientSearch = null;
  // Scale this match to the recipe amount and refresh the header macros from real nutrition.
  const body = _recipeNutritionPayload(recipe);
  render();
  authFetch(`${BACKEND}/recipes/${recipeId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Consolidate ingredients across selected weekly recipes
function consolidateIngredients() {
  const selected = state.recipes.filter(r => state.weeklyPlan.has(r.id));
  const map = {};

  function addEntry(name, unit, scaledAmount, toTaste, recipeName, source) {
    const bn = name.toLowerCase();
    const u  = (unit || '').toLowerCase().trim();
    let key, based = null;

    if (toTaste) {
      key = `${bn}__taste`;
    } else {
      based = Number.isFinite(scaledAmount) ? _toBase(scaledAmount, u) : null;
      key   = based ? `${bn}__${based.type}` : `${bn}__${u}`;
    }

    if (!map[key]) map[key] = { name, unit, baseType: based?.type ?? null, amount: 0, toTaste, alsoToTaste: false, fromRecipes: [], sources: [] };
    if (!toTaste && Number.isFinite(scaledAmount)) map[key].amount += based ? based.val : scaledAmount;
    if (!map[key].fromRecipes.includes(recipeName)) map[key].fromRecipes.push(recipeName);
    if (source) map[key].sources.push(source);
  }

  for (const recipe of selected) {
    const scale = getRecipeScale(recipe.id, recipe.servings);
    const factor = scale / recipe.servings;
    for (const [i, ing] of recipe.ingredients.entries()) {
      const toTaste = /to\s*taste/i.test(ing.amount) || /to\s*taste/i.test(ing.unit);
      const cleanName = _baseIngredientName(ing.name);
      const source = { recipeId: recipe.id, ingIndex: i };
      if (toTaste) {
        // Split compound entries: "salt and black pepper" → ["salt", "black pepper"]
        const parts = cleanName.split(/\s+and\s+|\s*&\s*/i).map(p => p.trim()).filter(Boolean);
        for (const part of parts) addEntry(part, '', 0, true, recipe.name, source);
      } else {
        const base = getIngredientBase(recipe.id, i, ing.amount);
        const normUnit = _normalizeUnit(cleanName, ing.unit);
        addEntry(cleanName, normUnit, base * factor, false, recipe.name, source);
      }
    }
  }

  // Merge standalone "to taste" entries into precise-amount entries for the same ingredient
  for (const [key, entry] of Object.entries(map)) {
    if (!entry.toTaste) continue;
    const bn = entry.name.toLowerCase();
    const preciseKeys = Object.keys(map).filter(k => !map[k].toTaste && map[k].name.toLowerCase() === bn);
    if (preciseKeys.length > 0) {
      for (const pk of preciseKeys) {
        map[pk].alsoToTaste = true;
        for (const r of entry.fromRecipes) if (!map[pk].fromRecipes.includes(r)) map[pk].fromRecipes.push(r);
        map[pk].sources.push(...entry.sources);
      }
      delete map[key];
    }
  }

  // Collapse entries with the same base ingredient name but incompatible units
  // (e.g. "fresh cilantro" vol + "cilantro" bunch from different recipes)
  const seenNames = {};
  for (const key of Object.keys(map)) {
    const bn = map[key].name.toLowerCase();
    if (!seenNames[bn]) { seenNames[bn] = key; continue; }
    const existKey = seenNames[bn];
    // Keep whichever has a convertible unit (baseType); else keep the first
    const winner = map[existKey].baseType ? existKey : (map[key].baseType ? key : existKey);
    const loser  = winner === existKey ? key : existKey;
    for (const r of (map[loser]?.fromRecipes || []))
      if (!map[winner].fromRecipes.includes(r)) map[winner].fromRecipes.push(r);
    map[winner].sources.push(...(map[loser]?.sources || []));
    if (map[loser]?.alsoToTaste) map[winner].alsoToTaste = true;
    delete map[loser];
    seenNames[bn] = winner;
  }

  return Object.values(map).map(c => {
    let amt, unit;
    if (c.toTaste) {
      amt = 0; unit = '';
    } else if (c.baseType) {
      const converted = _fromBase(c.amount, c.baseType);
      if (converted) { amt = converted.amount; unit = converted.unit; }
      else { amt = parseFloat(c.amount.toFixed(2)); unit = c.unit; }
    } else {
      amt = c.amount % 1 === 0 ? c.amount : parseFloat(c.amount.toFixed(1));
      unit = c.unit;
    }
    const amtStr = amt > 0 ? `${amt} ${unit}`.trim() : '';
    const display = c.toTaste      ? `${c.name} — to taste`
      : c.alsoToTaste ? `${amtStr} ${c.name} (+ to taste)`.trim()
      : `${amtStr} ${c.name}`.trim();
    const category = categorizeIngredient(c.name);
    return { ...c, amount: amt, unit, display, searchTerm: c.name, category };
  });
}

// Pre-chosen product for a set of {recipeId, ingIndex} sources: the most common krogerUpc
// among the contributing recipe ingredients (ties → first seen).
function _chosenProductFromSources(sources) {
  const counts = new Map();
  for (const s of sources || []) {
    const ing = state.recipes.find(r => r.id === s.recipeId)?.ingredients?.[s.ingIndex];
    if (!ing?.krogerUpc) continue;
    const e = counts.get(ing.krogerUpc) || { upc: ing.krogerUpc, name: ing.krogerName || null, size: ing.krogerSize || null, n: 0 };
    e.n++;
    counts.set(ing.krogerUpc, e);
  }
  let best = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best;
}

// Post-process /search-cart results against state.cartItemMeta: select the pre-chosen product
// when the ingredient was already matched in the recipe view (inserting it if City Market search
// didn't surface it), then derive a suggested purchase quantity from the package size.
function _applyCartMeta(results) {
  for (const r of results) {
    const meta = state.cartItemMeta[r.item];
    if (meta?.chosenUpc) {
      let idx = (r.products || []).findIndex(p => p.upc === meta.chosenUpc);
      if (idx < 0) {
        r.products = r.products || [];
        r.products.unshift({ upc: meta.chosenUpc, name: meta.chosenName || 'Previously matched product', size: meta.chosenSize || '', price: null });
        idx = 0;
      }
      if (r.status !== 'found') r.status = 'found';
      r.prechosen = true;
      state.cartConfirmed[r.item] = idx;
    } else if (r.status === 'found') {
      state.cartConfirmed[r.item] = 0;
    }
    if (r.status === 'found') _suggestCartQty(r.item);
  }
}

// Suggested purchase qty for the currently selected product of a cart item, from the needed
// recipe amount vs the package size. Stores the per-package fraction on the meta for display.
// Re-run whenever the selected product changes (package size changes with it).
function _suggestCartQty(item) {
  const meta = state.cartItemMeta[item];
  const r = (state.cartSearchResults || []).find(x => x.item === item);
  if (!meta || !r || r.status !== 'found') return;
  const idx = typeof state.cartConfirmed[item] === 'number' ? state.cartConfirmed[item] : 0;
  const product = r.products?.[idx];
  const fraction = product ? _containerFraction(meta.amount, meta.unit, meta.ingredientName, product.size) : null;
  meta.fraction = fraction;
  if (fraction) state.cartQuantities[item] = Math.min(20, Math.max(1, Math.ceil(fraction - 0.02))); // tolerate 2% overage
}

async function _runCartSearch(items) {
  const res = await authFetch(`${BACKEND}/search-cart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const data = await res.json();
  state.cartSearchResults = data.results || [];
  _applyCartMeta(state.cartSearchResults);
  // Auto-lookup extended nutrition for the selected product of every found item
  for (const r of state.cartSearchResults) {
    const idx = typeof state.cartConfirmed[r.item] === 'number' ? state.cartConfirmed[r.item] : 0;
    if (r.status === 'found' && r.products?.[idx])
      fsLookupCartProduct(r.item, idx, r.products[idx].name);
  }
}

async function searchRecipeIngredients() {
  const ingredients = consolidateIngredients();
  if (!ingredients.length) return;
  state.cartSearchLoading = true;
  state.cartSearchResults = null;
  state.cartConfirmed = {};
  state.cartItemMeta = {};
  state.cartPushResults = null;
  state.cartSourceRecipeId = null; // weekly plan — multiple recipes
  render();
  const included = ingredients.filter(i =>
    i.category === 'spices'
      ? state.recipeIngredientIncludes.has(i.display)
      : !state.recipeIngredientExcludes.has(i.display)
  );
  for (const ing of included) {
    const chosen = _chosenProductFromSources(ing.sources);
    state.cartItemMeta[ing.display] = {
      sources: ing.sources || [],
      ingredientName: ing.name,
      amount: ing.amount, unit: ing.unit,
      chosenUpc: chosen?.upc || null, chosenName: chosen?.name || null, chosenSize: chosen?.size || null,
    };
  }
  try {
    await _runCartSearch(included.map(i => i.display));
  } catch (e) { state.cartSearchResults = []; }
  state.cartSearchLoading = false;
  render();
}

async function pushRecipeToCart(recipe) {
  const scale = getRecipeScale(recipe.id, recipe.servings);
  const factor = scale / recipe.servings;
  state.cartItemMeta = {};
  const items = recipe.ingredients.map((ing, i) => {
    const base = getIngredientBase(recipe.id, i, ing.amount);
    const scaled = base * factor;
    const amt = Number.isFinite(scaled) ? (Number.isInteger(scaled) ? scaled : scaled.toFixed(1)) : ing.amount;
    const item = `${amt} ${ing.unit} ${ing.name}`.trim();
    state.cartItemMeta[item] = {
      sources: [{ recipeId: recipe.id, ingIndex: i }],
      ingredientName: _baseIngredientName(ing.name),
      amount: Number.isFinite(scaled) ? scaled : (parseFloat(ing.amount) || 0),
      unit: ing.unit,
      chosenUpc: ing.krogerUpc || null, chosenName: ing.krogerName || null, chosenSize: ing.krogerSize || null,
    };
    return item;
  });
  state.cartSearchLoading = true;
  state.cartSearchResults = null;
  state.cartConfirmed = {};
  state.cartPushResults = null;
  state.cartSourceRecipeId = recipe.id; // single recipe push
  render();
  try {
    await _runCartSearch(items);
  } catch { state.cartSearchResults = []; }
  state.cartSearchLoading = false;
  // Navigate to grocery tab to show review
  state.tab = 'grocery';
  render();
}

// Bake scaledPerRecipe onto every matched ingredient and (re)derive the recipe's header macros
// from that real nutrition, blended with the original Haiku estimate for unmatched ingredients.
// Mutates `recipe` and returns the PUT body to persist (always includes ingredients; includes
// perServing + verification fields only when at least one ingredient is matched & scalable).
function _recipeNutritionPayload(recipe) {
  for (const ing of recipe.ingredients) _attachScaledPerRecipe(ing);
  const body = { ingredients: recipe.ingredients };
  const r = recalcRecipePerServingFromFs(recipe);
  if (r) {
    if (!recipe.perServingOriginal) recipe.perServingOriginal = { ...recipe.perServing }; // capture Haiku once
    recipe.perServing       = r.perServing;
    recipe.macrosVerified   = r.allMatched ? 'full' : 'partial';
    recipe.macrosMatchedCount = r.matched;
    recipe.macrosTotalCount   = r.total;
    Object.assign(body, {
      perServing:         recipe.perServing,
      perServingOriginal: recipe.perServingOriginal,
      macrosVerified:     recipe.macrosVerified,
      macrosMatchedCount: r.matched,
      macrosTotalCount:   r.total,
    });
  }
  return body;
}

// Persist nutrition matches from the cart review back to recipe ingredients in KV.
// This allows fsEnrichMeal to use the actual purchased product's data instead of re-searching.
async function _saveCartNutritionToRecipes() {
  const updates = new Map(); // recipeId → recipe (mutated in place)

  // Attach the matched product's FatSecret id (for fsEnrichMeal) plus the actual product's
  // UPC/name and per-ingredient fsFood nutrition onto the recipe ingredient. Reuses the
  // nutrition already fetched during cart review — no extra FatSecret calls.
  function recordMatch(recipe, ingredient, food, product) {
    updates.set(recipe.id, recipe);
    if (food?.id) {
      recipe.ingredientFdcIds = { ...(recipe.ingredientFdcIds || {}), [ingredient.name]: food.id };
      const fsFood = _fsFoodFromFood(food, ingredient);
      if (fsFood) ingredient.fsFood = fsFood;
    }
    if (product) {
      if (product.upc)  ingredient.krogerUpc  = product.upc;
      if (product.name) ingredient.krogerName = product.name;
      if (product.size) ingredient.krogerSize = product.size;
    }
  }

  // cartItemMeta.sources points at the exact {recipeId, ingIndex} contributors for every cart
  // item (single-recipe and weekly pushes alike) — no name/substring matching needed.
  for (const r of state.cartSearchResults || []) {
    if (r.status !== 'found' || state.cartConfirmed[r.item] === 'skip') continue;
    const idx = typeof state.cartConfirmed[r.item] === 'number' ? state.cartConfirmed[r.item] : 0;
    const food = state.cartNutrition[`${r.item}::${idx}`];
    const product = r.products?.[idx];
    if (!food?.id && !product) continue;
    for (const s of state.cartItemMeta[r.item]?.sources || []) {
      const recipe = state.recipes.find(rec => rec.id === s.recipeId);
      const match = recipe?.ingredients?.[s.ingIndex];
      if (match) recordMatch(recipe, match, food, product);
    }
  }

  for (const [recipeId, recipe] of updates) {
    try {
      const body = _recipeNutritionPayload(recipe);
      body.ingredientFdcIds = recipe.ingredientFdcIds || {};
      await authFetch(`${BACKEND}/recipes/${recipeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {}
  }
}

async function _addToPantry() {
  const newItems = [];

  for (const r of state.cartSearchResults || []) {
    if (r.status !== 'found') continue;
    const idx = state.cartConfirmed[r.item] ?? 0;
    if (state.cartConfirmed[r.item] === 'skip') continue;
    const food = state.cartNutrition[`${r.item}::${idx}`] || null;
    const product = r.products[idx];

    const meta = state.cartItemMeta[r.item];
    const ingredientName = meta?.ingredientName || r.searchTerm;
    const amount = meta ? (parseFloat(meta.amount) || 1) : 1;
    const unit = meta?.unit || '';
    const fromRecipes = [...new Set((meta?.sources || [])
      .map(s => state.recipes.find(rec => rec.id === s.recipeId)?.name)
      .filter(Boolean))];

    const qty = state.cartQuantities[r.item] || 1;
    // Estimate servings per container from the package size + FatSecret serving so the pantry
    // can track portions, not just containers (user-editable afterwards).
    const ppu = (product?.size && food?.servings?.[0])
      ? _servingsPerContainer(product.size, food.servings[0].description, ingredientName)
      : null;
    newItems.push({
      id: crypto.randomUUID(),
      display: r.item,
      ingredientName,
      // Recipe amounts kept for reference only — pantry tracks purchase units, not recipe measurements
      recipeAmount: amount,
      recipeUnit: unit,
      // Purchase quantity: 1 can, 2 packs, etc.
      amount: qty,
      unit: '',
      remaining: qty,
      quantity: qty,
      portionsPerUnit: ppu || 1,
      fsFood: food,
      krogerName: product?.name || '',
      krogerSize: product?.size || '',
      krogerUpc: product?.upc || '',
      purchasedAt: new Date().toISOString(),
      fromRecipes,
    });
  }

  if (!newItems.length) return;

  // Merge: add to remaining if same ingredientName already in pantry, else append
  const updated = state.pantry.map(p => {
    const match = newItems.find(n => n.ingredientName === p.ingredientName);
    if (!match) return p;
    return { ...p, remaining: Math.round((p.remaining + match.remaining) * 100) / 100,
             amount: Math.round(((p.amount || 0) + match.amount) * 100) / 100,
             purchasedAt: match.purchasedAt, fsFood: match.fsFood || p.fsFood,
             // Keep a user-set portions/container; otherwise adopt the fresh estimate
             portionsPerUnit: (p.portionsPerUnit && p.portionsPerUnit !== 1) ? p.portionsPerUnit : match.portionsPerUnit,
             krogerName: match.krogerName || p.krogerName,
             krogerSize: match.krogerSize || p.krogerSize };
  });
  const merged = new Set(updated.map(p => p.ingredientName));
  const appended = [...updated, ...newItems.filter(n => !merged.has(n.ingredientName))];

  state.pantry = appended;
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: appended }),
  }).catch(() => {});
}

// Single fuzzy pantry↔ingredient match rule, shared by the "In pantry" badge, macro
// computation, and deduction so they always agree.
function _pantryItemMatches(p, baseName) {
  const pn = (p.ingredientName || '').toLowerCase();
  if (!pn || !baseName) return false;
  return pn === baseName || baseName.includes(pn) || pn.includes(baseName);
}

function _deductFromPantry(recipe, servings) {
  if (!state.pantry.length) return;
  const factor = servings / recipe.servings;
  let changed = false;
  const updated = state.pantry.map(p => {
    const ing = recipe.ingredients.find(i =>
      _pantryItemMatches(p, _baseIngredientName(i.name).toLowerCase()));
    if (!ing) return p;
    // Fraction of 1 purchase unit the recipe uses per full batch (e.g. 0.375 for 6 tbsp from an 8 oz container).
    // Falls back to 1 (whole unit per batch) when units are unparseable or incompatible.
    const fraction = _fractionalDeduction(p, ing) ?? 1;
    const newRem = Math.max(0, Math.round((p.remaining - factor * fraction) * 100) / 100);
    if (newRem === p.remaining) return p;
    changed = true;
    return { ...p, remaining: newRem };
  });
  if (!changed) return;
  state.pantry = updated;
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: updated }),
  }).catch(() => {});
}

function hasPantryIngredients(recipe) {
  if (!state.pantry.length) return false;
  const mainIngs = (recipe.ingredients || []).filter(i => categorizeIngredient(i.name) !== 'spices');
  if (!mainIngs.length) return false;
  const matched = mainIngs.filter(ing => {
    const base = _baseIngredientName(ing.name).toLowerCase();
    return state.pantry.some(p => p.remaining > 0 && _pantryItemMatches(p, base));
  });
  return matched.length >= Math.ceil(mainIngs.length * 0.6);
}

function saveRecipeNotes(id) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe || recipe.notes === (state._recipeDraftNotes || null)) return;
  recipe.notes = state._recipeDraftNotes || null;
  authFetch(`${BACKEND}/recipes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: recipe.notes }),
  }).catch(() => {});
}

async function rateRecipe(id, stars) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe) return;
  const rating = recipe.rating === stars ? null : stars;
  recipe.rating = rating;
  render();
  authFetch(`${BACKEND}/recipes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating }),
  }).catch(() => {});
}

async function confirmCartPush() {
  const confirmed = (state.cartSearchResults || [])
    .filter(r => r.status === 'found' && state.cartConfirmed[r.item] !== false && state.cartConfirmed[r.item] !== 'skip')
    .map(r => {
      const idx = state.cartConfirmed[r.item] ?? 0;
      const product = r.products[idx];
      return { item: r.item, upc: product.upc, name: product.name, quantity: state.cartQuantities[r.item] || 1 };
    });
  if (!confirmed.length) return;
  state.cartPushLoading = true;
  render();
  try {
    await _saveCartNutritionToRecipes();
    await _addToPantry(); // capture purchased ingredients + FatSecret data before state clears
    const res = await authFetch(`${BACKEND}/push-cart-confirmed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed, recipeId: state.cartSourceRecipeId || null }),
    });
    state.cartPushResults = await res.json();
    state.cartSearchResults = null;
    state.cartConfirmed = {};
  } catch (e) { state.cartPushResults = { error: e.message }; }
  state.cartPushLoading = false;
  render();
}

async function reSearchItem(item, term) {
  if (!term || !term.trim()) return;
  state.cartReSearching = { ...state.cartReSearching, [item]: true };
  render();
  try {
    const res = await authFetch(`${BACKEND}/search-cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [term.trim()] }),
    });
    const data = await res.json();
    if (data.results && data.results.length) {
      const found = { ...data.results[0], item };
      state.cartSearchResults = state.cartSearchResults.map(r => r.item === item ? found : r);
      if (found.status === 'found') {
        state.cartConfirmed[item] = 0;
        state.cartReSearchOpen[item] = false;
        _suggestCartQty(item);
      }
    }
  } catch {}
  state.cartReSearching = { ...state.cartReSearching, [item]: false };
  render();
}

function clearCartReview() {
  state.cartSearchResults = null;
  state.cartConfirmed = {};
  state.cartItemMeta = {};
  state.cartQuantities = {};
  state.cartReSearchTerms = {};
  state.cartReSearching = {};
  state.cartReSearchOpen = {};
  state.cartNutrition = {};
  state.cartNutritionLoading = {};
  state.cartNutritionQuery = {};
  state.cartNutritionResults = {};
  state.cartNutritionSearching = {};
  state.cartSourceRecipeId = null;
  state.cartPushResults = null;
  render();
}

// ── CUSTOM RECIPE CREATION ──

async function recipeIngSearch(query) {
  if (!query.trim()) { state.recipeCreateIngSearch.results = []; render(); return; }
  state.recipeCreateIngSearch.loading = true; render();
  try {
    const res = await authFetch(`${BACKEND}/fatsecret/search?q=${encodeURIComponent(query.trim())}`);
    const data = await res.json();
    state.recipeCreateIngSearch.results = data.results || [];
  } catch { state.recipeCreateIngSearch.results = []; }
  state.recipeCreateIngSearch.loading = false; render();
}

async function recipeIngSelectFood(id) {
  state.recipeCreateIngSearch.food = null;
  state.recipeCreateIngSearch.loading = true; render();
  try {
    const res = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(id)}`);
    state.recipeCreateIngSearch.food = await res.json();
    state.recipeCreateIngSearch.servingIdx = 0;
    state.recipeCreateIngSearch.qty = 1;
  } catch {}
  state.recipeCreateIngSearch.loading = false; render();
}

function addIngredientToCreate() {
  const ings = state.recipeCreateIngSearch;
  const food  = ings.food;
  if (!food) return;
  const srv   = food.servings[ings.servingIdx];
  if (!srv) return;
  const qty   = ings.qty;
  const n     = srv.nutrition;

  // Derive a parseable amount/unit from the serving description so consolidation, cart
  // scaling, and pantry deduction work on custom recipes ("1 cup (240g)" × 2 → "2 cup";
  // whole-item servings ("1 breast") → unitless count).
  const desc = String(srv.description || '');
  const lead = parseFloat(desc.replace(/\(.*?\)/g, '').trim()) || 1;
  const textUnit = _servingTextUnit(desc);
  const parsed = _parseServing(desc);
  let amount, unit;
  if (textUnit in _VOL_TSP || textUnit in _WT_OZ) { amount = String(lead * qty); unit = textUnit; }
  else if (parsed && parsed.unit !== 'count')     { amount = String(parsed.amount * qty); unit = parsed.unit; }
  else                                            { amount = String(lead * qty); unit = ''; }

  state.recipeCreateForm.ingredients.push({
    name:        food.name,
    qty,
    servingDesc: srv.description,
    amount,
    unit,
    // Real per-serving nutrition travels with the ingredient — custom recipes are
    // verified from the start instead of falling back to estimates.
    fsFood:      _fsFoodFromFood({ id: food.id, name: food.name, servings: [srv] }),
    kcalTotal:    Math.round(n.kcal    * qty),
    proteinTotal: Math.round(n.protein * qty * 10) / 10,
    carbsTotal:   Math.round(n.carbs   * qty * 10) / 10,
    fatTotal:     Math.round(n.fat     * qty * 10) / 10,
  });
  state.recipeCreateIngSearch = { query: '', results: [], loading: false, food: null, servingIdx: 0, qty: 1 };
  render();
}

function removeCreateIngredient(i) {
  state.recipeCreateForm.ingredients.splice(i, 1);
  render();
}

async function saveCustomRecipe() {
  const f = state.recipeCreateForm;
  if (!f.name.trim() || !f.ingredients.length) return;
  const totals = f.ingredients.reduce((a, i) => ({
    kcal: a.kcal + i.kcalTotal, protein: a.protein + i.proteinTotal,
    carbs: a.carbs + i.carbsTotal, fat: a.fat + i.fatTotal,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const srv = f.servings || 1;
  const recipe = {
    name:        f.name.trim(),
    mealType:    f.mealType,
    cuisine:     f.cuisine,
    cookTime:    f.cookTime,
    servings:    srv,
    weekendOnly: f.weekendOnly,
    kidPlate:    f.kidPlate || null,
    notes:       f.notes || null,
    ingredients: f.ingredients.map(i => ({ name: i.name, amount: i.amount, unit: i.unit ?? i.servingDesc, fsFood: i.fsFood || null })),
    steps:       f.steps.filter(s => s.trim()),
    perServing: {
      kcal:    Math.round(totals.kcal    / srv),
      protein: Math.round(totals.protein / srv * 10) / 10,
      carbs:   Math.round(totals.carbs   / srv * 10) / 10,
      fat:     Math.round(totals.fat     / srv * 10) / 10,
    },
    tags: [],
    rating: null,
    ingredientFdcIds: {},
  };
  await saveRecipe(recipe);
  state.recipeCreateForm = { name:'',mealType:'dinner',cuisine:'Mexican',cookTime:30,servings:4,weekendOnly:false,kidPlate:'',notes:'',ingredients:[],steps:[] };
  state.recipeCreateIngSearch = { query:'',results:[],loading:false,food:null,servingIdx:0,qty:1 };
}

// ── MEAL PREP ──

function openPreparePanel(recipeId) {
  state.preparePanel = { recipeId, portions: 1 };
  render();
}

function closePreparePanel() {
  state.preparePanel = null;
  render();
}

function setPreparePortions(val) {
  if (!state.preparePanel) return;
  state.preparePanel.portions = Math.max(1, Math.min(24, parseInt(val) || 1));
  render();
}

async function confirmPrepare() {
  const panel = state.preparePanel;
  if (!panel) return;
  const recipe = state.recipes.find(r => r.id === panel.recipeId);
  if (!recipe) return;
  const portions = panel.portions;

  const purchased = computeMacrosFromPantry(recipe, portions);
  let portionMacros;
  if (purchased) {
    portionMacros = {
      kcal:    Math.round(purchased.kcal    / portions),
      protein: Math.round(purchased.protein / portions * 10) / 10,
      carbs:   Math.round(purchased.carbs   / portions * 10) / 10,
      fat:     Math.round(purchased.fat     / portions * 10) / 10,
    };
    if (purchased.matchedCount > 0) {
      portionMacros.fiber        = Math.round(purchased.fiber        / portions * 10) / 10;
      portionMacros.sugar        = Math.round(purchased.sugar        / portions * 10) / 10;
      portionMacros.saturatedFat = Math.round(purchased.saturatedFat / portions * 10) / 10;
      portionMacros.polyunsatFat = Math.round(purchased.polyunsatFat / portions * 10) / 10;
      portionMacros.cholesterol  = Math.round(purchased.cholesterol  / portions);
      portionMacros.sodium       = Math.round(purchased.sodium       / portions);
      portionMacros.potassium    = Math.round(purchased.potassium    / portions);
    }
    if (!purchased.blended) {
      portionMacros.fromPantry = true;
    } else {
      portionMacros.blended = true;
      portionMacros.unmatchedIngredients = purchased.unmatchedIngredients;
    }
  } else {
    portionMacros = {
      kcal:    Math.round(recipe.perServing.kcal),
      protein: Math.round(recipe.perServing.protein * 10) / 10,
      carbs:   Math.round(recipe.perServing.carbs   * 10) / 10,
      fat:     Math.round(recipe.perServing.fat     * 10) / 10,
    };
  }

  _deductFromPantry(recipe, portions);

  const entry = {
    id: crypto.randomUUID(),
    recipeId: recipe.id,
    recipeName: recipe.name,
    portionsRemaining: portions,
    portionMacros,
    preparedAt: new Date().toISOString(),
  };

  state.preparedMeals = [...state.preparedMeals, entry];
  state.preparePanel = null;
  await savePreparedMeals();
  render();
}

// ── RECIPE COMPONENT LOGGING ──
// Recipes generated with a `components` array can be logged piece-by-piece (e.g.
// "Tuna Filling" separately from "Bread & Assembly"). Component perServing macros
// come straight from Haiku — they are the only per-component nutrition source, so
// entries are flagged estimated. Pantry deduction already happened at Prepare Meal
// time, and fsEnrichMeal works at whole-meal level — neither runs here.

function _componentPortion(recipeId, ci) {
  return state.componentPortions[`${recipeId}::${ci}`] || 1;
}

function setComponentPortion(recipeId, ci, val) {
  const n = parseFloat(val);
  state.componentPortions[`${recipeId}::${ci}`] = Math.max(0.125, isNaN(n) ? 1 : Math.round(n * 8) / 8);
  render();
}

// Per-serving macros for a component computed from its ingredients' real (fsFood) data.
// Returns {kcal,protein,carbs,fat} only when EVERY non-spice member ingredient has fsFood that
// scales to its recipe amount; otherwise null (caller falls back to the Haiku perServing).
function _componentFsMacros(recipe, component) {
  const members = (component.ingredients || [])
    .map(n => recipe.ingredients.find(ing =>
      ing.name.toLowerCase() === n.toLowerCase() ||
      _baseIngredientName(ing.name).toLowerCase() === _baseIngredientName(n).toLowerCase()))
    .filter(Boolean);
  if (!members.length) return null;
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  let used = 0;
  for (const ing of members) {
    if (_isSpiceForScaling(ing)) continue;
    if (!ing.fsFood) return null;
    // Shared full-batch scaling — identical math to the recipe-detail display & macro recalc.
    const scaled = _fsScaledPerRecipe(ing, ing.fsFood);
    if (!scaled) return null;
    totals.kcal    += scaled.kcal    || 0;
    totals.protein += scaled.protein || 0;
    totals.carbs   += scaled.carbs   || 0;
    totals.fat     += scaled.fat     || 0;
    used++;
  }
  if (!used) return null;
  const srv = recipe.servings || 1;
  return { kcal: totals.kcal / srv, protein: totals.protein / srv, carbs: totals.carbs / srv, fat: totals.fat / srv };
}

// Build a daily-log entry for one component at the given portion. `id` is numeric
// so the inline meal-time picker (setMealTime) keeps working. When `macros` comes from
// fsFood (verified=true) the entry is logged as exact, not estimated.
function _componentMealEntry(recipe, component, portion, slot, id, macros, verified) {
  const p = macros || component.perServing || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  return {
    id,
    name: `${recipe.name} — ${component.name}${portion !== 1 ? ` (×${portion})` : ''}`,
    kcal:    Math.round((p.kcal    || 0) * portion),
    protein: roundMacro((p.protein || 0) * portion),
    carbs:   roundMacro((p.carbs   || 0) * portion),
    fat:     roundMacro((p.fat     || 0) * portion),
    mealSlot: slot,
    loggedAt: new Date().toISOString(),
    source: 'recipe-component',
    estimated: !verified,
    blended: !verified,   // reuse the existing ~est. indicator in the meal row
  };
}

function logRecipeComponent(recipeId, ci, slot) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  const component = recipe?.components?.[ci];
  if (!component) return;
  const portion = _componentPortion(recipeId, ci);
  const fsM = _componentFsMacros(recipe, component);
  state.meals.push(_componentMealEntry(recipe, component, portion, slot, Date.now(), fsM, !!fsM));
  save(); saveMealLog(); render();
}

// Log every component at its selected portion as individual, independently
// removable entries — not merged into one.
function logAllComponents(recipeId, slot) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  if (!recipe?.components?.length) return;
  const base = Date.now();
  recipe.components.forEach((component, ci) => {
    const portion = _componentPortion(recipeId, ci);
    const fsM = _componentFsMacros(recipe, component);
    state.meals.push(_componentMealEntry(recipe, component, portion, slot, base + ci, fsM, !!fsM));
  });
  save(); saveMealLog(); render();
}

// Component rows for the recipe log panel (used only when recipe.components exists).
function renderRecipeComponentLog(recipe, slot, color) {
  const circle = 'width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0';
  const rows = (recipe.components || []).map((c, ci) => {
    const portion = _componentPortion(recipe.id, ci);
    const fsM = _componentFsMacros(recipe, c);
    const p = fsM || c.perServing || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    const t = fsM ? '' : '~'; // verified (fsFood) components drop the ~ estimate prefix
    const f = v => { const x = (v || 0) * portion; return Math.round(x * 10) / 10; };
    return `<div style="padding:6px 0 6px 10px;border-left:2px solid ${color}33;margin-bottom:4px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:500">${esc(c.name)}</div>
          <div style="font-size:11px;color:var(--text3)">${t}${Math.round((p.kcal||0)*portion)} kcal · ${t}${f(p.protein)}g P · ${t}${f(p.carbs)}g C · ${t}${f(p.fat)}g F</div>
        </div>
        <button onclick="logRecipeComponent('${recipe.id}',${ci},'${slot}')" class="btn btn-green" style="padding:3px 10px;font-size:12px;flex-shrink:0">Log</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:11px;color:var(--text3)">Portion:</span>
        <button onclick="setComponentPortion('${recipe.id}',${ci},${portion - 0.125})" style="${circle}">−</button>
        <span style="font-size:13px;font-weight:600;min-width:28px;text-align:center">${fmtPortion(portion)}</span>
        <button onclick="setComponentPortion('${recipe.id}',${ci},${portion + 0.125})" style="${circle}">+</button>
      </div>
    </div>`;
  }).join('');
  return rows + `<button onclick="logAllComponents('${recipe.id}','${slot}')" class="btn" style="width:100%;margin-top:4px;font-size:12px;padding:5px;border:1px solid ${color};background:${color}22;color:${color};border-radius:8px;cursor:pointer">Log all components</button>`;
}

// ── RECIPE RENDER HELPERS ──

// Visual portion-size indicator: estimated physical weight of one serving with a 5-tier
// gauge (Snack-size → Very large). `compact` renders a one-line variant for library cards.
const _PORTION_TIERS = [
  { max: 150,      label: 'Snack-size', color: '#7F77DD' },
  { max: 300,      label: 'Light',      color: '#378ADD' },
  { max: 450,      label: 'Moderate',   color: '#1D9E75' },
  { max: 650,      label: 'Hearty',     color: '#EF9F27' },
  { max: Infinity, label: 'Very large', color: '#E24B4A' },
];

// "≈ 1¾ cups" from a per-serving ml estimate (¼-cup resolution); '' when under ¼ cup.
function _cupEquivalent(mlPerServing) {
  const q = Math.round((mlPerServing / 236.588) * 4) / 4;
  if (q < 0.25) return '';
  const w = Math.floor(q);
  const f = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - w) * 100) / 100] || '';
  return `≈ ${w || ''}${f} cup${q >= 1.75 ? 's' : ''}`;
}

function renderPortionGauge(recipe, compact = false) {
  const est = _recipePortionEstimate(recipe);
  if (!est) return '';
  const g = est.gramsPerServing;
  const tierIdx = _PORTION_TIERS.findIndex(t => g < t.max);
  const tier = _PORTION_TIERS[tierIdx];
  const gRounded = Math.round(g / 10) * 10;
  const approx = est.coverage < 1 ? '~' : '';
  const cups = _cupEquivalent(est.mlPerServing);

  if (compact) {
    return `<span style="font-size:10px;color:var(--text3)">🍽 ${approx}${gRounded} g${cups ? ` · ${cups}` : ''}/serving · <span style="color:${tier.color};font-weight:600">${tier.label}</span></span>`;
  }

  const oz = g / 28.3495;
  const cupStr = cups ? ` · ${cups}` : '';
  const dots = _PORTION_TIERS.map((t, i) =>
    `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${i <= tierIdx ? tier.color : 'var(--bg3)'};border:1px solid ${i <= tierIdx ? tier.color : 'var(--border)'}"></span>`).join('');
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:var(--bg3);border-radius:10px;margin-bottom:12px">
    <div>
      <div style="font-size:11px;color:var(--text3)">Portion size <span style="opacity:.7">(one serving, as prepared)</span></div>
      <div style="font-size:13px;font-weight:600">${approx}${gRounded} g · ${oz.toFixed(1)} oz${cupStr}</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="display:flex;gap:3px;justify-content:flex-end;margin-bottom:3px">${dots}</div>
      <div style="font-size:10px;font-weight:600;color:${tier.color}">${tier.label}</div>
    </div>
  </div>`;
}

function renderRecipeMacroBar(perServing, scale, servings, estimated = false) {
  // Always show per-serving values; scale/servings retained for signature compat.
  // `estimated` prefixes a ~ when the macros are a partial FatSecret/Haiku blend.
  const t = estimated ? '~' : '';
  const m = {
    kcal:    Math.round(perServing.kcal),
    protein: Math.round(perServing.protein * 10) / 10,
    carbs:   Math.round(perServing.carbs   * 10) / 10,
    fat:     Math.round(perServing.fat     * 10) / 10,
  };
  const bars = [
    { l: 'Cal', v: m.kcal, tgt: MACROS.kcal, c: '#D85A30' },
    { l: 'Protein', v: m.protein, tgt: MACROS.protein, c: '#1D9E75' },
    { l: 'Carbs', v: m.carbs, tgt: MACROS.carbs, c: '#378ADD' },
    { l: 'Fat', v: m.fat, tgt: MACROS.fat, c: '#EF9F27' },
  ].map(b => `
    <div style="flex:1;text-align:center">
      <div style="font-size:15px;font-weight:700;color:${b.c}">${t}${b.v}</div>
      <div style="font-size:10px;color:var(--text3)">${b.l}</div>
      <div style="height:3px;background:var(--bg3);border-radius:2px;margin-top:3px">
        <div style="height:100%;width:${Math.min(100,Math.round(b.v/b.tgt*100))}%;background:${b.c};border-radius:2px"></div>
      </div>
    </div>`).join('');
  return `<div style="padding:10px 0;border-bottom:1px solid var(--border);margin-bottom:12px">
    <div style="display:flex;gap:8px">${bars}</div>
    <div style="font-size:9px;color:var(--text3);text-align:right;margin-top:4px">per serving</div>
  </div>`;
}

function renderRecipeDetail(recipe, isPreview = false) {
  const id = recipe.id || 'preview';
  const scale = getRecipeScale(id, recipe.servings);
  const factor = scale / recipe.servings;

  // Proportional macro adjustment from ingredient overrides (approximate — mixed units)
  const overrideFactor = (() => {
    if (isPreview || !recipe.ingredients.length) return 1;
    let orig = 0, cur = 0;
    for (let i = 0; i < recipe.ingredients.length; i++) {
      const o = parseFloat(recipe.ingredients[i].amount) || 0;
      const c = parseFloat(state.recipeIngredientOverrides[`${id}:${i}`] ?? o) || 0;
      orig += o; cur += c;
    }
    return orig > 0 ? cur / orig : 1;
  })();
  // Header macros recomputed FRESH from current per-ingredient scaling so the summary always
  // agrees with the ingredient rows below. The persisted perServing can predate scaling-math
  // improvements; _healRecipeNutrition re-persists it, but the display never waits for that.
  const fsCalc = isPreview ? null : recalcRecipePerServingFromFs(recipe);
  const basisPerServing = fsCalc ? fsCalc.perServing : recipe.perServing;
  const adjustedPerServing = {
    kcal:    basisPerServing.kcal    * overrideFactor,
    protein: basisPerServing.protein * overrideFactor,
    carbs:   basisPerServing.carbs   * overrideFactor,
    fat:     basisPerServing.fat     * overrideFactor,
  };
  // Verification score — only ingredients we can meaningfully verify count toward the denominator:
  // spices/seasonings, "to taste" amounts, and volume-vs-weight unit mismatches are excluded so
  // they don't drag down the score. Drives the confidence label and the ~ marker on the header.
  const _statuses = isPreview ? [] : recipe.ingredients.map(ig => _fsScalingStatus(ig).status);
  const _scoreTotal = _statuses.filter(s => s !== 'spice' && s !== 'unit_mismatch').length;
  const _verifiedCount = _statuses.filter(s => s === 'scaled').length;
  const _allVerified = _scoreTotal > 0 && _verifiedCount === _scoreTotal;
  const _partialVerified = _verifiedCount > 0 && !_allVerified;
  const cuisineColors = { Mexican:'#EF9F27', Asian:'#E24B4A', American:'#378ADD', Italian:'#1D9E75' };
  const cc = cuisineColors[recipe.cuisine] || 'var(--text3)';
  const mealColors = { breakfast:'#1D9E75', lunch:'#378ADD', dinner:'#EF9F27' };
  const mc = mealColors[recipe.mealType || 'dinner'] || 'var(--text3)';
  const mealLabel = { breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner' }[recipe.mealType || 'dinner'];
  const timeTag = recipe.weekendOnly
    ? `<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(127,119,221,.15);color:#7F77DD">Weekend</span>`
    : `<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(29,158,117,.15);color:var(--green)">${recipe.cookTime} min</span>`;
  const mealTag = `<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:${mc}22;color:${mc}">${mealLabel}</span>`;
  const cuisineTag = `<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:${cc}22;color:${cc}">${esc(recipe.cuisine)}</span>`;

  const servingCtrl = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:12px;color:var(--text2)">Servings:</span>
      <button onclick="setRecipeScale('${id}',${scale-1})" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">−</button>
      <span style="font-size:16px;font-weight:600;min-width:20px;text-align:center">${scale}</span>
      <button onclick="setRecipeScale('${id}',${scale+1})" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">+</button>
      <span style="font-size:11px;color:var(--text3)">(base: ${recipe.servings})</span>
    </div>`;

  const hasOverrides = !isPreview && recipe.ingredients.some((_, i) => state.recipeIngredientOverrides[`${id}:${i}`]);
  const ingredientLabel = `<div style="font-size:11px;color:var(--text3);margin-bottom:6px">Total amounts for ${scale} serving${scale !== 1 ? 's' : ''}</div>`;
  const ingredients = ingredientLabel + recipe.ingredients.map((ing, i) => {
    const stored = parseFloat(ing.amount) || 0;
    const base = isPreview ? stored : getIngredientBase(id, i, ing.amount);
    const scaled = base * factor;
    const display = Number.isInteger(scaled) ? scaled : parseFloat(scaled.toFixed(2).replace(/\.?0+$/, ''));
    const step = ingredientStep(ing.unit);
    const isDirty = !isPreview && state.recipeIngredientOverrides[`${id}:${i}`] !== undefined;
    if (isPreview) {
      return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
        <span style="color:var(--text2);min-width:64px;flex-shrink:0">${display} ${esc(ing.unit)}</span>
        <span>${esc(ing.name)}</span>
      </div>`;
    }
    const isMatched = !!ing.krogerUpc;
    const fs = ing.fsFood;
    const srch = state.ingredientSearch;
    const searchOpen = !!srch && srch.recipeId === id && srch.idx === i;
    const f1 = v => Math.round((v || 0) * 10) / 10;
    // Per-serving contribution of this ingredient, scaled from the matched product's FatSecret
    // serving to the recipe amount (not the raw per-serving / whole-container figure).
    const per = fs ? _fsIngredientPerServing(recipe, ing) : null;
    const amtCtx = `${display}${ing.unit ? ' ' + esc(ing.unit) : ''}`.trim();
    const nutLine = !fs
      ? `<span style="font-size:10px;color:var(--text3)">no nutrition match</span>`
      : per.status === 'scaled'
        ? `<span style="font-size:10px;color:var(--text3)">${amtCtx} · ${Math.round(per.kcal)} kcal · ${f1(per.protein)}g P · ${f1(per.carbs)}g C · ${f1(per.fat)}g F<span style="opacity:.65"> per serving</span></span>`
        : per.status === 'unit_mismatch'
          ? `<span style="font-size:10px;color:var(--text3)">matched — serving size differs</span>`
          : per.status === 'spice'
            ? `<span style="font-size:10px;color:var(--text3)">seasoning / negligible — not counted</span>`
            : `<span style="font-size:10px;color:var(--orange)">⚠ can't scale to this product</span>`;
    const matchLine = isMatched
      ? `<div style="display:flex;align-items:center;gap:6px;padding:0 0 6px 68px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--green)">✓ ${esc(ing.krogerName || '')}</span>
          ${nutLine}
          <button onclick="openIngredientSearch('${id}',${i})" style="font-size:10px;padding:1px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text3);cursor:pointer">Change</button>
        </div>`
      : (searchOpen ? '' : `<div style="padding:0 0 6px 68px">
          <button onclick="openIngredientSearch('${id}',${i})" style="font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid var(--blue);background:rgba(55,138,221,.12);color:var(--blue);cursor:pointer">Search City Market</button>
        </div>`);
    const panel = searchOpen ? `
      <div style="padding:0 0 8px 68px">
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="input" style="flex:1;font-size:12px;padding:5px 8px" value="${esc(srch.term)}"
            oninput="state.ingredientSearch.term=this.value"
            onkeydown="if(event.key==='Enter')searchIngredientCart('${id}',${i})"/>
          <button onclick="searchIngredientCart('${id}',${i})" style="padding:4px 10px;font-size:12px;border-radius:8px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;flex-shrink:0" ${srch.loading?'disabled':''}>${srch.loading?'...':'Search'}</button>
          <button onclick="closeIngredientSearch()" style="padding:4px 8px;font-size:12px;border:none;background:none;color:var(--text3);cursor:pointer;flex-shrink:0">✕</button>
        </div>
        ${srch.selecting ? `<div style="font-size:11px;color:var(--text3);padding:2px 0">Fetching nutrition…</div>` : ''}
        ${!srch.selecting && srch.loading ? `<div style="font-size:11px;color:var(--text3);padding:2px 0">Searching…</div>` : ''}
        ${!srch.selecting && !srch.loading && srch.results && !srch.results.length ? `<div style="font-size:11px;color:var(--text3);padding:2px 0">No results — try another term.</div>` : ''}
        ${!srch.selecting && srch.results && srch.results.length ? `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
          ${srch.results.map((p, pi) => `<div onclick="selectIngredientProduct('${id}',${i},${pi})" style="padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px">
            <div style="font-weight:600">${esc(p.name)}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:1px">${esc(p.size||'')}${p.price?` · $${p.price}`:''}</div>
          </div>`).join('')}
        </div>` : ''}
      </div>` : '';
    return `<div style="border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px">
        <button onclick="adjustIngredient('${id}',${i},${-step},'${ing.amount}',${factor})"
          style="width:26px;height:26px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">−</button>
        <span style="min-width:60px;text-align:center;color:${isDirty ? 'var(--orange)' : 'var(--text2)'}">
          ${display} ${esc(ing.unit)}
        </span>
        <button onclick="adjustIngredient('${id}',${i},${step},'${ing.amount}',${factor})"
          style="width:26px;height:26px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">+</button>
        <span style="flex:1;font-size:13px">${esc(ing.name)}</span>
        ${isDirty ? `
          <button onclick="saveIngredientPermanent('${id}',${i})"
            style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--green);background:rgba(29,158,117,.12);color:var(--green);cursor:pointer;flex-shrink:0">Save</button>
          <button onclick="resetIngredient('${id}',${i})"
            style="font-size:10px;padding:2px 5px;border:none;background:none;color:var(--text3);cursor:pointer;flex-shrink:0">✕</button>
        ` : ''}
      </div>
      ${matchLine}${panel}
    </div>`;
  }).join('');

  // Nutrition-confidence indicator: green only when every non-spice ingredient has real (fsFood)
  // data that scales cleanly, orange when only some do, hidden when none (Haiku estimate as before).
  // The partial state shows the verified/estimated kcal split so the header total visibly
  // reconciles with the per-ingredient rows (which only show numbers for matched ingredients).
  const _verifiedKcalPerServing = (() => {
    if (isPreview) return 0;
    let total = 0;
    for (const ig of recipe.ingredients) {
      const st = _fsScalingStatus(ig);
      if (st.status === 'scaled') total += st.scaled.kcal || 0;
    }
    return total / (recipe.servings || 1);
  })();
  const _estKcalPerServing = Math.max(0, Math.round(basisPerServing.kcal - _verifiedKcalPerServing));
  const nutritionConfidence = (isPreview || !_scoreTotal || _verifiedCount === 0)
    ? ''
    : _allVerified
      ? `<div style="font-size:11px;color:var(--green);text-align:center;margin:-6px 0 12px">✓ Nutrition verified</div>`
      : `<div style="font-size:11px;color:var(--orange);text-align:center;margin:-6px 0 12px">Nutrition partially verified (${_verifiedCount} of ${_scoreTotal} ingredients)<br>
          <span style="color:var(--text3)">${Math.round(_verifiedKcalPerServing)} kcal/serving from matched ingredients + ~${_estKcalPerServing} kcal estimated for the rest</span></div>`;

  const steps = recipe.steps.map((s, i) => `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="width:22px;height:22px;border-radius:50%;background:var(--bg3);color:var(--text3);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</div>
      <div style="font-size:13px;line-height:1.5;color:var(--text2)">${esc(s)}</div>
    </div>`).join('');

  const kidPlate = recipe.kidPlate
    ? `<div style="margin-top:10px;padding:10px;background:rgba(55,138,221,.08);border-radius:10px;border-left:3px solid #378ADD">
        <div style="font-size:11px;font-weight:600;color:#378ADD;margin-bottom:3px">Kid plate</div>
        <div style="font-size:12px;color:var(--text2)">${esc(recipe.kidPlate)}</div>
      </div>` : '';

  const cartBtn = !isPreview && state.krogerConnected
    ? `<button onclick="pushRecipeToCart(state.recipes.find(r=>r.id==='${id}'))" class="btn btn-blue btn-full" style="margin-top:10px" ${state.cartSearchLoading?'disabled':''}>
        ${state.cartSearchLoading ? 'Searching City Market...' : 'Preview & push to City Market'}
      </button>` : '';

  const saveBtn = isPreview
    ? `<button onclick="saveRecipe(state.generatedRecipe)" class="btn btn-green btn-full" style="margin-top:10px">Save to library</button>` : '';

  const prepareBtn = !isPreview ? (() => {
    const isPreparing = state.preparePanel?.recipeId === id;
    if (isPreparing) {
      const p = state.preparePanel;
      return `
        <div style="margin-top:10px;padding:12px;background:rgba(239,159,39,.08);border:1px solid rgba(239,159,39,.3);border-radius:12px">
          <div style="font-size:13px;font-weight:600;color:var(--orange);margin-bottom:6px">Prepare (meal prep)</div>
          <div style="font-size:12px;color:var(--text2);margin-bottom:10px">Pantry deducted now. Log portions day-by-day without touching pantry again.</div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text2)">Portions:</span>
            <button onclick="setPreparePortions(${p.portions - 1})"
              style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
            <span style="font-size:18px;font-weight:700;min-width:28px;text-align:center">${p.portions}</span>
            <button onclick="setPreparePortions(${p.portions + 1})"
              style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="closePreparePanel()" class="btn btn-gray" style="flex:1">Cancel</button>
            <button onclick="confirmPrepare()"
              style="flex:2;padding:8px;border-radius:10px;border:1px solid var(--orange);background:rgba(239,159,39,.15);color:var(--orange);font-size:13px;font-weight:600;cursor:pointer">
              Prepare ${p.portions} portion${p.portions !== 1 ? 's' : ''} — deduct pantry
            </button>
          </div>
        </div>`;
    }
    return `<button onclick="openPreparePanel('${id}')" class="btn btn-gray btn-full" style="margin-top:10px">Prepare (meal prep)</button>`;
  })() : '';

  const remixSection = !isPreview ? `
    <div style="margin-top:10px;display:flex;gap:8px">
      <input class="input" placeholder="Remix direction — 'spicier', 'Asian twist', 'lighter'..." style="flex:1"
        oninput="state.recipeRemixDirection=this.value" value="${state.recipeRemixDirection}"/>
      <button onclick="remixRecipe('${id}')" class="btn btn-gray" style="flex-shrink:0" ${state.recipeRemixing?'disabled':''}>
        ${state.recipeRemixing ? '...' : '↺ Remix'}
      </button>
    </div>` : '';

  const deleteBtn = !isPreview
    ? `<button onclick="if(confirm('Delete this recipe?'))deleteRecipe('${id}')" class="btn btn-red" style="margin-top:8px;width:100%">Delete recipe</button>` : '';

  const notes = !isPreview
    ? `<div style="margin-top:10px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">Notes</div>
        <textarea class="input" placeholder="Add notes…" rows="3"
          style="width:100%;box-sizing:border-box;font-style:italic;resize:vertical;font-size:12px"
          oninput="state._recipeDraftNotes=this.value"
          onblur="saveRecipeNotes('${id}')">${esc(recipe.notes || '')}</textarea>
      </div>`
    : (recipe.notes ? `<div style="margin-top:10px;font-size:12px;color:var(--text3);line-height:1.5;font-style:italic">${esc(recipe.notes)}</div>` : '');

  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <button onclick="closeRecipeView()" style="background:none;border:none;color:var(--text3);font-size:22px;cursor:pointer;padding:0;line-height:1">←</button>
      <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">${mealTag}${cuisineTag}${timeTag}</div>
    </div>
    <div style="font-size:18px;font-weight:700;margin-bottom:12px">${esc(recipe.name)}</div>
    ${renderRecipeMacroBar(adjustedPerServing, scale, recipe.servings, _partialVerified)}
    ${nutritionConfidence}
    ${renderPortionGauge(recipe)}
    ${!isPreview ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span style="font-size:11px;color:var(--text3)">Rating</span>
      <div style="display:flex;gap:2px">
        ${[1,2,3,4,5].map(n => `<button onclick="rateRecipe('${id}',${n})" style="background:none;border:none;cursor:pointer;font-size:22px;padding:0;line-height:1;color:${(recipe.rating||0)>=n?'#EF9F27':'var(--border)'}">★</button>`).join('')}
      </div>
      ${recipe.rating ? `<button onclick="rateRecipe('${id}',${recipe.rating})" style="background:none;border:none;font-size:11px;color:var(--text3);cursor:pointer;padding:0">Clear</button>` : ''}
    </div>` : ''}
    ${hasOverrides ? `<div style="font-size:10px;color:var(--text3);margin-bottom:4px">* Nutrition shown reflects original amounts</div>` : ''}
    ${servingCtrl}
    <div class="card-title">Ingredients</div>
    <div style="margin-bottom:16px">${ingredients}</div>
    ${kidPlate}
    <div class="card-title" style="margin-top:14px">Steps</div>
    <div style="margin-bottom:10px">${steps}</div>
    ${notes}
    ${saveBtn}${cartBtn}${prepareBtn}${remixSection}${deleteBtn}`;
}

function renderRecipeCard(recipe) {
  const cuisineColors = { Mexican:'#EF9F27', Asian:'#E24B4A', American:'#378ADD', Italian:'#1D9E75' };
  const cc = cuisineColors[recipe.cuisine] || 'var(--text3)';
  const timeLabel = recipe.weekendOnly ? 'Weekend' : `${recipe.cookTime} min`;
  const timeColor = recipe.weekendOnly ? '#7F77DD' : 'var(--green)';
  const inPlan = state.weeklyPlan.has(recipe.id);
  const p = recipe.perServing;
  return `
    <div data-rid="${recipe.id}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <button onclick="toggleWeeklyPlan('${recipe.id}')" style="flex-shrink:0;margin-top:2px;width:20px;height:20px;border-radius:5px;border:2px solid ${inPlan?'var(--green)':'var(--border)'};background:${inPlan?'rgba(29,158,117,.2)':'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center">
        ${inPlan?'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1D9E75" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>':''}
      </button>
      <div style="flex:1;cursor:pointer" onclick="viewRecipe('${recipe.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
          <div style="font-size:13px;font-weight:600">${esc(recipe.name)}</div>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${cc}22;color:${cc}">${esc(recipe.cuisine)}</span>
            <span style="font-size:10px;padding:1px 6px;border-radius:8px;color:${timeColor};background:${timeColor}22">${timeLabel}</span>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${p.kcal} kcal · ${p.protein}g P · ${p.carbs}g C · ${p.fat}g F per serving</div>
        <div style="margin-top:2px">${renderPortionGauge(recipe, true)}</div>
        <div style="display:flex;gap:1px;margin-top:4px">
          ${[1,2,3,4,5].map(n=>`<button onclick="event.stopPropagation();rateRecipe('${recipe.id}',${n})" style="background:none;border:none;cursor:pointer;font-size:16px;padding:0;line-height:1;color:${(recipe.rating||0)>=n?'#EF9F27':'var(--border)'}">★</button>`).join('')}
        </div>
      </div>
    </div>`;
}

// Cart review panel rendered inside grocery tab
function renderCartReview() {
  if (state.cartPushResults) {
    const r = state.cartPushResults;
    return `<div class="card" style="border-color:${r.summary?.failed===0?'var(--green)':'var(--orange)'}">
      <div class="card-title">Cart push — ${r.summary?.added??0}/${r.summary?.total??0} added</div>
      ${(r.results||[]).map(item=>`<div class="push-result">
        <div><div style="font-size:13px">${esc(item.item)}</div>${item.productName?`<div style="font-size:11px;color:var(--text3)">→ ${esc(item.productName)}</div>`:''}</div>
        <span class="pill" style="background:${item.status==='added'?'rgba(29,158,117,.2)':'rgba(226,75,74,.15)'};color:${item.status==='added'?'var(--green)':'var(--danger)'}">
          ${item.status==='added'?'Added':'Failed'}
        </span>
      </div>`).join('')}
      <button class="btn btn-gray btn-full" style="margin-top:10px" onclick="clearCartReview()">Clear</button>
    </div>`;
  }

  if (state.cartSearchLoading) {
    return `<div class="card" style="text-align:center;padding:24px">
      <div style="font-size:13px;color:var(--text2)">Searching City Market...</div>
    </div>`;
  }

  if (!state.cartSearchResults) return '';

  const rows = state.cartSearchResults.map(r => {
    if (r.status === 'not_found' || r.status === 'error') {
      const safeItem = r.item.replace(/'/g, "\\'");
      const reTerm = state.cartReSearchTerms[r.item] || '';
      const reSearching = !!state.cartReSearching[r.item];
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:12px;font-weight:500;color:var(--text)">${esc(r.item)}</div>
        <div style="font-size:11px;color:var(--danger);margin-top:2px">Not found — try a different search term</div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <input class="input" placeholder="e.g. lime, chicken breast..." style="flex:1;font-size:12px;padding:5px 8px"
            value="${esc(reTerm || r.item)}"
            oninput="state.cartReSearchTerms['${safeItem}']=this.value"/>
          <button onclick="reSearchItem('${safeItem}', state.cartReSearchTerms['${safeItem}'] || '${safeItem}')"
            style="padding:4px 12px;font-size:12px;border-radius:8px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;white-space:nowrap;flex-shrink:0"
            ${reSearching ? 'disabled' : ''}>
            ${reSearching ? '...' : 'Search'}
          </button>
        </div>
      </div>`;
    }
    const safeItem = r.item.replace(/'/g, "\\'");
    const selectedIdx = state.cartConfirmed[r.item] ?? 0;
    const skipped = state.cartConfirmed[r.item] === 'skip';
    const qty = state.cartQuantities[r.item] || 1;
    const reOpen = !!state.cartReSearchOpen[r.item];
    const reTerm = state.cartReSearchTerms[r.item] || '';
    const reSearching = !!state.cartReSearching[r.item];
    const nutKey = `${r.item}::${selectedIdx}`;
    const nutData = state.cartNutrition[nutKey];
    const nutLoading = !!state.cartNutritionLoading[nutKey];
    const meta = state.cartItemMeta[r.item];
    const isChosen = !!(meta?.chosenUpc && r.products[selectedIdx]?.upc === meta.chosenUpc);
    const chosenBadge = isChosen
      ? `<span style="font-size:10px;padding:1px 7px;border-radius:8px;background:rgba(29,158,117,.15);color:var(--green);flex-shrink:0">✓ Your match</span>` : '';
    // Package coverage: how much of the selected package(s) the recipes actually need
    const coverage = (() => {
      if (skipped || !meta?.fraction) return '';
      const f = meta.fraction;
      const needed = `${meta.amount % 1 === 0 ? meta.amount : (+meta.amount).toFixed(2)} ${meta.unit || ''}`.trim();
      const txt = f <= 1.02
        ? `needs ${needed} ≈ ${Math.max(1, Math.round(f * 100))}% of one package`
        : `needs ${needed} ≈ ${f.toFixed(1)} packages — suggested qty ${Math.min(20, Math.max(1, Math.ceil(f - 0.02)))}`;
      return `<div style="font-size:10px;color:var(--text3);margin-top:4px">${txt}</div>`;
    })();
    const productOpts = r.products.map((p, i) =>
      `<option value="${i}" ${selectedIdx===i?'selected':''}>${esc(p.name)}${p.size?' · '+esc(p.size):''}${p.price?' · $'+p.price:''}</option>`
    ).join('');
    return `<div style="padding:10px 0;border-bottom:1px solid var(--border);opacity:${skipped?0.4:1}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
        <div style="font-size:12px;font-weight:500;color:var(--text);flex:1">${esc(r.item)}</div>
        ${chosenBadge}
        <button onclick="state.cartConfirmed['${safeItem}']=state.cartConfirmed['${safeItem}']==='skip'?0:'skip';render()"
          style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid ${skipped?'var(--green)':'var(--border)'};background:${skipped?'rgba(29,158,117,.15)':'var(--bg3)'};color:${skipped?'var(--green)':'var(--text3)'};cursor:pointer;flex-shrink:0">
          ${skipped?'Undo skip':'Skip'}
        </button>
      </div>
      ${!skipped?`
        <select onchange="state.cartConfirmed['${safeItem}']=parseInt(this.value);fsLookupCartItemByIdx('${safeItem}',parseInt(this.value));_suggestCartQty('${safeItem}');render()"
          style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:6px 8px;font-size:12px;font-family:inherit;margin-bottom:8px">
          ${productOpts}
        </select>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11px;color:var(--text3)">Qty:</span>
            <button onclick="state.cartQuantities['${safeItem}']=Math.max(1,(state.cartQuantities['${safeItem}']||1)-1);render()"
              style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
            <span style="font-size:14px;font-weight:600;min-width:18px;text-align:center">${qty}</span>
            <button onclick="state.cartQuantities['${safeItem}']=Math.min(20,(state.cartQuantities['${safeItem}']||1)+1);render()"
              style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
          </div>
          <button onclick="state.cartReSearchOpen['${safeItem}']=!state.cartReSearchOpen['${safeItem}'];render()"
            style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid ${reOpen?'var(--blue)':'var(--border)'};background:${reOpen?'rgba(55,138,221,.15)':'var(--bg3)'};color:${reOpen?'var(--blue)':'var(--text3)'};cursor:pointer">
            ↺ Search instead
          </button>
        </div>
        ${coverage}
        ${nutLoading ? `<div style="font-size:11px;color:var(--text3);margin-top:6px;padding:4px 0">Looking up nutrition...</div>` : ''}
        ${nutData?.servings?.[0] ? renderFoodNutritionPanel(nutData.servings[0].nutrition, 1, _servingLabel(nutData.servings[0])) : ''}
        ${!nutData && !nutLoading ? (() => {
          const safeNutKey = nutKey.replace(/'/g, "\\'");
          const nutQuery = (state.cartNutritionQuery || {})[nutKey] || '';
          const nutResults = (state.cartNutritionResults || {})[nutKey] || [];
          const nutSearching = !!((state.cartNutritionSearching || {})[nutKey]);
          const productName = r.products[selectedIdx]?.name || '';
          const safeDefault = _cleanProductName(productName).replace(/'/g, "\\'");
          return `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
            <div style="font-size:11px;color:var(--text3);margin-bottom:6px">No nutrition match — search manually:</div>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <input class="input" placeholder="${productName}" style="flex:1;font-size:12px;padding:5px 8px"
                value="${nutQuery}"
                oninput="if(!state.cartNutritionQuery)state.cartNutritionQuery={};state.cartNutritionQuery['${safeNutKey}']=this.value"
                onkeydown="if(event.key==='Enter')searchCartNutrition('${safeItem}',${selectedIdx},(state.cartNutritionQuery||{})['${safeNutKey}']||'${safeDefault}')"/>
              <button onclick="searchCartNutrition('${safeItem}',${selectedIdx},(state.cartNutritionQuery||{})['${safeNutKey}']||'${safeDefault}')"
                style="padding:4px 12px;font-size:12px;border-radius:8px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;white-space:nowrap;flex-shrink:0"
                ${nutSearching ? 'disabled' : ''}>${nutSearching ? '...' : 'Search'}</button>
            </div>
            ${nutResults.length ? `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
              ${nutResults.slice(0, 6).map(f => `
                <div onclick="selectCartNutritionFood('${safeItem}',${selectedIdx},'${f.id}')"
                  style="padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px">
                  <div style="font-weight:600">${esc(f.name)}${f.brand ? ` <span style="font-weight:400;color:var(--text3)">(${esc(f.brand)})</span>` : ''}</div>
                  <div style="font-size:10px;color:var(--text3);margin-top:1px">${esc(f.description || '')}</div>
                </div>`).join('')}
            </div>` : ''}
          </div>`;
        })() : ''}
        ${reOpen?`<div style="display:flex;gap:6px;margin-top:6px">
          <input class="input" placeholder="e.g. lime, chicken breast..." style="flex:1;font-size:12px;padding:5px 8px"
            value="${esc(reTerm || r.item)}"
            oninput="state.cartReSearchTerms['${safeItem}']=this.value"/>
          <button onclick="reSearchItem('${safeItem}', state.cartReSearchTerms['${safeItem}'] || '${safeItem}')"
            style="padding:4px 12px;font-size:12px;border-radius:8px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;white-space:nowrap;flex-shrink:0"
            ${reSearching?'disabled':''}>
            ${reSearching?'...':'Search'}
          </button>
        </div>`:''}
      `:''}
    </div>`;
  }).join('');

  const readyCount = state.cartSearchResults.filter(r => r.status==='found' && state.cartConfirmed[r.item]!=='skip').length;

  return `<div class="card" style="border-color:var(--blue)">
    <div class="card-title" style="color:var(--blue)">Review City Market matches</div>
    <div style="font-size:12px;color:var(--text3);margin-bottom:12px">Confirm or swap each item before adding to your cart.</div>
    ${rows}
    <div style="display:flex;gap:8px;margin-top:14px">
      <button onclick="clearCartReview()" class="btn btn-gray" style="flex:1">Cancel</button>
      <button onclick="confirmCartPush()" class="btn btn-green" style="flex:2" ${state.cartPushLoading||!readyCount?'disabled':''}>
        ${state.cartPushLoading?'Adding to cart...':'Add '+readyCount+' item'+(readyCount!==1?'s':'')+' to cart'}
      </button>
    </div>
  </div>`;
}
