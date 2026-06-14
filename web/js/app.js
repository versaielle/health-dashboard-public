// ── MEAL LOG DATE ──
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getMacroDateStr() { return state.macroDate || todayDateStr(); }

async function loadMealLog(date) {
  state.mealsLoading = true; render();
  loadWaterLog(date); // water for the same day, alongside the meal log
  try {
    const res = await authFetch(`${BACKEND}/meal-log?date=${date}`);
    const data = await res.json();
    state.meals = data.meals || [];
  } catch { state.meals = []; }
  state.mealsLoading = false; render();
}

// ── WATER LOG (fluid ounces, per distribution window) ──
async function loadWaterLog(date) {
  try {
    const res = await authFetch(`${BACKEND}/water-log?date=${date}`);
    const data = await res.json();
    state.waterWindows = data.windows || {};
  } catch { state.waterWindows = {}; }
  render();
}

async function saveWaterLog() {
  try {
    await authFetch(`${BACKEND}/water-log`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: getMacroDateStr(), windows: state.waterWindows }),
    });
  } catch {}
}

// Add (or subtract, via a negative amount) fluid ounces to a single window.
function addWater(windowId, oz) {
  const cur = state.waterWindows[windowId] || 0;
  const next = Math.max(0, Math.round(cur + oz));
  if (next === 0) delete state.waterWindows[windowId];
  else state.waterWindows[windowId] = next;
  saveWaterLog();
  render();
}

async function saveMealLog() {
  try {
    await authFetch(`${BACKEND}/meal-log`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: getMacroDateStr(), meals: state.meals }),
    });
  } catch {}
}

function navMacroDate(delta) {
  const cur = getMacroDateStr();
  const d = new Date(cur + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const next = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = todayDateStr();
  if (next > today) return;
  state.macroDate = next === today ? null : next;
  state.meals = [];
  state.waterWindows = {};
  state.logPanel = null;
  loadMealLog(getMacroDateStr());
}

// ── MEAL ACTIONS ──
function totals(){ const t=state.meals.reduce((a,m)=>({kcal:a.kcal+m.kcal,protein:a.protein+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat}),{kcal:0,protein:0,carbs:0,fat:0}); return {kcal:Math.round(t.kcal),protein:roundMacro(t.protein),carbs:roundMacro(t.carbs),fat:roundMacro(t.fat)}; }
function addMeal(i, slot){
  const portion = state.staplePortion[i] || 1;
  const base = STAPLES[i];
  const portOpt = PORTION_OPTIONS.find(p => Math.abs(p.v - portion) < 0.01);
  const name = base.name + (portOpt?.suffix ? ` (×${portOpt.suffix})` : '');
  state.meals.push({
    name,
    kcal: Math.round(base.kcal * portion),
    protein: roundMacro(base.protein * portion),
    carbs: roundMacro(base.carbs * portion),
    fat: roundMacro(base.fat * portion),
    id: Date.now(),
    loggedAt: new Date().toISOString(),
    mealSlot: slot || state.logPanel?.slot || 'other'
  });
  save(); saveMealLog(); render();
}
function removeMeal(i){ state.meals.splice(i,1); save(); saveMealLog(); render(); }
function clearMeals(){ state.meals=[]; save(); saveMealLog(); render(); }
function logCustomMeal(){
  const m=state.customMeal;
  if(!m.name)return;
  state.meals.push({name:m.name,kcal:+m.kcal,protein:+m.protein,carbs:+m.carbs,fat:+m.fat,id:Date.now(),loggedAt:new Date().toISOString(),mealSlot:state.logPanel?.slot||'other'});
  state.customMeal={name:'',kcal:'',protein:'',carbs:'',fat:''};
  state.showCustom=false; save(); saveMealLog(); render();
}
function logRecipeAsMeal(recipeId, slot) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  if (!recipe) return;
  const srv = state.logPanelServings[recipeId] || 1;
  const mealId = Date.now();
  const purchased = computeMacrosFromPantry(recipe, srv);

  const meal = {
    name: recipe.name + (srv !== 1 ? ` (×${srv})` : ''),
    kcal:    purchased ? Math.round(purchased.kcal)    : Math.round(recipe.perServing.kcal * srv),
    protein: roundMacro(purchased ? purchased.protein : recipe.perServing.protein * srv),
    carbs:   roundMacro(purchased ? purchased.carbs   : recipe.perServing.carbs   * srv),
    fat:     roundMacro(purchased ? purchased.fat     : recipe.perServing.fat     * srv),
    mealSlot: slot,
    id: mealId,
    loggedAt: new Date().toISOString(),
  };

  if (purchased) {
    if (purchased.matchedCount > 0) {
      meal.fiber        = Math.round(purchased.fiber        * 10) / 10;
      meal.sugar        = Math.round(purchased.sugar        * 10) / 10;
      meal.saturatedFat = Math.round(purchased.saturatedFat * 10) / 10;
      meal.polyunsatFat = Math.round(purchased.polyunsatFat * 10) / 10;
      meal.cholesterol  = Math.round(purchased.cholesterol);
      meal.sodium       = Math.round(purchased.sodium);
      meal.potassium    = Math.round(purchased.potassium);
    }
    if (!purchased.blended) {
      meal.fromPantry = true;
    } else {
      meal.blended = true;
      meal.unmatchedIngredients = purchased.unmatchedIngredients;
    }
  }

  state.meals.push(meal);
  save(); saveMealLog(); render();
  if (!purchased) fsEnrichMeal(mealId, recipe, meal.kcal);
  _deductFromPantry(recipe, srv);
}

function logPantryItemAsMeal(pantryItemId, slot) {
  const p = state.pantry.find(item => item.id === pantryItemId);
  if (!p || !p.fsFood?.servings?.[0]) return;
  const srv = state.logPanelServings[pantryItemId] || 1;
  const serving = p.fsFood.servings[0];
  const n = serving.nutrition;
  const meal = {
    id: Date.now(),
    name: (p.krogerName || p.ingredientName) + (srv !== 1 ? ` ×${srv}` : '') + ` (${serving.description})`,
    kcal:         Math.round(n.kcal         * srv),
    protein:      roundMacro(n.protein      * srv),
    carbs:        roundMacro(n.carbs        * srv),
    fat:          roundMacro(n.fat          * srv),
    fiber:        Math.round(n.fiber        * srv * 10) / 10,
    sugar:        Math.round(n.sugar        * srv * 10) / 10,
    saturatedFat: Math.round(n.saturatedFat * srv * 10) / 10,
    polyunsatFat: Math.round(n.polyunsatFat * srv * 10) / 10,
    cholesterol:  Math.round(n.cholesterol  * srv),
    sodium:       Math.round(n.sodium       * srv),
    potassium:    Math.round(n.potassium    * srv),
    mealSlot: slot,
    loggedAt: new Date().toISOString(),
    fromPantry: true,
  };
  state.meals.push(meal);

  // Eating from the pantry consumes it: one logged serving = one portion
  // (1/portionsPerUnit of a container).
  const ppu = p.portionsPerUnit || 1;
  p.remaining = Math.max(0, Math.round((p.remaining - srv / ppu) * 100) / 100);
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: state.pantry }),
  }).catch(() => {});

  save();
  saveMealLog();
  render();
}

function setMealTime(mealId, timeValue) {
  const meal = state.meals.find(m => m.id === mealId);
  if (!meal || !timeValue) return;
  const dateStr = getMacroDateStr();
  meal.loggedAt = new Date(`${dateStr}T${timeValue}:00`).toISOString();
  saveMealLog();
}
function openLogPanel(slot){
  const defaultTab = state.preparedMeals.some(p => p.portionsRemaining > 0) ? 'prepared' : 'recipes';
  state.logPanel = { slot, subTab: defaultTab };
  render();
}
function closeLogPanel(){ state.logPanel=null; render(); }
function setLogPanelSubTab(tab){ if(state.logPanel)state.logPanel.subTab=tab; render(); }
function setStaplePortion(i, portion){ state.staplePortion[i]=portion; render(); }
// For recipes/pantry — supports 1/8 (0.125) increments, minimum 0.125
function setLogPanelServings(recipeId,val){ const n=parseFloat(val); state.logPanelServings[recipeId]=Math.max(0.125,isNaN(n)?1:Math.round(n*8)/8); render(); }
// For prepared meals & pantry — 1/8 (0.125) increments, minimum 0.125
function setPreparedServings(id,val){ const n=parseFloat(val); state.logPanelServings[id]=Math.max(0.125,Math.min(12,isNaN(n)?1:Math.round(n*8)/8)); render(); }

// ── CONFLICTS ──
function ignoreConflict(i){
  const key=(state._conflicts||[])[i];
  if(!key||state.ignoredConflicts.includes(key))return;
  state.ignoredConflicts.push(key);
  save();
  render();
}
function clearIgnoredConflicts(){
  state.ignoredConflicts=[];
  save();
  render();
}

// ── NAV ──
function setTab(t){ if(state.userRole==='grocery'&&t!=='grocery')return; if(state.userRole==='nutritionist'&&t!=='macros')return; state.tab=t; render(); }
function setViewDay(v){ state.viewDay=v; save(); render(); }
function setMeeting(h){ state.meetingHour=h; save(); render(); }
function saveWakeTimes() {
  authFetch(`${BACKEND}/wake-times`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({wakeOverrides:state.wakeOverrides,wfhDays:state.wfhDays})}).catch(()=>{});
}
function setWakeOverride(day, val){
  state.wakeOverrides={...state.wakeOverrides,[day]:val||undefined};
  if(!val) delete state.wakeOverrides[day];
  save(); render(); saveWakeTimes();
}
function setWfhDay(dow, val){
  state.wfhDays={...state.wfhDays,[dow]:val};
  save(); render(); saveWakeTimes();
}

// ── DAILY RESET ──
function midnightReset(){
  const now=new Date(), msUntilMidnight=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1)-now;
  setTimeout(()=>{
    state.macroDate=null; state.logPanel=null;
    loadMealLog(getMacroDateStr()); // load fresh (empty) log for new day
    save(); render();
    midnightReset();
  }, msUntilMidnight);
}

// ── MICROSOFT STATUS REFRESH ──
let _msRefreshOnFocus=false;
function scheduleStatusRefresh(){ _msRefreshOnFocus=true; }
window.addEventListener('focus',async()=>{
  if(!_msRefreshOnFocus)return;
  _msRefreshOnFocus=false;
  await loadCalUrls();
  render();
  if(state.calUrls.length) fetchCalendars();
});

// ── AUTH ──
async function initApp() {
  const token = getSession();
  if (token) {
    try {
      const res = await fetch(`${BACKEND}/auth/verify`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      if (data.valid) {
        state.userRole  = data.role  || getUserRole()  || 'owner';
        state.userEmail = data.email;
        state.userName  = data.name  || getUserName()  || '';
        setUserRole(state.userRole);
        setUserName(state.userName);
        showApp();
        return;
      }
    } catch {}
  }
  clearSession();
  initGIS();
}

function initGIS() {
  const CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
  const tryInit = () => {
    if (!window.google?.accounts?.id) { setTimeout(tryInit, 50); return; }
    google.accounts.id.initialize({ client_id: CLIENT_ID, callback: handleGoogleSignIn });
    google.accounts.id.renderButton(document.getElementById('g_id_signin'), {
      type: 'standard', theme: 'filled_black', text: 'sign_in_with', shape: 'pill', size: 'large',
    });
  };
  tryInit();
}

async function loadWakeTimes() {
  try {
    const res = await authFetch(`${BACKEND}/wake-times`);
    const data = await res.json();
    if (data.wakeOverrides && Object.keys(data.wakeOverrides).length) state.wakeOverrides = data.wakeOverrides;
    if (data.wfhDays && Object.keys(data.wfhDays).length) state.wfhDays = data.wfhDays;
    render();
  } catch {}
}

async function loadWorkoutOverrides() {
  try {
    const res = await authFetch(`${BACKEND}/workout-start`);
    const data = await res.json();
    if (data.workoutOverrides) { state.workoutOverrides = data.workoutOverrides; render(); }
  } catch {}
}

function saveWorkoutOverrides() {
  authFetch(`${BACKEND}/workout-start`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workoutOverrides: state.workoutOverrides }),
  }).catch(() => {});
}

// ── WORKOUT DRAG ──
let _woDrag = null;
let _woRafId = null;

function _getMtDateStr(isToday) {
  const base = new Date(); if (!isToday) base.setDate(base.getDate() + 1);
  const fp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(base);
  const fpm = v => fp.find(p => p.type === v).value;
  return `${fpm('year')}-${fpm('month')}-${fpm('day')}`;
}

async function _syncWorkoutToGoogle() {
  const isToday = state.viewDay === 'today';
  const date = _getMtDateStr(isToday);
  const base = new Date(); if (!isToday) base.setDate(base.getDate() + 1); base.setHours(0,0,0,0);
  const ws = (state.workoutOverrides && state.workoutOverrides[base.getDay()]) || WORKOUT_START;
  const res = await authFetch(`${BACKEND}/push-workout-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, workoutStart: ws }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (d.error === 'not_authenticated') { state.googleConnected = false; render(); }
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  return d;
}

function startWorkoutDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  const tlEl = document.getElementById('day-tl');
  if (!tlEl) return;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const isToday = state.viewDay === 'today';
  const base = new Date(); if (!isToday) base.setDate(base.getDate() + 1); base.setHours(0,0,0,0);
  const dow = base.getDay();
  const ws = (state.workoutOverrides && state.workoutOverrides[dow]) || WORKOUT_START;
  const blockTopPx = (ws - TL_START_MINS) * TL_SCALE;
  const tlTop = tlEl.getBoundingClientRect().top;
  _woDrag = { grabOffset: clientY - tlTop - blockTopPx, dow };
  document.addEventListener('touchmove', _onWoDragMove, { passive: false });
  document.addEventListener('touchend', _onWoDragEnd);
  document.addEventListener('mousemove', _onWoDragMove);
  document.addEventListener('mouseup', _onWoDragEnd);
}

function _onWoDragMove(e) {
  if (!_woDrag) return;
  e.preventDefault();
  _woDrag.lastClientY = e.touches ? e.touches[0].clientY : e.clientY;
  if (_woRafId) return;
  _woRafId = requestAnimationFrame(() => {
    _woRafId = null;
    if (!_woDrag) return;
    const tlEl = document.getElementById('day-tl');
    if (!tlEl) return;
    const relY = _woDrag.lastClientY - tlEl.getBoundingClientRect().top - _woDrag.grabOffset;
    const snapped = Math.round((TL_START_MINS + relY / TL_SCALE) / 15) * 15;
    const clamped = Math.max(360, Math.min(1320, snapped));
    if (clamped !== (state.workoutOverrides[_woDrag.dow] || WORKOUT_START)) {
      state.workoutOverrides = { ...state.workoutOverrides, [_woDrag.dow]: clamped };
      const contentEl = document.querySelector('.content');
      const scroll = contentEl ? contentEl.scrollTop : 0;
      render();
      if (contentEl) contentEl.scrollTop = scroll;
    }
  });
}

function _showSyncToast(msg, isError = false) {
  let el = document.getElementById('sync-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-toast';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:20px;font-size:13px;font-weight:500;z-index:9999;transition:opacity .3s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? 'rgba(226,75,74,.9)' : 'rgba(29,158,117,.9)';
  el.style.color = '#fff';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

function _onWoDragEnd() {
  if (!_woDrag) return;
  document.removeEventListener('touchmove', _onWoDragMove);
  document.removeEventListener('touchend', _onWoDragEnd);
  document.removeEventListener('mousemove', _onWoDragMove);
  document.removeEventListener('mouseup', _onWoDragEnd);
  if (_woRafId) { cancelAnimationFrame(_woRafId); _woRafId = null; }
  save();
  saveWorkoutOverrides();
  _woDrag = null;
  render();
  if (state.googleConnected) _syncWorkoutToGoogle().then(() => {
    _showSyncToast('Calendar updated');
  }).catch(err => {
    _showSyncToast('Calendar sync failed: ' + err.message, true);
  });
}

async function pushWorkoutToCalendar(e) {
  e.stopPropagation();
  const isToday = state.viewDay === 'today';
  const date = _getMtDateStr(isToday);
  const base = new Date(); if (!isToday) base.setDate(base.getDate() + 1); base.setHours(0,0,0,0);
  const ws = (state.workoutOverrides && state.workoutOverrides[base.getDay()]) || WORKOUT_START;
  try {
    const res = await authFetch(`${BACKEND}/push-workout-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, workoutStart: ws }),
    });
    const data = await res.json();
    if (data.ok) alert('Added to Google Calendar!');
    else {
      if (data.error === 'not_authenticated') { state.googleConnected = false; render(); }
      alert('Error: ' + (data.error || 'unknown'));
    }
  } catch (err) { alert('Error: ' + err.message); }
}

function setTheme(name) { state.theme = name; applyTheme(name); save(); savePrefs(); render(); }

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  load();
  applyTheme(state.theme);
  document.getElementById('topbar-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  document.body.classList.remove('grocery-role', 'nutritionist-role');

  // Read-only nutritionist: Macros tab only, macro logs only. Skip every other
  // load (those routes 403 for this role).
  if (state.userRole === 'nutritionist') {
    document.body.classList.add('nutritionist-role');
    state.tab = 'macros';
    render();
    initPullToRefresh();
    loadMealLog(getMacroDateStr());
    midnightReset();
    return;
  }

  if (state.userRole === 'grocery') {
    document.body.classList.add('grocery-role');
    state.tab = 'grocery';
  }

  render();
  initPullToRefresh();
  loadGroceryUserData();
  loadFamilyGroceryData();

  if (state.userRole !== 'grocery') {
    loadPrefs().then(() => render());
    authFetch(`${BACKEND}/poll-token`).then(r=>r.json()).then(d=>{ if(d.connected){state.krogerConnected=true;render();} }).catch(()=>{});
    loadCalUrls().then(()=>{ if(state.calUrls.length) fetchCalendars(); });
    loadWakeTimes();
    loadWorkoutOverrides();
    loadPantry();
    loadPreparedMeals();
    loadRecipes();
    loadMealLog(getMacroDateStr());
    loadFamilyAccessList();
    loadNutritionistAccessList();
    midnightReset();
  }
}

function clearPantry() {
  if (!confirm('Clear all pantry items?')) return;
  state.pantry = [];
  save();
  render();
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: [] }),
  }).catch(() => {});
}

function clearDepletedPantry() {
  state.pantry = state.pantry.filter(p => p.remaining > 0);
  save();
  render();
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: state.pantry }),
  }).catch(() => {});
}

// Step `remaining` by `delta` PORTIONS (one container = portionsPerUnit portions).
function adjustPantryItem(id, delta) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  const ppu = item.portionsPerUnit || 1;
  item.remaining = Math.min(item.amount, Math.max(0, Math.round((item.remaining + delta / ppu) * 100) / 100));
  save();
  render();
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: state.pantry }),
  }).catch(() => {});
}

// Adjust how many portions one container holds (the pantry "portions per container" toggle).
function setPantryPortionsPerUnit(id, delta) {
  const item = state.pantry.find(p => p.id === id);
  if (!item) return;
  const cur = item.portionsPerUnit || 1;
  // Step whole numbers; round fractional estimates (e.g. 9.3) to the nearest integer first
  item.portionsPerUnit = Math.max(1, Math.round(cur) + delta);
  save();
  render();
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: state.pantry }),
  }).catch(() => {});
}

async function loadPantry() {
  try {
    const res = await authFetch(`${BACKEND}/pantry`);
    const data = await res.json();
    if (Array.isArray(data.pantry)) { state.pantry = data.pantry; render(); }
  } catch {}
}

async function loadPreparedMeals() {
  try {
    const res = await authFetch(`${BACKEND}/prepared-meals`);
    const data = await res.json();
    state.preparedMeals = data.preparedMeals || [];
    render();
  } catch {}
}

async function savePreparedMeals() {
  try {
    await authFetch(`${BACKEND}/prepared-meals`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preparedMeals: state.preparedMeals }),
    });
  } catch {}
}

async function addPreparedMealPortion(id) {
  const pm = state.preparedMeals.find(p => p.id === id);
  if (!pm) return;
  pm.portionsRemaining += 1;
  render();
  await savePreparedMeals();
}

async function discardPreparedMeal(id) {
  const pm = state.preparedMeals.find(p => p.id === id);
  if (!pm) return;
  if (!confirm(`Discard ${pm.portionsRemaining} remaining portion${pm.portionsRemaining !== 1 ? 's' : ''} of "${pm.recipeName}"?`)) return;
  state.preparedMeals = state.preparedMeals.filter(p => p.id !== id);
  render();
  await savePreparedMeals();
}

async function othersAtePrepared(id) {
  const pm = state.preparedMeals.find(p => p.id === id);
  if (!pm || pm.portionsRemaining <= 0) return;
  const portions = Math.min(state.logPanelServings[id] || 1, pm.portionsRemaining);
  pm.portionsRemaining -= portions;
  if (pm.portionsRemaining <= 0) {
    state.preparedMeals = state.preparedMeals.filter(p => p.id !== id);
  }
  render();
  try {
    const res = await authFetch(`${BACKEND}/prepared-meals/${id}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portions }),
    });
    const data = await res.json();
    if (data.preparedMeals) { state.preparedMeals = data.preparedMeals; render(); }
  } catch {}
}

async function logPreparedMeal(preparedMealId, slot) {
  const pm = state.preparedMeals.find(p => p.id === preparedMealId);
  if (!pm || pm.portionsRemaining <= 0) return;

  const portions = Math.min(state.logPanelServings[preparedMealId] || 1, pm.portionsRemaining);
  const m = pm.portionMacros;

  const meal = {
    id: Date.now(),
    name: pm.recipeName + (portions !== 1 ? ` (${portions} srv — prepped)` : ' (prepped)'),
    kcal:    Math.round(m.kcal    * portions),
    protein: roundMacro(m.protein * portions),
    carbs:   roundMacro(m.carbs   * portions),
    fat:     roundMacro(m.fat     * portions),
    mealSlot: slot,
    loggedAt: new Date().toISOString(),
    fromPrepared: true,
    preparedMealId,
  };

  if (m.fiber !== undefined) {
    meal.fiber        = Math.round(m.fiber        * portions * 10) / 10;
    meal.sugar        = Math.round(m.sugar        * portions * 10) / 10;
    meal.saturatedFat = Math.round(m.saturatedFat * portions * 10) / 10;
    meal.polyunsatFat = Math.round(m.polyunsatFat * portions * 10) / 10;
    meal.cholesterol  = Math.round(m.cholesterol  * portions);
    meal.sodium       = Math.round(m.sodium       * portions);
    meal.potassium    = Math.round(m.potassium    * portions);
  }
  if (m.blended) {
    meal.blended = true;
    meal.unmatchedIngredients = m.unmatchedIngredients;
  } else if (m.fromPantry) {
    meal.fromPantry = true;
  }

  state.meals.push(meal);
  saveMealLog();

  pm.portionsRemaining -= portions;
  if (pm.portionsRemaining <= 0) {
    state.preparedMeals = state.preparedMeals.filter(p => p.id !== preparedMealId);
  }
  render();

  try {
    const res = await authFetch(`${BACKEND}/prepared-meals/${preparedMealId}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portions }),
    });
    const data = await res.json();
    if (data.preparedMeals) { state.preparedMeals = data.preparedMeals; render(); }
  } catch {}
}

async function loadGroceryUserData() {
  try {
    const res = await authFetch(`${BACKEND}/grocery/user-data`);
    const data = await res.json();
    const migrate = arr => (arr || []).map(i => typeof i === 'string' ? { id: crypto.randomUUID(), name: i, qty: 1 } : i);
    state.userGroceryData = { staples: migrate(data.staples), items: migrate(data.items) };
    render();
  } catch {}
}

async function loadFamilyGroceryData() {
  try {
    const res = await authFetch(`${BACKEND}/grocery/family`);
    const data = await res.json();
    state.familyGroceryData = data.users || [];
    render();
  } catch {}
}

async function loadFamilyAccessList() {
  try {
    const res = await authFetch(`${BACKEND}/family-access`);
    const data = await res.json();
    state.familyAccessList = data.members || [];
    render();
  } catch {}
}

async function loadNutritionistAccessList() {
  try {
    const res = await authFetch(`${BACKEND}/nutritionist-access`);
    const data = await res.json();
    state.nutritionistAccessList = data.members || [];
    render();
  } catch {}
}

async function handleGoogleSignIn(response) {
  document.getElementById('login-error').textContent = '';
  try {
    const res = await fetch(`${BACKEND}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (data.token) {
      setSession(data.token);
      state.userRole  = data.role  || 'owner';
      state.userEmail = data.email;
      state.userName  = data.name  || '';
      setUserRole(state.userRole);
      setUserName(state.userName);
      showApp();
    } else {
      const detail = data.email ? ` (${data.email})` : data.detail ? `: ${JSON.stringify(data.detail)}` : '';
      document.getElementById('login-error').textContent = (data.error || 'Sign-in failed') + detail;
    }
  } catch(e) {
    document.getElementById('login-error').textContent = e.message;
  }
}

async function logout() {
  try { await authFetch(`${BACKEND}/auth/logout`, { method: 'DELETE' }); } catch {}
  clearSession();
  location.reload();
}

// ── PULL TO REFRESH ──
function initPullToRefresh() {
  const content = document.getElementById('content');
  const ptrEl   = document.getElementById('ptr');
  const textEl  = document.getElementById('ptr-text');
  if (!content || !ptrEl) return;

  const THRESHOLD  = 100;  // finger-drag px needed to commit
  const MAX_H      = 72;   // max indicator height in px
  const SNAP_MS    = 300;
  const RESISTANCE = 0.45; // indicator travels at 45% of finger speed
  const HOLD_MS    = 150;  // ms user must hold past threshold (filters accidental flicks)
  const SETTLE_MS  = 400;  // ms scrollTop must be at zero before arming (filters momentum scrolls)

  let y0 = 0, x0 = 0, pulling = false, wasReady = false, busy = false;
  let directionChecked = false, pullReadyAt = 0, lastScrollTime = 0, pullDisabled = false;

  // Page uses document-level scroll, so track it on window (content.scrollTop is always 0)
  window.addEventListener('scroll', () => { lastScrollTime = Date.now(); }, { passive: true });

  function dampen(dy) {
    return Math.min(MAX_H, dy * RESISTANCE);
  }

  function setH(h) { ptrEl.style.height = h + 'px'; }

  function setState(s) {
    ptrEl.dataset.state = s;
    if (textEl) {
      if (s === 'pulling')    textEl.textContent = 'Pull to refresh';
      if (s === 'ready')      textEl.textContent = 'Release to refresh';
      if (s === 'refreshing') textEl.textContent = 'Refreshing…';
    }
  }

  function snapBack(cb) {
    ptrEl.style.transition = `height ${SNAP_MS}ms cubic-bezier(.4,0,.2,1)`;
    setH(0);
    setTimeout(() => {
      ptrEl.style.transition = '';
      setState('idle');
      busy = false;
      cb?.();
    }, SNAP_MS);
  }

  async function doRefresh() {
    setState('refreshing');
    setH(60);
    try {
      if (state.userRole !== 'grocery') {
        await Promise.all([
          loadCalUrls().then(() => { if (state.calUrls.length) fetchCalendars(); }),
          loadPantry(),
          loadPreparedMeals(),
          loadRecipes(),
          loadMealLog(getMacroDateStr()),
          loadWakeTimes(),
          loadWorkoutOverrides(),
        ]);
        loadGroceryUserData();
        loadFamilyGroceryData();
      } else {
        await Promise.all([loadGroceryUserData(), loadFamilyGroceryData()]);
      }
      render();
    } catch {}
    snapBack();
  }

  content.addEventListener('touchstart', e => {
    // Eligibility decided once, here, for the entire touch sequence.
    // If not settled at top, lock out PTR for all subsequent move/end events.
    const settledAtTop = window.scrollY <= 2 && (Date.now() - lastScrollTime > SETTLE_MS);
    if (!settledAtTop || busy) { pullDisabled = true; return; }
    pullDisabled = false;
    y0 = e.touches[0].clientY;
    x0 = e.touches[0].clientX;
    pulling = false;
    wasReady = false;
    directionChecked = false;
    pullReadyAt = 0;
  }, { passive: true });

  content.addEventListener('touchmove', e => {
    if (pullDisabled || busy) return;
    const dy = e.touches[0].clientY - y0;
    const dx = Math.abs(e.touches[0].clientX - x0);
    if (dy <= 0) return;

    // Wait for enough initial travel to classify the gesture direction
    if (!directionChecked) {
      if (dy + dx < 10) return;
      directionChecked = true;
      // Cancel if horizontal component dominates (swipe/horizontal scroll)
      if (dx > dy * 0.5) { pullDisabled = true; return; }
    }

    pulling = true;
    e.preventDefault();
    setH(dampen(dy));
    if (dy >= THRESHOLD) {
      if (!wasReady) pullReadyAt = Date.now();
      wasReady = true;
      setState('ready');
    } else {
      wasReady = false;
      setState('pulling');
    }
  }, { passive: false });

  content.addEventListener('touchend', () => {
    pullDisabled = false;
    if (!pulling) return;
    pulling = false;
    // Require the ready state to be held for HOLD_MS to filter out quick flicks
    const intentional = wasReady && (Date.now() - pullReadyAt) >= HOLD_MS;
    if (intentional && !busy) {
      busy = true;
      doRefresh();
    } else {
      snapBack();
    }
  }, { passive: true });

  content.addEventListener('touchcancel', () => {
    pullDisabled = false;
    if (!pulling) return;
    pulling = false;
    snapBack();
  }, { passive: true });
}

initApp();
