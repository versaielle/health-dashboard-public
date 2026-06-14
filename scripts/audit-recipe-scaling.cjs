// Audit: run the real frontend scaling classifier (_fsScalingStatus) over every recipe
// ingredient in a recipes JSON dump and explain every case that isn't 'scaled'.
// Usage: node scripts/audit-recipe-scaling.js <recipes.json>
const fs = require('fs');

const src = ['web/js/state.js', 'web/js/recipes.js', 'web/js/nutrition.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');
(0, eval)('globalThis.BACKEND="";\n' + src + `
; globalThis._A = { _fsScalingStatus, _fsRecipeRatio, _parseServing, _parseServingCount,
  _servingTextUnit, _isUnitMismatch, _isSpiceForScaling, _isNonNumericAmount,
  _ingredientDensity, _WEIGHT_G, _VOL_ML, _SIZE_DESCRIPTOR_RE, _LIQUID_RE };`);
const A = _A;

const recipes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// Mirror the UI's verification-score logic (renderRecipeDetail)
function recipeScore(recipe) {
  const statuses = (recipe.ingredients || []).map(ig => A._fsScalingStatus(ig).status);
  const scoreTotal = statuses.filter(s => s !== 'spice' && s !== 'unit_mismatch').length;
  const verified = statuses.filter(s => s === 'scaled').length;
  return { scoreTotal, verified, statuses };
}

// Why didn't this ingredient scale? Reproduce _fsRecipeRatio's decision tree with commentary.
function diagnose(ing) {
  const fs_ = ing.fsFood;
  if (!fs_) return 'NO_FSFOOD: never matched to a product/food';
  const recipeAmt = parseFloat(ing.amount) || 0;
  if (!recipeAmt) return `BAD_AMOUNT: amount="${ing.amount}" not numeric`;
  let recipeUnit = (ing.unit || '').toLowerCase().trim();
  if (A._SIZE_DESCRIPTOR_RE.test(recipeUnit)) recipeUnit = '';
  const desc = fs_.servingDescription || '';
  const parsed = A._parseServing(desc);
  const count = A._parseServingCount(desc);
  const textUnit = A._servingTextUnit(desc);
  const recipeIsCount = !recipeUnit || /^(count|piece|pieces|each|whole|clove|cloves)$/.test(recipeUnit);
  const density = A._ingredientDensity(ing.name);
  const parts = [];
  parts.push(`recipe="${ing.amount} ${ing.unit || '(unitless)'}"`, `serving="${desc}"`);
  if (recipeIsCount && !count) parts.push(`COUNT_VS_MEASURE: recipe is countable but serving is measured (textUnit="${textUnit}")`);
  if (!recipeIsCount && !parsed) parts.push(`UNPARSEABLE_SERVING: _parseServing returned null`);
  if (!recipeIsCount && parsed) {
    const rW = recipeUnit in A._WEIGHT_G, rV = recipeUnit in A._VOL_ML;
    const sW = parsed.unit in A._WEIGHT_G, sV = parsed.unit in A._VOL_ML;
    if (!rW && !rV) parts.push(`UNKNOWN_RECIPE_UNIT: "${recipeUnit}" not in weight/volume tables`);
    else if (parsed.unit === 'count') parts.push(`MEASURE_VS_COUNT: recipe measured, serving counted`);
    else if ((rW && sV) || (rV && sW)) parts.push(density ? 'CROSS_SYSTEM_DENSITY_OK?' : `CROSS_SYSTEM_NO_DENSITY: no density for "${ing.name}"`);
  }
  if (!fs_.servingGrams) parts.push('no servingGrams fallback');
  return parts.join(' | ');
}

const tally = {};
const errors = [];
const recipeRows = [];
for (const r of recipes) {
  const { scoreTotal, verified, statuses } = recipeScore(r);
  const label = scoreTotal === 0 ? 'no-score' : verified === scoreTotal ? 'FULL' : verified > 0 ? 'PARTIAL' : 'NONE';
  recipeRows.push({ name: r.name, label, verified, scoreTotal });
  (r.ingredients || []).forEach((ing, i) => {
    const st = statuses[i];
    tally[st] = (tally[st] || 0) + 1;
    if (st === 'error' || st === 'none' || st === 'unit_mismatch') {
      errors.push({ recipe: r.name, status: st, ing: ing.name, detail: diagnose(ing) });
    }
  });
}

console.log('=== RECIPES:', recipes.length, '===');
const byLabel = {};
for (const row of recipeRows) (byLabel[row.label] = byLabel[row.label] || []).push(row);
for (const [label, rows] of Object.entries(byLabel)) {
  console.log(`\n— ${label}: ${rows.length}`);
  for (const row of rows) console.log(`   ${row.verified}/${row.scoreTotal}  ${row.name}`);
}
console.log('\n=== INGREDIENT STATUS TALLY ===', JSON.stringify(tally));
console.log('\n=== EVERY NON-SCALED INGREDIENT (excl. spice) ===');
for (const e of errors) console.log(`[${e.status}] ${e.recipe} :: ${e.ing}\n        ${e.detail}`);
