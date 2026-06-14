const BACKEND = '';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const TL_SCALE = 1;       // px per minute
const TL_START_MINS = 0;   // 12 AM (full day)

const THEMES = {
  dark:  { name:'Dark',  bg:'#0f0f0f', bg2:'#1a1a1a', bg3:'#242424', border:'#2e2e2e', text:'#f0f0f0', text2:'#a0a0a0', text3:'#666666' },
  light: { name:'Light', bg:'#f5f5f5', bg2:'#ffffff', bg3:'#ebebeb', border:'#d8d8d8', text:'#111111', text2:'#555555', text3:'#999999' },
};

function applyTheme(name) {
  const t = THEMES[name] || THEMES.dark;
  const r = document.documentElement.style;
  r.setProperty('--bg', t.bg); r.setProperty('--bg2', t.bg2); r.setProperty('--bg3', t.bg3);
  r.setProperty('--border', t.border); r.setProperty('--text', t.text);
  r.setProperty('--text2', t.text2); r.setProperty('--text3', t.text3);
  // Native controls (time inputs etc.) follow the app theme, not the OS
  r.colorScheme = name === 'light' ? 'light' : 'dark';
}

const CAL_COLOR_PALETTE = ['#A78BFA','#60A5FA','#34D399','#F472B6','#FBBF24','#FB923C','#38BDF8','#A3E635'];

function calColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return CAL_COLOR_PALETTE[Math.abs(h) % CAL_COLOR_PALETTE.length];
}
const STORE_ID = '62000415';
const MACROS = { kcal:1900, protein:150, carbs:160, fat:73 };
// Windowed water distribution — hard 7 PM cutoff. Targets are per-window fluid
// ounces. `end` is the window's closing boundary in minutes-from-midnight; the
// two workout-relative windows use the sentinels 'ws' (stack start) and 'ws+70'
// (stack end), resolved against the day's actual workout start at render time.
// A null target means sips-only (no goal, sleep-protecting). Each window's start
// is the previous window's end; the first starts at wake (0).
const WATER_WINDOWS = [
  { id:'wake',      label:'Wake → 9 AM',       target:24,   note:'Aggressive front-load', end:540  },
  { id:'morning',   label:'9 AM → Noon',       target:32,   note:'',                       end:720  },
  { id:'midday',    label:'Noon → 3 PM',       target:24,   note:'',                       end:900  },
  { id:'prestack',  label:'3 PM → Stack',      target:16,   note:'Pre-workout',            end:'ws' },
  { id:'stack',     label:'During stack',      target:20,   note:'',                       end:'ws+70' },
  { id:'poststack', label:'Post-stack → 7 PM', target:20,   note:'',                       end:1140 },
  { id:'evening',   label:'After 7 PM',        target:null, note:'Sips only',              end:1440 },
];
// Daily goal = sum of windowed targets through the 7 PM cutoff (sips-only excluded).
const WATER_TARGET = WATER_WINDOWS.reduce((s, w) => s + (w.target || 0), 0); // 136 oz
// Per-meal targets that sum to MACROS totals
const MEAL_TARGETS = {
  breakfast: { kcal:400,  protein:35, carbs:40, fat:14 },
  lunch:     { kcal:500,  protein:45, carbs:50, fat:18 },
  dinner:    { kcal:750,  protein:55, carbs:55, fat:30 },
  snack:     { kcal:250,  protein:15, carbs:15, fat:11 },
};
const WFH_DAYS = [3,4,5]; // Wed=3, Thu=4, Fri=5
const WAKE_BUFFER_WFH = 60;
const WAKE_BUFFER_OFFICE = 105;


const WORKOUT_START = 960; // 4:00 PM in minutes
const ZYN_STOP_BEFORE_WORKOUT = 90;

const STAPLES = [
  {name:'Scrambled eggs (3)',kcal:210,protein:18,carbs:1,fat:14},
  {name:'Ground turkey bowl',kcal:380,protein:42,carbs:28,fat:9},
  {name:'Chicken breast (6oz)',kcal:280,protein:52,carbs:0,fat:6},
  {name:'ON Whey shake (Fairlife)',kcal:280,protein:40,carbs:14,fat:6},
  {name:'Grass-fed beef (5oz)',kcal:310,protein:35,carbs:0,fat:18},
  {name:'Baby spinach salad',kcal:80,protein:5,carbs:8,fat:3},
  {name:'Sweet potato (med)',kcal:130,protein:3,carbs:30,fat:0},
  {name:'Blueberries (1 cup)',kcal:85,protein:1,carbs:21,fat:0},
  {name:'Banana + walnuts',kcal:200,protein:4,carbs:28,fat:9},
  {name:'Avocado (half)',kcal:120,protein:1,carbs:6,fat:11},
  {name:'Brown rice (½ cup)',kcal:110,protein:2,carbs:23,fat:1},
  {name:'Apple',kcal:95,protein:0,carbs:25,fat:0},
];

// Round a macro gram value to 1 decimal place, avoiding floating-point artifacts
// (e.g. 43.69999999999996 → 43.7). Apply at the point of scaling/aggregation so
// stored log entries and summed totals are clean numbers.
const roundMacro = v => Math.round((v || 0) * 10) / 10;

// Format a portion/serving multiplier using eighth-fraction glyphs where clean
// (⅛ ¼ ⅜ ½ ⅝ ¾ ⅞), e.g. 0.125→⅛, 0.875→⅞, 1→1, 1.125→1⅛. Falls back to a rounded
// decimal for values that aren't a clean multiple of 1/8.
const _EIGHTH_GLYPHS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];
function fmtPortion(n) {
  const v = n || 0;
  const eighths = Math.round(v * 8);
  if (eighths <= 0) return '0';
  if (Math.abs(v * 8 - eighths) > 0.001) return String(Math.round(v * 100) / 100); // not an eighth
  const whole = Math.floor(eighths / 8);
  const rem = eighths % 8;
  if (rem === 0) return String(whole);
  return whole > 0 ? `${whole}${_EIGHTH_GLYPHS[rem]}` : _EIGHTH_GLYPHS[rem];
}

const PORTION_OPTIONS = [
  {v:0.25, label:'¼×', suffix:'¼'},
  {v:1/3,  label:'⅓×', suffix:'⅓'},
  {v:0.5,  label:'½×', suffix:'½'},
  {v:0.75, label:'¾×', suffix:'¾'},
  {v:1,    label:'1×', suffix:null},
  {v:1.5,  label:'1½×', suffix:'1½'},
  {v:2,    label:'2×', suffix:'2'},
];

function getSession() { return localStorage.getItem('hstack_session'); }
function setSession(t) { localStorage.setItem('hstack_session', t); }
function clearSession() {
  localStorage.removeItem('hstack_session');
  localStorage.removeItem('hstack_role');
  localStorage.removeItem('hstack_name');
}
function getUserRole() { return localStorage.getItem('hstack_role'); }
function setUserRole(r) { localStorage.setItem('hstack_role', r); }
function getUserName() { return localStorage.getItem('hstack_name'); }
function setUserName(n) { localStorage.setItem('hstack_name', n); }

async function authFetch(url, opts = {}) {
  const token = getSession();
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...opts, headers });
}

async function loadPrefs() {
  try {
    const res = await authFetch(`${BACKEND}/prefs`);
    const prefs = await res.json();
    if (prefs.theme && THEMES[prefs.theme]) {
      state.theme = prefs.theme;
      applyTheme(prefs.theme);
    }
  } catch {}
}

async function savePrefs() {
  try {
    await authFetch(`${BACKEND}/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: state.theme }),
    });
  } catch {}
}

// FDA Daily Values used as nutrition comparison targets
const NUTRITION_DV = {
  fiber:        { amount: 28,   unit: 'g',  label: 'Fiber' },
  sugar:        { amount: 50,   unit: 'g',  label: 'Sugar' },
  saturatedFat: { amount: 20,   unit: 'g',  label: 'Sat. Fat' },
  polyunsatFat: { amount: 22,   unit: 'g',  label: 'Poly. Fat' },
  cholesterol:  { amount: 300,  unit: 'mg', label: 'Cholesterol' },
  sodium:       { amount: 2300, unit: 'mg', label: 'Sodium' },
  potassium:    { amount: 4700, unit: 'mg', label: 'Potassium' },
};

const GROCERY = {
  Proteins:[
    'Grass-fed ground beef 90/10 (2 lbs)',
    'Ground turkey 93/7 (2 lbs)',
    'Boneless skinless chicken breasts (3 lbs)',
    'Boneless skinless chicken thighs (2 lbs)',
    'Large eggs (18 count)',
    'Fairlife 2% milk (52oz, 2 bottles)',
    'ON 100% Whey Protein Powder',
  ],
  Produce:[
    'Strawberries (1 lb)','Blueberries (1 pint)','Bananas (1 bunch)',
    'Apples (3 count)','Baby spinach (5oz bag)','Romaine hearts (3 pack)',
    'Broccoli crowns (2 count)','Sweet potatoes (3 count)',
    'Garlic (1 bulb)','Limes (4 count)','Avocados (3 count)',
  ],
  Pantry:[
    'Walnuts (8oz bag)','Brown rice (2 lb bag)','Low-sodium chicken broth (32oz)',
    'Olive oil','Balsamic glaze','Hot sauce','Garlic powder',
    'Smoked paprika','Cumin','Everything Bagel seasoning','Sea salt','Black pepper',
  ],
};
