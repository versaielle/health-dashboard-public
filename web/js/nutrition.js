// ── UNIT CONVERSION (for computing actual macros from purchased pantry ingredients) ──

const _WEIGHT_G = { g:1, gram:1, grams:1, oz:28.3495, ounce:28.3495, ounces:28.3495, lb:453.592, lbs:453.592, pound:453.592, pounds:453.592, kg:1000 };
const _VOL_ML   = { ml:1, tsp:4.929, teaspoon:4.929, teaspoons:4.929, tbsp:14.787, tablespoon:14.787, tablespoons:14.787, cup:236.588, cups:236.588,
                    floz:29.574, pint:473.18, pints:473.18, pt:473.18, quart:946.35, quarts:946.35, qt:946.35, liter:1000, liters:1000, l:1000 };

// Parse "1", "1.5", "1/2", "2/3", "1 1/4" → number. FatSecret serving descriptions use
// fractions constantly ("1/2 cup", "1 1/4 cups") — treating them as whole numbers was the
// single biggest source of scaling failures.
function _parseNum(str) {
  const s = String(str).trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (m) return parseInt(m[1]) + parseInt(m[2]) / parseInt(m[3]);
  m = s.match(/^(\d+)\/(\d+)/);
  if (m) return parseInt(m[1]) / parseInt(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
// Number token (incl. fractions/mixed numbers) for serving-description regexes.
const _NUM_TOKEN = '\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?';

// Lowercase + collapse two-word units the parsers would otherwise split ("8 fl oz" → "8 floz").
function _normalizeDesc(description) {
  return String(description || '').toLowerCase()
    .replace(/\bfl\.?\s*oz\b/g, 'floz')
    .replace(/\bfluid\s+ounces?\b/g, 'floz');
}

// Approximate ingredient densities (grams per milliliter) so a volume amount (tsp/tbsp/cup) can
// be reconciled with a weight-based FatSecret serving — and vice versa. Values are typical
// prepared/chopped densities; they only need to be close enough for macro scaling. First match
// in array order wins, so specific patterns are listed before general ones.
const _DENSITY_G_PER_ML = [
  // Liquids & semi-liquids
  [/\b(peanut|almond|cashew|sunflower|nut)\s*butter\b/, 1.08],   // before generic "butter"
  [/\b(honey|molasses)\b/,                              1.42],
  [/\b(maple\s*syrup|syrup|agave)\b/,                   1.33],
  [/\b(soy\s*sauce|fish\s*sauce|tamari|worcestershire)\b/, 1.15],
  [/\bvinegar\b/,                                       1.01],
  [/\b(water|broth|stock|wine|juice|milk|buttermilk)\b/,1.0],
  [/\b(cream|half.and.half|sour\s*cream|yogurt|kefir)\b/,1.0],
  [/\b(ketchup|bbq\s*sauce|tomato\s*sauce|marinara|salsa|sauce|paste)\b/, 1.1],
  [/\bbutter\b/,                                        0.96],
  [/\b(oil|ghee)\b/,                                    0.92],
  [/\b(mayo|mayonnaise)\b/,                             0.91],
  // Dry pantry
  [/\b(brown\s*sugar)\b/,                               0.90],
  [/\b(powdered\s*sugar|confectioners)\b/,              0.56],
  [/\bsugar\b/,                                         0.85],
  [/\bsalt\b/,                                          1.20],
  [/\b(all.purpose\s*flour|flour)\b/,                   0.53],
  [/\b(rice|quinoa|couscous|lentils?|barley|oats?|oatmeal)\b/, 0.80],
  [/\b(corn\s*starch|cornstarch|cocoa|baking\s*soda|baking\s*powder)\b/, 0.55],
  [/\b(breadcrumbs|panko)\b/,                           0.40],
  [/\b(almonds?|walnuts?|pecans?|cashews?|pistachios?|peanuts?|macadamias?|hazelnuts?)\b/, 0.58], // chopped/whole nuts
  [/\b(chia|flax|sunflower|pumpkin|sesame)\s*seeds?\b/, 0.65],
  [/\bcheese\b/,                                        0.45],
  // Produce (chopped/diced typical)
  [/\b(garlic|ginger)\b/,                               0.85],
  [/\b(onion|shallot|leek)\b/,                          0.68],
  [/\btomato\b/,                                        0.67],
  [/\b(bell\s*pepper|pepper|jalape|poblano|serrano|anaheim|fresno)\b/, 0.62],
  [/\bcarrot\b/,                                        0.64],
  [/\bcelery\b/,                                        0.42],
  [/\bmushroom\b/,                                      0.45],
  [/\b(zucchini|squash|cucumber|eggplant)\b/,           0.55],
  [/\b(broccoli|cauliflower|asparagus)\b/,              0.40],
  [/\b(cabbage|lettuce|kale|arugula|spinach)\b/,        0.30],
  [/\b(cilantro|parsley|basil|mint|herb|dill|thyme|rosemary)\b/, 0.15],
  [/\b(black|white|kidney|pinto|cannellini|navy|garbanzo|refried)\s+beans?\b|\bchickpeas?\b/, 1.04], // canned/drained
  [/\b(corn|peas|beans?)\b/,                            0.62],
  [/\b(potato|yam)\b/,                                  0.70],
  [/\bavocado\b/,                                       0.96],
  [/\b(scallion|green\s*onion)\b/,                      0.45],
  [/\b(blueberr|raspberr|strawberr|blackberr|berr)\w*/, 0.60],
  [/\bbanana\b/,                                        0.95],  // mashed
  [/\bolives?\b/,                                       0.58],
  [/\bartichokes?\b/,                                   0.60],
  [/\bgranola\b/,                                       0.42],
  [/\b(hash\s*browns?|tater)\b/,                        0.55],
];

// Typical per-piece weights (grams) for count↔measure bridging — used when a recipe counts
// items ("2 cloves", "4 pork chops") but the matched serving is measured, or vice versa
// ("2 oz prosciutto" vs a "2 slices" serving). Order matters: specific before generic.
const _ITEM_WEIGHT_G = [
  [/\bgarlic\b|\bcloves?\b/,                       5],
  [/\beggs?\b/,                                   50],
  [/\bchicken\s*breast/,                         170],
  [/\bchicken\s*thigh/,                           85],
  [/\bpork\s*chop/,                              140],
  [/\bpatt(?:y|ies)\b/,                           38],
  [/\bsausage\s*links?\b|\blinks?\b/,             25],
  [/\bbacon\b/,                                   12],  // per slice
  [/\bprosciutto\b/,                              14],  // per slice
  [/\b(deli|lunch)\s*meat\b|\broast\s*beef\b|\bham\b|\bsalami\b/, 14], // per slice
  [/\bavocados?\b/,                              136],
  [/\btomato(?:es)?\b/,                          123],
  [/\b(onions?|shallots?)\b/,                    110],
  [/\bbananas?\b/,                               118],
  [/\bapples?\b/,                                182],
  [/\blemons?\b/,                                 58],
  [/\blimes?\b/,                                  44],
  [/\b(jalape|serrano)\w*/,                       14],
  [/\bpeppers?\b/,                               120],  // bell/roasted red, per whole
  [/\bpotato(?:es)?\b/,                          213],
  [/\bcarrots?\b/,                                61],
  [/\bcelery\b/,                                  40],  // per stick
  [/\bolives?\b/,                                  4],
  [/\bartichokes?\b/,                             20],  // per marinated piece
  [/\bstrawberr\w*/,                              12],  // per medium berry
  [/\b(basil|mint|sage)\b|\blea(?:f|ves)\b/,     0.5],  // per leaf
  [/\btortillas?\b|\bwraps?\b/,                   45],
  [/\bmuffins?\b/,                                57],  // english muffin
  [/\b(bread|toast|ciabatta|baguette|sourdough|buns?|rolls?)\b/, 32], // per slice/roll
  [/\b(cheese|provolone|cheddar|swiss|mozzarella|american|pepper\s*jack)\b/, 26], // per slice
  [/\btuna\b/,                                   142],  // per drained 5-oz can
  [/\bcans?\b|\bcanned\b/,                       425],  // generic 15-oz can
  [/\bcontainers?\b/,                            170],  // single-serve container (yogurt etc.)
];
function _itemGrams(text) {
  const t = String(text || '').toLowerCase();
  for (const [re, g] of _ITEM_WEIGHT_G) if (re.test(t)) return g;
  return null;
}

function _ingredientDensity(name) {
  const n = (name || '').toLowerCase();
  for (const [re, d] of _DENSITY_G_PER_ML) if (re.test(n)) return d;
  // Retry with plurals singularized ("potatoes" → "potato", "carrots" → "carrot")
  const singular = n.replace(/oes\b/g, 'o').replace(/([a-z])s\b/g, '$1');
  if (singular !== n) for (const [re, d] of _DENSITY_G_PER_ML) if (re.test(singular)) return d;
  return null;
}

// Convert an amount in a weight or volume unit to grams. Volume needs a density (g/ml).
function _toGrams(amount, unit, density) {
  const u = (unit || '').toLowerCase().trim();
  if (u in _WEIGHT_G) return amount * _WEIGHT_G[u];
  if (u in _VOL_ML && density) return amount * _VOL_ML[u] * density;
  return null;
}

// Parse a FatSecret serving.description string into {amount, unit}.
// Prefers grams/ml/oz in parenthesis when available: "1 breast (172g)" → {172, g}.
// Fraction-aware: "1/2 cup" → {0.5, cup}, "1 1/4 cups" → {1.25, cups}.
function _parseServing(description) {
  if (!description) return null;
  const desc = _normalizeDesc(description);
  // Prefer (Xg) / (X ml) / (X oz) inside parentheses
  const paren = desc.match(/\((\d+(?:\.\d+)?)\s*(g|ml|oz)\)/);
  if (paren) return { amount: parseFloat(paren[1]), unit: paren[2] };
  // Strip parentheticals before parsing the lead number
  const stripped = desc.replace(/\(.*?\)/g, '').trim();
  const m = stripped.match(new RegExp(`^(${_NUM_TOKEN})\\s*([a-z]+)?`));
  if (!m) return null;
  const amount = _parseNum(m[1]);
  if (!amount) return null;
  const unit = (m[2] || '').replace(/\.$/, '');
  if (unit in _WEIGHT_G || unit in _VOL_ML) return { amount, unit };
  // Treat unitless ("1 serving", "1 piece", "1 breast") as count
  return { amount, unit: 'count' };
}

// Given recipe ingredient amount/unit and FatSecret serving amount/unit, return
// how many of that serving the recipe ingredient represents. null if incompatible.
function _nutritionRatio(recipeAmt, recipeUnit, servingAmt, servingUnit, density = null) {
  if (!recipeAmt || !servingAmt) return null;
  const rU = (recipeUnit || '').toLowerCase().trim();
  const sU = (servingUnit || '').toLowerCase().trim();
  // Weight → weight
  if (rU in _WEIGHT_G && sU in _WEIGHT_G) {
    return (recipeAmt * _WEIGHT_G[rU]) / (servingAmt * _WEIGHT_G[sU]);
  }
  // Volume → volume
  if (rU in _VOL_ML && sU in _VOL_ML) {
    return (recipeAmt * _VOL_ML[rU]) / (servingAmt * _VOL_ML[sU]);
  }
  // Cross-system (volume ↔ weight) via ingredient density — both sides converted to grams.
  if (density) {
    const recipeGrams  = _toGrams(recipeAmt, rU, density);
    const servingGrams = _toGrams(servingAmt, sU, density);
    if (recipeGrams && servingGrams) return recipeGrams / servingGrams;
  }
  // Count → count (recipe unitless or "count/piece/each" against count serving)
  const recipeIsCount = !rU || /^(count|piece|pieces|each|whole)$/.test(rU);
  if (recipeIsCount && sU === 'count') {
    return recipeAmt / servingAmt;
  }
  return null;
}

// Gram-equivalent of one serving: prefer FatSecret's exact metric_serving_amount (carried by
// the proxy as metricAmount/metricUnit), fall back to parsing the description text.
function _servingGramsOf(s) {
  if (s.metricAmount && s.metricUnit) {
    const u = String(s.metricUnit).toLowerCase();
    if (u === 'g')  return s.metricAmount;
    if (u === 'oz') return s.metricAmount * 28.3495;
    if (u === 'ml') return s.metricAmount; // ≈1 g/ml; close enough for foods FatSecret reports in ml
  }
  const parsed = _parseServing(s.description);
  return parsed && (parsed.unit in _WEIGHT_G) ? parsed.amount * _WEIGHT_G[parsed.unit] : null;
}

// Serving label with its real size made visible: "1 serving" → "1 serving (113 g / 4.0 oz)".
// Skips the suffix when the description already states a measure ("100 g", "1/2 cup",
// "1 slice (28g)"). Uses FatSecret's exact metric weight when available.
function _servingLabel(s) {
  const desc = s.description || '1 serving';
  if (/\(\s*[\d.\/\s]+\s*(g|ml|oz)\s*\)/i.test(desc)) return desc;
  const parsed = _parseServing(desc);
  if (parsed && parsed.unit !== 'count') return desc; // already a weight/volume measure
  if (s.metricAmount && String(s.metricUnit).toLowerCase() === 'ml')
    return `${desc} (${Math.round(s.metricAmount)} ml)`;
  const g = _servingGramsOf(s);
  if (g) return `${desc} (${Math.round(g)} g / ${(g / 28.3495).toFixed(1)} oz)`;
  return desc;
}

// Build a compact per-serving fsFood object (stored on a recipe ingredient) from one serving.
function _fsFoodFromServing(food, s) {
  const n = s.nutrition || {};
  return {
    id: String(food.id ?? ''),
    name: food.name ?? '',
    servingDescription: s.description ?? '',
    servingGrams: _servingGramsOf(s),
    kcal:         n.kcal         ?? 0,
    protein:      n.protein      ?? 0,
    carbs:        n.carbs        ?? 0,
    fat:          n.fat          ?? 0,
    fiber:        n.fiber        ?? 0,
    sugar:        n.sugar        ?? 0,
    saturatedFat: n.saturatedFat ?? 0,
    polyunsatFat: n.polyunsatFat ?? 0,
    cholesterol:  n.cholesterol  ?? 0,
    sodium:       n.sodium       ?? 0,
    potassium:    n.potassium    ?? 0,
  };
}

// Build a compact fsFood from a full FatSecret food object. When the recipe ingredient is
// given, pick the serving the scaler can actually reconcile with the recipe amount ("100 g"
// beats "1 container" for a "3 tbsp" ingredient); otherwise use the first serving.
function _fsFoodFromFood(food, ing) {
  const servings = food?.servings || [];
  if (!servings.length) return null;
  if (ing) {
    for (const s of servings) {
      const candidate = _fsFoodFromServing(food, s);
      if (_isUnitMismatch(ing, candidate)) continue;
      const ratio = _fsRecipeRatio(ing, candidate);
      if (ratio !== null) return candidate;
    }
  }
  return _fsFoodFromServing(food, servings[0]);
}

const _FS_NUTRIENTS = ['kcal','protein','carbs','fat','fiber','sugar','saturatedFat','polyunsatFat','cholesterol','sodium','potassium'];

// ── INGREDIENT SCALING CLASSIFICATION ──

// Size words that appear in the unit field but aren't measurements (e.g. "4 large eggs").
const _SIZE_DESCRIPTOR_RE = /^(x-?large|extra-?large|xl|large|lg|medium|med|small|sm|jumbo)$/i;
// Spice/seasoning words — used to detect a compound seasoning like "salt and black pepper".
const _SPICE_RE = /\b(salt|pepper|peppercorns?|cumin|paprika|oregano|chil[il]|cayenne|coriander|turmeric|cinnamon|thyme|rosemary|basil|sage|bay\s*lea(?:f|ves)|allspice|nutmeg|cardamom|cloves?|seasoning|spice|flakes?|powder|saffron)\b/i;
// Liquids where cup↔weight conversion via density is reliable (otherwise solids are flagged).
const _LIQUID_RE = /\b(water|broth|stock|milk|buttermilk|cream|half.and.half|juice|wine|beer|oil|ghee|vinegar|sauce|syrup|honey|molasses|agave|tamari|worcestershire|ketchup|mayo|mayonnaise|yogurt|kefir|extract|sour\s*cream)\b/i;

// Amount is non-numeric / "to taste" / "pinch" → negligible-macro seasoning (Fix 3).
function _isNonNumericAmount(ing) {
  const amt  = String(ing.amount ?? '');
  const unit = String(ing.unit ?? '');
  if (/(to\s*taste|as\s*needed|to\s*serve|pinch|dash|sprinkle|handful|garnish|optional)/i.test(`${amt} ${unit}`)) return true;
  return !isFinite(parseFloat(amt));
}

// "salt and black pepper" — two spice names joined by and/& → a single seasoning (Fix 5).
function _isCombinedSpice(name) {
  const parts = String(name || '').toLowerCase().split(/\s+and\s+|\s*&\s*/).map(p => p.trim()).filter(Boolean);
  return parts.length >= 2 && parts.every(p => _SPICE_RE.test(p));
}

// Zero-calorie ingredients (ice, water) — never worth a FatSecret match; auto-lookup has
// attached absurd foods to these ("ice cubes" → Ice Cream). Treated like seasonings:
// no scaling, no macro contribution, excluded from the verification score.
const _ZERO_CAL_RE = /^(ice|ices?\s*cubes?|crushed\s*ice|water|cold\s*water|warm\s*water|hot\s*water|boiling\s*water|sparkling\s*water|club\s*soda|black\s*coffee)$/i;

// True when an ingredient should be treated as a seasoning for scaling: spice by name, a compound
// seasoning, a non-numeric "to taste" amount, or a zero-calorie ingredient. Such ingredients skip
// FatSecret scaling and don't count toward the verification score (negligible macro contribution).
function _isSpiceForScaling(ing) {
  if (!ing) return false;
  if (_ZERO_CAL_RE.test(_baseIngredientName(String(ing.name || '')).trim())) return true;
  if (categorizeIngredient(ing.name) === 'spices') return true;
  if (_isCombinedSpice(ing.name)) return true;
  if (_isNonNumericAmount(ing)) return true;
  return false;
}

// ── FATSECRET MATCH RELEVANCE ──
// Auto-matching used to take the first search result with servings — which attached
// "Raw Vegetable" to honey. Every automatic match now requires name-token overlap.

const _NAME_STOPWORDS = new Set(['the','and','with','for','style','fresh','raw','natural','organic','plain','original','classic','premium','select','free','brand','pack','count']);

function _nameTokens(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z]+/)
    .filter(w => w.length >= 3 && !_NAME_STOPWORDS.has(w)));
}

// Contradictory variant modifiers ("whole milk" vs "fat free milk") — same food family,
// materially different macros.
const _VARIANT_GROUPS = [
  [/\bwhole\b|\bfull.?fat\b/, /\b(fat.?free|nonfat|non.?fat|skim|low.?fat|reduced.?fat|light|lite)\b/],
];
function _variantConflict(a, b) {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  for (const [g1, g2] of _VARIANT_GROUPS) {
    if ((g1.test(x) && g2.test(y)) || (g2.test(x) && g1.test(y))) return true;
  }
  return false;
}

// Cosine-ish token overlap between a query and a candidate food name. 0 = irrelevant (reject).
// Variant conflicts are heavily penalized so "Fat Free Milk" loses to "Whole Milk".
function _nameOverlapScore(query, candidateText) {
  const q = _nameTokens(query), c = _nameTokens(candidateText);
  if (!q.size || !c.size) return 0;
  let overlap = 0;
  for (const t of c) if (q.has(t)) overlap++;
  if (!overlap) return 0;
  let score = overlap / Math.sqrt(q.size * c.size);
  if (_variantConflict(query, candidateText)) score *= 0.2;
  return score;
}

// A stored fsFood that shares no name tokens with its ingredient/product — or contradicts its
// variant ("whole" vs "fat free") — is a bad auto-match and should be re-searched.
function _fsMatchSuspect(ing) {
  if (!ing?.fsFood) return false;
  const ref = `${ing.name || ''} ${ing.krogerName || ''}`;
  if (_nameOverlapScore(ref, ing.fsFood.name) === 0) return true;
  return _variantConflict(ref, ing.fsFood.name);
}

// Search FatSecret and return the most RELEVANT food with usable servings for `query`.
// Candidates are ranked by name overlap; irrelevant results are rejected outright. When
// `validate` is given, prefer the first candidate passing it; `allowUnvalidated` controls
// whether the best relevant-but-unvalidated food is an acceptable fallback.
async function _fsBestFood(query, { branded = false, validate = null, allowUnvalidated = true } = {}) {
  if (!query || !query.trim()) return null;
  let results = [];
  try {
    const res = await authFetch(`${BACKEND}/fatsecret/search?q=${encodeURIComponent(query.trim())}${branded ? '&branded=1' : ''}`);
    results = (await res.json()).results || [];
  } catch { return null; }
  const scored = results
    .map(c => ({ c, s: _nameOverlapScore(query, `${c.name} ${c.brand || ''}`) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
  let fallback = null;
  for (const { c } of scored.slice(0, 5)) {
    try {
      const r = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(c.id)}`);
      if (!r.ok) continue;
      const food = await r.json();
      if (!food?.servings?.length) continue;
      if (!validate || validate(food)) return food;
      if (!fallback) fallback = food;
    } catch {}
  }
  return allowUnvalidated ? fallback : null;
}

// Leading count of a FatSecret serving when it's a whole-item serving ("1 large (50g)" → 1,
// "2 cookies" → 2, "1/4 pepper" → 0.25). null when the textual unit is a weight/volume measure.
function _parseServingCount(description) {
  const stripped = _normalizeDesc(description).replace(/\(.*?\)/g, '').trim();
  const m = stripped.match(new RegExp(`^(${_NUM_TOKEN})\\s*([a-z]+)?`));
  if (!m) return null;
  const unit = (m[2] || '').replace(/\.$/, '');
  if (unit in _WEIGHT_G || unit in _VOL_ML) return null;
  return _parseNum(m[1]) || null;
}

// Textual unit of a FatSecret serving, ignoring the gram/ml parenthetical ("1 cup (240g)" → "cup").
function _servingTextUnit(description) {
  const stripped = _normalizeDesc(description).replace(/\(.*?\)/g, '').trim();
  const m = stripped.match(new RegExp(`^(?:${_NUM_TOKEN})\\s*([a-z]+)?`));
  return m ? (m[1] || '').replace(/\.$/, '') : '';
}

// Singularize a count noun for equivalence checks ("patties" → "patty", "slices" → "slice").
function _singularNoun(s) {
  return String(s || '').toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
}

// Multiplier from a FatSecret per-serving fsFood to the recipe ingredient's FULL-batch amount.
// Handles whole-item counts (incl. size descriptors), same-noun counts ("2 slices" vs "1 slice"),
// weight↔weight, volume↔volume, density cross-conversion, and count↔measure bridging via
// typical per-item weights. null when the units can't be reconciled.
function _fsRecipeRatio(ing, fs) {
  if (!fs) return null;
  const recipeAmt = parseFloat(ing.amount) || 0;
  if (!recipeAmt) return null;
  let recipeUnit = (ing.unit || '').toLowerCase().trim();
  if (_SIZE_DESCRIPTOR_RE.test(recipeUnit)) recipeUnit = ''; // Fix 1: size words aren't measurements

  const desc = fs.servingDescription || '';
  const servingCount = _parseServingCount(desc);
  const servingNoun  = _servingTextUnit(desc);
  const density = _ingredientDensity(ing.name);

  // Same-noun counts: "2 slices" recipe vs "1 slice" serving, "2 eggs" vs "1 egg",
  // "2 patties" vs "1 patty" — exact, no weights needed.
  if (recipeUnit && servingCount) {
    const rN = _singularNoun(recipeUnit), sN = _singularNoun(servingNoun);
    if (rN && rN === sN) return recipeAmt / servingCount;
  }

  // Whole-item scaling: recipe count / FatSecret serving count.
  const recipeIsCount = !recipeUnit || /^(count|piece|pieces|each|whole|clove|cloves)$/.test(recipeUnit);
  if (recipeIsCount && servingCount) return recipeAmt / servingCount;

  // Cooked-yield parenthetical: a "1/2 cup dry (1 cup cooked)" serving measured against a
  // recipe that calls for the COOKED amount — scale against the cooked volume.
  if (/\bcooked\b/i.test(ing.name) && (recipeUnit in _VOL_ML)) {
    const cooked = _normalizeDesc(desc).match(new RegExp(`\\((${_NUM_TOKEN})\\s*(cups?|tbsp|tablespoons?|tsp|teaspoons?)\\s*cooked\\)`));
    if (cooked) {
      const cookedAmt = _parseNum(cooked[1]);
      if (cookedAmt) {
        const r = _nutritionRatio(recipeAmt, recipeUnit, cookedAmt, cooked[2], density);
        if (r !== null && isFinite(r) && r > 0) return r;
      }
    }
  }

  // Direct weight/volume/density conversions.
  let ratio = null;
  const parsed = _parseServing(desc);
  if (parsed) ratio = _nutritionRatio(recipeAmt, recipeUnit, parsed.amount, parsed.unit, density);
  if ((ratio === null || !isFinite(ratio) || ratio <= 0) && fs.servingGrams) {
    const recipeGrams = _toGrams(recipeAmt, recipeUnit, density);
    if (recipeGrams) ratio = recipeGrams / fs.servingGrams;
  }
  if (ratio !== null && isFinite(ratio) && ratio > 0) return ratio;

  // Count ↔ measure bridging via typical per-item weights.
  const servingGrams = fs.servingGrams
    || (parsed && (parsed.unit in _WEIGHT_G) ? parsed.amount * _WEIGHT_G[parsed.unit] : null)
    || (parsed && (parsed.unit in _VOL_ML) && density ? parsed.amount * _VOL_ML[parsed.unit] * density : null);
  const recipeMeasured = (recipeUnit in _WEIGHT_G) || (recipeUnit in _VOL_ML);

  if (!recipeMeasured) {
    // "2 cloves" vs "1 tsp" serving · "4 pork chops" vs "4 oz" · "1 can beans" vs "1/2 cup"
    const g = _itemGrams(`${ing.name} ${ing.unit || ''}`);
    if (g && servingGrams) return (recipeAmt * g) / servingGrams;
  } else if (servingCount) {
    // "2 oz prosciutto" vs "2 slices" serving · "0.5 cup celery" vs "5 sticks"
    const g = _itemGrams(`${ing.name} ${servingNoun}`);
    const recipeGrams = _toGrams(recipeAmt, recipeUnit, density);
    if (g && recipeGrams) return recipeGrams / (servingCount * g);
  }
  return null;
}

// Volume recipe unit vs a weight-only FatSecret serving for a solid food with NO known
// density — cup↔weight would be a blind guess, so we neither scale nor error; the ingredient
// keeps its Haiku estimate. When the curated density table covers the food (cheese, herbs,
// onion, …) the cross-conversion is deliberate and allowed.
function _isUnitMismatch(ing, fs) {
  const rU = (ing.unit || '').toLowerCase().trim();
  if (!(rU in _VOL_ML)) return false;
  const sU = _servingTextUnit(fs.servingDescription);
  if (sU in _VOL_ML) return false;                  // serving is volume too → reliable
  const weightLike = (sU in _WEIGHT_G) || !!fs.servingGrams;
  if (!weightLike) return false;
  if (_ingredientDensity(ing.name)) return false;   // curated density → convertible
  return !_LIQUID_RE.test(String(ing.name || '').toLowerCase());
}

// Central classifier for one ingredient's fsFood scaling.
// status ∈ 'none' | 'spice' | 'unit_mismatch' | 'scaled' | 'error'.
function _fsScalingStatus(ing) {
  if (_isSpiceForScaling(ing)) return { status: 'spice' };
  const fs = ing.fsFood;
  if (!fs) return { status: 'none' };
  if (_isUnitMismatch(ing, fs)) return { status: 'unit_mismatch' };
  const ratio = _fsRecipeRatio(ing, fs);
  if (ratio !== null) {
    const scaled = {};
    for (const k of _FS_NUTRIENTS) scaled[k] = (fs[k] || 0) * ratio;
    return { status: 'scaled', scaled };
  }
  return { status: 'error' };
}

// Full-batch scaled nutrition for an ingredient, or null when it isn't cleanly scalable
// (spice / unit-mismatch / error / no fsFood). Used by macro math everywhere for consistency.
function _fsScaledPerRecipe(ing, fs) {
  const st = _fsScalingStatus(ing);
  return st.status === 'scaled' ? st.scaled : null;
}

// Bake the scaling result onto ing.fsFood as exactly one marker, so persisted recipes carry it and
// the one-time heal-on-view doesn't re-run. No-op without fsFood.
function _attachScaledPerRecipe(ing) {
  if (!ing || !ing.fsFood) return;
  const fs = ing.fsFood;
  delete fs.scaledPerRecipe; delete fs.scalingError; delete fs.scalingWarning; delete fs.scalingSkipped;
  const st = _fsScalingStatus(ing);
  if (st.status === 'scaled')             fs.scaledPerRecipe = st.scaled;
  else if (st.status === 'unit_mismatch') fs.scalingWarning  = 'unit_mismatch';
  else if (st.status === 'spice')         fs.scalingSkipped  = true;
  else if (st.status === 'error')         fs.scalingError    = true;
}

// Per-serving display info for one ingredient row. Returns null (no fsFood) or
// { status, ...per-serving nutrients when status === 'scaled' }.
function _fsIngredientPerServing(recipe, ing) {
  if (!ing.fsFood) return null;
  const st = _fsScalingStatus(ing);
  if (st.status !== 'scaled') return { status: st.status };
  const srv = recipe.servings || 1;
  const out = { status: 'scaled' };
  for (const k of _FS_NUTRIENTS) out[k] = (st.scaled[k] || 0) / srv;
  return out;
}

// Recompute recipe.perServing from per-ingredient fsFood (unit-scaled) blended with the original
// Haiku equal-weight estimate for unmatched ingredients. unit-mismatch & spice ingredients keep
// their Haiku contribution and are excluded from the verification score. Returns null when nothing
// is matched. Uses recipe.perServingOriginal as the Haiku baseline so repeated recalcs don't compound.
function recalcRecipePerServingFromFs(recipe) {
  const nonSpice = (recipe.ingredients || []).filter(i => !_isSpiceForScaling(i));
  if (!nonSpice.length) return null;
  const srv = recipe.servings || 1;
  const totals = {}; for (const k of _FS_NUTRIENTS) totals[k] = 0;
  let matched = 0, scoreTotal = 0, haikuFill = 0;
  for (const ing of nonSpice) {
    const st = _fsScalingStatus(ing);
    if (st.status === 'scaled') {
      for (const k of _FS_NUTRIENTS) totals[k] += st.scaled[k] || 0;
      matched++; scoreTotal++;
    } else if (st.status === 'unit_mismatch') {
      haikuFill++;                 // Haiku contribution, excluded from the score
    } else {
      haikuFill++; scoreTotal++;   // none/error: Haiku contribution, counts against the score
    }
  }
  if (matched === 0) return null;
  // Equal-weight Haiku fill-in for unmatched/mismatch ingredients (core macros only), full batch.
  const hk = recipe.perServingOriginal || recipe.perServing || { kcal:0, protein:0, carbs:0, fat:0 };
  const share = 1 / nonSpice.length;
  for (let i = 0; i < haikuFill; i++) {
    totals.kcal    += (hk.kcal    || 0) * srv * share;
    totals.protein += (hk.protein || 0) * srv * share;
    totals.carbs   += (hk.carbs   || 0) * srv * share;
    totals.fat     += (hk.fat     || 0) * srv * share;
  }
  const perServing = {
    kcal:    Math.round(totals.kcal / srv),
    protein: Math.round(totals.protein / srv * 10) / 10,
    carbs:   Math.round(totals.carbs   / srv * 10) / 10,
    fat:     Math.round(totals.fat     / srv * 10) / 10,
  };
  return { perServing, matched, total: scoreTotal, allMatched: scoreTotal > 0 && matched === scoreTotal };
}

// Compute total macros + extended nutrients for a recipe meal. Priority per ingredient:
//   1. ingredient.fsFood (real FatSecret data attached to the recipe ingredient — most accurate)
//   2. a matched pantry item's fsFood
//   3. equal-weight share of the Haiku perServing estimate (core macros only)
// Always returns a result (null only if the recipe has no non-spice ingredients). Extended
// nutrients are only populated for FatSecret-sourced ingredients.
function computeMacrosFromPantry(recipe, servings) {
  const factor = servings / recipe.servings;
  const mainIngs = (recipe.ingredients || []).filter(i => !_isSpiceForScaling(i));
  if (!mainIngs.length) return null;
  const totalCount = mainIngs.length;

  const totals = { kcal:0, protein:0, carbs:0, fat:0, fiber:0, sugar:0,
                   saturatedFat:0, polyunsatFat:0, cholesterol:0, sodium:0, potassium:0 };
  const unmatchedIngredients = [];
  let matchedCount = 0;
  let ingredientSourced = false;

  for (const ing of mainIngs) {
    // (1) Per-ingredient fsFood — real nutrition stored directly on the recipe ingredient.
    // Scaled to the full batch via the shared helper, then by `factor` for the requested servings
    // (same unit-aware math used by the recipe-detail display, so the numbers always agree).
    if (ing.fsFood) {
      const scaled = _fsScaledPerRecipe(ing, ing.fsFood);
      if (scaled) {
        for (const k of Object.keys(totals)) totals[k] += (scaled[k] || 0) * factor;
        matchedCount++;
        ingredientSourced = true;
        continue;
      }
    }

    const base = _baseIngredientName(ing.name).toLowerCase();
    const pantryItem = (state.pantry || []).find(p =>
      p.fsFood?.servings?.length && _pantryItemMatches(p, base));

    if (pantryItem) {
      let ingMatched = false;
      const recipeAmt = (parseFloat(ing.amount) || 0) * factor;
      const recipeUnit = (ing.unit || '').toLowerCase().trim();
      const density = _ingredientDensity(ing.name);
      for (const s of pantryItem.fsFood.servings) {
        const parsed = _parseServing(s.description);
        if (!parsed) continue;
        const ratio = _nutritionRatio(recipeAmt, recipeUnit, parsed.amount, parsed.unit, density);
        if (ratio === null || !isFinite(ratio) || ratio <= 0) continue;
        const n = s.nutrition || {};
        for (const k of Object.keys(totals)) totals[k] += (n[k] || 0) * ratio;
        ingMatched = true;
        matchedCount++;
        break;
      }
      if (!ingMatched) unmatchedIngredients.push(ing.name);
    } else {
      unmatchedIngredients.push(ing.name);
    }
  }

  // Equal-weight Haiku fill-in for unmatched ingredients (core macros only).
  const p = recipe.perServing;
  const share = 1 / totalCount;
  for (let i = 0; i < unmatchedIngredients.length; i++) {
    totals.kcal    += p.kcal    * servings * share;
    totals.protein += p.protein * servings * share;
    totals.carbs   += p.carbs   * servings * share;
    totals.fat     += p.fat     * servings * share;
  }

  const blended = unmatchedIngredients.length > 0;
  return { ...totals, blended, unmatchedIngredients, matchedCount, totalCount, ingredientSourced };
}

// ── PORTION SIZE ESTIMATE ──
// Physical size of ONE serving: sum each ingredient's mass (and approximate volume), divide by
// servings. Priority per ingredient: stated weight → stated volume × density → counted items ×
// per-item weight → matched fsFood serving grams × ratio. Seasonings are skipped (negligible
// mass); water/ice ARE counted — calorically zero but very much part of how big a portion is.
function _recipePortionEstimate(recipe) {
  const srv = recipe.servings || 1;
  let grams = 0, ml = 0, mlFromVol = 0, counted = 0, total = 0;
  for (const ing of recipe.ingredients || []) {
    const base = _baseIngredientName(String(ing.name || '')).trim();
    const zeroCal = _ZERO_CAL_RE.test(base);
    if (_isSpiceForScaling(ing) && !zeroCal) continue;
    total++;
    const amt = parseFloat(ing.amount) || 0;
    if (!amt) continue;
    let unit = (ing.unit || '').toLowerCase().trim();
    if (_SIZE_DESCRIPTOR_RE.test(unit)) unit = '';
    const density = zeroCal ? 0.95
      : (_ingredientDensity(ing.name) ?? (_LIQUID_RE.test(base) ? 1.0 : 0.7));
    let g = null;
    if (unit in _WEIGHT_G) g = amt * _WEIGHT_G[unit];
    else if (unit in _VOL_ML) g = amt * _VOL_ML[unit] * density;
    else {
      const per = _itemGrams(`${ing.name} ${ing.unit || ''}`);
      if (per) g = amt * per;
      else if (ing.fsFood?.servingGrams) {
        const ratio = _fsRecipeRatio(ing, ing.fsFood);
        if (ratio) g = ratio * ing.fsFood.servingGrams;
      }
    }
    if (!g || !isFinite(g) || g <= 0) continue;
    grams += g;
    const vol = unit in _VOL_ML ? amt * _VOL_ML[unit] : g / density;
    ml += vol;
    if (unit in _VOL_ML) mlFromVol += vol;
    counted++;
  }
  if (!counted) return null;
  return {
    gramsPerServing: grams / srv,
    mlPerServing: ml / srv,
    volShare: ml > 0 ? mlFromVol / ml : 0,   // how much of the dish was measured by volume
    coverage: counted / Math.max(1, total),  // fraction of main ingredients we could size
  };
}

// ── AUTO-ENRICH: background FatSecret lookup after logging a recipe meal ──

// Strip Kroger-specific suffixes and symbols from a product name before FatSecret search.
// "Kroger® 93/7 Ground Beef Tray 1 LB" → "Kroger 93/7 Ground Beef"
// "Mission Super Soft Yellow Corn Tortillas, 30 Count (1)" → "Mission Super Soft Yellow Corn Tortillas"
function _cleanProductName(name) {
  return name
    .replace(/[®™©]/g, '')
    .replace(/,?\s*\d+\s*(count|ct|pk|pack)\s*(\(\d+\))?/gi, '')
    .replace(/\s+\d+(\.\d+)?\s*(lb|lbs|oz|g)\s*(tray|bag|pack)?$/i, '')
    .replace(/\(\d+\)$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Strip prep words from an ingredient name so FatSecret finds the base food.
// "boneless skinless chicken breasts" → "chicken breast"
function _cleanIngredientForSearch(name) {
  return name
    .replace(/\(.*?\)/g, '')
    .replace(/\b(boneless|skinless|lean|fresh|frozen|dried|raw|cooked|whole|ground|sliced|diced|minced|chopped|shredded|grated|peeled|seeded|rinsed|drained|canned|low.sodium|low.fat|nonfat|organic|grass.fed|free.range)\b/gi, '')
    .replace(/\s+/g, ' ').trim()
    // Normalize plurals for common proteins
    .replace(/\bbreasts?\b/i, 'breast')
    .replace(/\bthighs?\b/i, 'thigh')
    .trim();
}

async function fsEnrichMeal(mealId, recipe, targetKcal) {
  try {
    let food = null;

    // Option A: recipe has saved FatSecret food IDs from a previous cart review — use those first
    if (recipe.ingredientFdcIds && Object.keys(recipe.ingredientFdcIds).length > 0) {
      // Prefer the protein ingredient's saved fdcId; fall back to any saved id
      const proteinIng = Array.isArray(recipe.ingredients)
        ? recipe.ingredients.find(i =>
            /\b(chicken|beef|turkey|pork|shrimp|fish|tuna|salmon|egg|tofu|tempeh|cod|tilapia|lamb|bison)\b/i.test(i.name)
          ) || recipe.ingredients[0]
        : null;
      const savedIds = proteinIng && recipe.ingredientFdcIds[proteinIng.name]
        ? [recipe.ingredientFdcIds[proteinIng.name], ...Object.values(recipe.ingredientFdcIds)]
        : Object.values(recipe.ingredientFdcIds);
      for (const fdcId of [...new Set(savedIds)].slice(0, 3)) {
        const r = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(fdcId)}`);
        if (!r.ok) continue;
        const d = await r.json();
        if (d?.servings?.[0]) { food = d; break; }
      }
    }

    // Fallback: fresh FatSecret search for the primary protein ingredient
    if (!food) {
      let results = [];
      if (Array.isArray(recipe.ingredients)) {
        const proteinIng = recipe.ingredients.find(i =>
          /\b(chicken|beef|turkey|pork|shrimp|fish|tuna|salmon|egg|tofu|tempeh|cod|tilapia|lamb|bison)\b/i.test(i.name)
        ) || recipe.ingredients[0];
        if (proteinIng) {
          const q = _cleanIngredientForSearch(proteinIng.name);
          const ingRes = await authFetch(`${BACKEND}/fatsecret/search?q=${encodeURIComponent(q)}`);
          const ingData = await ingRes.json();
          results = ingData.results || [];
        }
      }
      for (const candidate of results.slice(0, 3)) {
        const r = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(candidate.id)}`);
        if (!r.ok) continue;
        const d = await r.json();
        if (d?.servings?.[0]) { food = d; break; }
      }
    }
    if (!food) return;

    const meal = state.meals.find(m => m.id === mealId);
    if (!meal) return;

    const n = food.servings[0].nutrition;
    const scale = targetKcal / (n.kcal || targetKcal);
    meal.fiber        = Math.round(n.fiber        * scale * 10) / 10;
    meal.sugar        = Math.round(n.sugar        * scale * 10) / 10;
    meal.saturatedFat = Math.round(n.saturatedFat * scale * 10) / 10;
    meal.polyunsatFat = Math.round(n.polyunsatFat * scale * 10) / 10;
    meal.cholesterol  = Math.round(n.cholesterol  * scale);
    meal.sodium       = Math.round(n.sodium       * scale);
    meal.potassium    = Math.round(n.potassium    * scale);
    meal.fsId         = food.id;
    saveMealLog();
    render();
  } catch {}
}

// ── FOOD SEARCH (FatSecret via worker) ──

async function fsSearch(query) {
  if (!query.trim()) { state.fsResults = []; state.fsError = null; render(); return; }
  state.fsLoading = true; render();
  try {
    const res = await authFetch(`${BACKEND}/fatsecret/search?q=${encodeURIComponent(query.trim())}`);
    const data = await res.json();
    if (data._fs_error) {
      const e = data._fs_error;
      state.fsError = `FatSecret error ${e.code}: ${e.message}${e.code === 21 ? ' — IP whitelist pending.' : ''}`;
      state.fsResults = [];
    } else {
      state.fsError = null;
      state.fsResults = data.results || [];
    }
  } catch { state.fsResults = []; state.fsError = null; }
  state.fsLoading = false; render();
}

async function fsSelectFood(id) {
  state.fsFoodLoading = true; state.fsFood = null; render();
  try {
    const res = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    state.fsFood = data;
    if (!state.fsServingIdx[id]) state.fsServingIdx[id] = 0;
    if (!state.fsServingQty[id]) state.fsServingQty[id] = 1;
  } catch {}
  state.fsFoodLoading = false; render();
}

function fsClearSearch() {
  state.fsQuery = ''; state.fsResults = []; state.fsFood = null; render();
}

function fsSetServingIdx(id, idx) {
  state.fsServingIdx[id] = idx; render();
}

function fsSetServingQty(id, delta) {
  const cur = state.fsServingQty[id] || 1;
  state.fsServingQty[id] = Math.max(0.125, Math.round((cur + delta) * 8) / 8);
  render();
}

function fsLogFood(slot) {
  const food = state.fsFood;
  if (!food) return;
  const idx = state.fsServingIdx[food.id] ?? 0;
  const qty = state.fsServingQty[food.id] ?? 1;
  const serving = food.servings[idx];
  if (!serving) return;
  const n = serving.nutrition;
  const scale = qty;
  state.meals.push({
    name: food.name + (food.brand ? ` (${food.brand})` : '') + (qty !== 1 ? ` ×${qty}` : ''),
    kcal:         Math.round(n.kcal         * scale),
    protein:      roundMacro(n.protein      * scale),
    carbs:        roundMacro(n.carbs        * scale),
    fat:          roundMacro(n.fat          * scale),
    fiber:        Math.round(n.fiber        * scale * 10) / 10,
    sugar:        Math.round(n.sugar        * scale * 10) / 10,
    saturatedFat: Math.round(n.saturatedFat * scale * 10) / 10,
    polyunsatFat: Math.round(n.polyunsatFat * scale * 10) / 10,
    cholesterol:  Math.round(n.cholesterol  * scale),
    sodium:       Math.round(n.sodium       * scale),
    potassium:    Math.round(n.potassium    * scale),
    mealSlot: slot || state.logPanel?.slot || 'other',
    id: Date.now(),
    loggedAt: new Date().toISOString(),
    fsId: food.id,
  });
  save(); saveMealLog();
  state.fsFood = null; state.fsQuery = ''; state.fsResults = [];
  render();
}

function fsAddToPantry() {
  const food = state.fsFood;
  if (!food) return;
  const idx = state.fsServingIdx[food.id] ?? 0;
  const containers = state.fsServingQty[food.id] ?? 1;
  const perContainer = state.pantryFsContainerServings ?? 1;
  const serving = food.servings[idx];
  if (!serving) return;

  const displayName = food.name + (food.brand ? ` (${food.brand})` : '');
  const servingDesc = serving.description;

  // Unified pantry model: amount/remaining count CONTAINERS; portionsPerUnit holds the
  // servings-per-container toggle (same shape as cart-pushed items).
  const newItem = {
    id: crypto.randomUUID(),
    display: displayName,
    ingredientName: food.name.toLowerCase(),
    recipeAmount: 1,
    recipeUnit: servingDesc,
    amount: containers,
    unit: servingDesc,
    remaining: containers,
    quantity: containers,
    portionsPerUnit: perContainer,
    fsFood: food,
    krogerName: food.name,
    krogerSize: servingDesc,
    krogerUpc: '',
    purchasedAt: new Date().toISOString(),
    fromRecipes: [],
  };

  // Merge: bump remaining if same ingredient already in pantry
  const existing = state.pantry.find(p => p.ingredientName.toLowerCase() === newItem.ingredientName);
  let newPantry;
  if (existing) {
    newPantry = state.pantry.map(p =>
      p.ingredientName.toLowerCase() === newItem.ingredientName
        ? { ...p, remaining: Math.round((p.remaining + containers) * 100) / 100,
            amount: Math.round(((p.amount || 0) + containers) * 100) / 100,
            portionsPerUnit: perContainer, fsFood: food }
        : p
    );
  } else {
    newPantry = [...state.pantry, newItem];
  }

  state.pantry = newPantry;
  state.pantryAddOpen = false;
  state.pantryFsContainerServings = 1;
  state.fsFood = null;
  state.fsQuery = '';
  state.fsResults = [];
  save();
  render();
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: newPantry }),
  }).catch(() => {});
}

// ── CART NUTRITION LOOKUP ──
// Keyed by `${item}::${productIdx}` so switching products re-fetches correctly.

async function fsLookupCartProduct(item, idx, productName) {
  const nutKey = `${item}::${idx}`;
  if (state.cartNutrition[nutKey] || state.cartNutritionLoading[nutKey]) return;
  state.cartNutritionLoading = { ...state.cartNutritionLoading, [nutKey]: true };
  render();
  try {
    // Use branded=1 so actual purchased products (e.g. "Simple Truth Chicken Breast") are found.
    // Clean the name first to remove Kroger-specific symbols and trailing count/size info.
    // Relevance-ranked so an unrelated first hit can't get attached.
    const food = await _fsBestFood(_cleanProductName(productName), { branded: true });
    if (food) state.cartNutrition = { ...state.cartNutrition, [nutKey]: food };
  } catch {}
  state.cartNutritionLoading = { ...state.cartNutritionLoading, [nutKey]: false };
  render();
}

// Called when a product dropdown changes — looks up the new product if not already cached
function fsLookupCartItemByIdx(item, idx) {
  const result = (state.cartSearchResults || []).find(r => r.item === item);
  if (!result?.products?.[idx]) return;
  fsLookupCartProduct(item, idx, result.products[idx].name);
}

// Manual FatSecret search fallback when auto-lookup finds nothing
async function searchCartNutrition(item, idx, query) {
  const nutKey = `${item}::${idx}`;
  if (!query || !query.trim()) return;
  state.cartNutritionSearching = { ...state.cartNutritionSearching, [nutKey]: true };
  render();
  try {
    const res = await authFetch(`${BACKEND}/fatsecret/search?q=${encodeURIComponent(query.trim())}&branded=1`);
    const data = await res.json();
    state.cartNutritionResults = { ...state.cartNutritionResults, [nutKey]: data.results || [] };
  } catch {
    state.cartNutritionResults = { ...state.cartNutritionResults, [nutKey]: [] };
  }
  state.cartNutritionSearching = { ...state.cartNutritionSearching, [nutKey]: false };
  render();
}

// Called when user picks a result from the manual search
async function selectCartNutritionFood(item, idx, foodId) {
  const nutKey = `${item}::${idx}`;
  state.cartNutritionLoading = { ...state.cartNutritionLoading, [nutKey]: true };
  state.cartNutritionResults = { ...state.cartNutritionResults, [nutKey]: [] };
  render();
  try {
    const r = await authFetch(`${BACKEND}/fatsecret/food?id=${encodeURIComponent(foodId)}`);
    if (r.ok) {
      const food = await r.json();
      if (food?.servings?.[0]) state.cartNutrition = { ...state.cartNutrition, [nutKey]: food };
    }
  } catch {}
  state.cartNutritionLoading = { ...state.cartNutritionLoading, [nutKey]: false };
  render();
}

// ── NUTRITION DISPLAY HELPERS ──

// Sum a nutrition key across all logged meals (only those that have the field)
function dailyNutritionTotal(key) {
  return state.meals.reduce((sum, m) => sum + (m[key] || 0), 0);
}

// True if any logged meal has extended nutrition data
function hasExtendedNutrition() {
  return state.meals.some(m => m.fiber !== undefined);
}

// Render a single extended nutrient row: label | bar | value vs DV
function renderNutrientRow(key, value) {
  const dv = NUTRITION_DV[key];
  if (!dv) return '';
  const pct = Math.min(100, Math.round(value / dv.amount * 100));
  const over = value > dv.amount;
  const barColor = over ? 'var(--danger)' : '#378ADD';
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:12px;color:var(--text2);min-width:90px;flex-shrink:0">${dv.label}</div>
      <div style="flex:1;height:5px;background:var(--bg3);border-radius:3px">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width .3s"></div>
      </div>
      <div style="font-size:12px;font-weight:600;min-width:70px;text-align:right;color:${over?'var(--danger)':'var(--text)'}">
        ${value % 1 === 0 ? value : value.toFixed(1)}${dv.unit} <span style="font-weight:400;color:var(--text3)">/ ${dv.amount}${dv.unit}</span>
      </div>
    </div>`;
}

// Full expanded nutrition card (used in Macros daily summary)
function renderDailyNutritionCard() {
  if (!hasExtendedNutrition()) return '';
  const keys = ['fiber','sugar','saturatedFat','polyunsatFat','cholesterol','sodium','potassium'];
  const rows = keys.map(k => renderNutrientRow(k, Math.round(dailyNutritionTotal(k) * 10) / 10)).join('');
  return `
    <div class="card" style="margin-top:12px">
      <div class="card-title" style="margin-bottom:8px">Full Nutrition</div>
      ${rows}
      <div style="font-size:10px;color:var(--text3);margin-top:6px">Based on FatSecret data · FDA daily values</div>
    </div>`;
}

// Compact extended nutrient pills for a single meal entry
function renderMealNutritionPills(meal) {
  if (meal.fiber === undefined && meal.sodium === undefined) return '';
  const items = [
    meal.fiber     !== undefined ? `${meal.fiber}g fiber`           : null,
    meal.sugar     !== undefined ? `${meal.sugar}g sugar`           : null,
    meal.saturatedFat !== undefined ? `${meal.saturatedFat}g sat.fat` : null,
    meal.sodium    !== undefined ? `${meal.sodium}mg sodium`        : null,
    meal.potassium !== undefined ? `${meal.potassium}mg K`          : null,
  ].filter(Boolean);
  if (!items.length) return '';
  return `<div style="font-size:10px;color:var(--text3);margin-top:2px;line-height:1.6">${items.join(' · ')}</div>`;
}

// Compact nutrition panel for a FatSecret food (used in food detail view + cart review)
function renderFoodNutritionPanel(nutrition, qty = 1, servingDesc = null) {
  const n = nutrition;
  const s = v => (v * qty % 1 === 0 ? Math.round(v * qty) : (v * qty).toFixed(1));
  return `
    ${servingDesc ? `<div style="font-size:11px;color:var(--text3);margin-top:8px;margin-bottom:2px">Per serving: ${servingDesc}</div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:12px;${!servingDesc?'margin-top:8px;':''}padding:10px;background:var(--bg3);border-radius:10px">
      ${[
        ['Calories', s(n.kcal), ''],
        ['Protein',  s(n.protein), 'g'],
        ['Carbs',    s(n.carbs), 'g'],
        ['Fat',      s(n.fat), 'g'],
        ['Fiber',    s(n.fiber), 'g'],
        ['Sugar',    s(n.sugar), 'g'],
        ['Sat. Fat', s(n.saturatedFat), 'g'],
        ['Sodium',   s(n.sodium), 'mg'],
        ['Cholest.', s(n.cholesterol), 'mg'],
        ['Potassium',s(n.potassium), 'mg'],
      ].map(([l,v,u]) => `<div><span style="color:var(--text3)">${l}: </span><strong>${v}${u}</strong></div>`).join('')}
    </div>`;
}

// ── FATSECRET SEARCH UI (rendered inside log panel Search tab) ──

function renderFsSearchTab(slot, context = 'log') {
  // Food detail view
  if (state.fsFoodLoading) return `<div style="text-align:center;padding:24px;color:var(--text3)">Loading...</div>`;

  if (state.fsFood) {
    const food = state.fsFood;
    const idx = state.fsServingIdx[food.id] ?? 0;
    const qty = state.fsServingQty[food.id] ?? 1;
    const serving = food.servings[idx];
    const servingOpts = food.servings.map((s, i) =>
      `<option value="${i}" ${i === idx ? 'selected' : ''}>${esc(_servingLabel(s))}</option>`
    ).join('');
    return `
      <button onclick="state.fsFood=null;render()" style="background:none;border:none;color:var(--text3);font-size:13px;cursor:pointer;padding:0 0 8px">← Back to results</button>
      <div style="font-size:15px;font-weight:700;margin-bottom:2px">${esc(food.name)}</div>
      ${food.brand ? `<div style="font-size:11px;color:var(--text3);margin-bottom:10px">${esc(food.brand)}</div>` : ''}
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px">Serving size</label>
        <select onchange="fsSetServingIdx('${food.id}',+this.value)"
          style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:7px 10px;font-size:13px;font-family:inherit">
          ${servingOpts}
        </select>
      </div>
      ${context === 'pantry' ? (() => {
        const perContainer = state.pantryFsContainerServings ?? 1;
        const containers   = qty;
        const totalSrv     = Math.round(perContainer * containers * 100) / 100;
        const btnStyle     = 'width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center';
        return `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text2);min-width:130px">Servings per container:</span>
            <button onclick="state.pantryFsContainerServings=Math.max(1,(state.pantryFsContainerServings||1)-1);render()" style="${btnStyle}">−</button>
            <span style="font-size:16px;font-weight:600;min-width:30px;text-align:center">${perContainer}</span>
            <button onclick="state.pantryFsContainerServings=(state.pantryFsContainerServings||1)+1;render()" style="${btnStyle}">+</button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text2);min-width:130px">Containers purchased:</span>
            <button onclick="fsSetServingQty('${food.id}',-1)" style="${btnStyle}">−</button>
            <span style="font-size:16px;font-weight:600;min-width:30px;text-align:center">${containers}</span>
            <button onclick="fsSetServingQty('${food.id}',1)" style="${btnStyle}">+</button>
          </div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:12px">Total: <strong style="color:var(--text)">${totalSrv} serving${totalSrv !== 1 ? 's' : ''}</strong> added to pantry</div>`;
      })() : `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <span style="font-size:12px;color:var(--text2)">Quantity:</span>
          <button onclick="fsSetServingQty('${food.id}',-0.125)"
            style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">−</button>
          <span style="font-size:16px;font-weight:600;min-width:30px;text-align:center">${fmtPortion(qty)}</span>
          <button onclick="fsSetServingQty('${food.id}',0.125)"
            style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">+</button>
        </div>`}
      ${serving ? renderFoodNutritionPanel(serving.nutrition, context === 'pantry' ? 1 : qty) : ''}
      ${context === 'pantry'
        ? `<button onclick="fsAddToPantry()" class="btn btn-green btn-full" style="margin-top:12px">Add to Pantry</button>`
        : `<button onclick="fsLogFood('${slot}')" class="btn btn-green btn-full" style="margin-top:12px">Log to ${slot ? slot.charAt(0).toUpperCase() + slot.slice(1) : 'Meal'}</button>`
      }`;
  }

  // Search results / search input
  const safeQ = (state.fsQuery || '').replace(/'/g, "\\'");
  return `
    <div style="display:flex;gap:6px;margin-bottom:10px">
      <input class="input" placeholder="Search any food..." style="flex:1"
        value="${state.fsQuery || ''}"
        oninput="state.fsQuery=this.value"
        onkeydown="if(event.key==='Enter')fsSearch(state.fsQuery)"/>
      <button onclick="fsSearch(state.fsQuery)"
        style="padding:8px 14px;border-radius:10px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;font-size:13px;flex-shrink:0"
        ${state.fsLoading ? 'disabled' : ''}>
        ${state.fsLoading ? '...' : 'Search'}
      </button>
    </div>
    ${state.fsResults.length === 0 && !state.fsLoading
      ? state.fsError
        ? `<div style="font-size:12px;color:var(--danger);padding:12px;background:rgba(226,75,74,.08);border-radius:8px;line-height:1.6">${state.fsError}</div>`
        : `<div style="font-size:12px;color:var(--text3);text-align:center;padding:16px">Type a food name and tap Search</div>`
      : ''}
    ${state.fsResults.slice(0, 10).map(f => `
      <div onclick="fsSelectFood('${f.id}')"
        style="padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer">
        <div style="font-size:13px;font-weight:600">${esc(f.name)}${f.brand ? ` <span style="font-weight:400;color:var(--text3)">(${esc(f.brand)})</span>` : ''}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(f.description || '')}</div>
      </div>`).join('')}`;
}
