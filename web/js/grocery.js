function startAuth() {
  state.authPending=true; render();
  window.open(`${BACKEND}/auth`,'kroger_auth','width=500,height=700');
  let attempts=0;
  state.pollInterval=setInterval(async()=>{
    attempts++;
    if(attempts>90){clearInterval(state.pollInterval);return;}
    try {
      const res=await authFetch(`${BACKEND}/poll-token`);
      const data=await res.json();
      if(data.connected){
        state.krogerConnected=true;
        state.authPending=false;
        clearInterval(state.pollInterval);
        state.pollInterval=null;
        render();
      }
    } catch {}
  },2000);
}

async function manualPoll() {
  const errEl=document.getElementById('auth-error');
  if(errEl)errEl.textContent='Checking...';
  try {
    const res=await authFetch(`${BACKEND}/poll-token`);
    const data=await res.json();
    if(data.connected){
      state.krogerConnected=true;
      state.authPending=false;
      if(state.pollInterval){clearInterval(state.pollInterval);state.pollInterval=null;}
      render();
    } else if(errEl) errEl.textContent='No token found — complete authorization first.';
  } catch(e){ if(errEl)errEl.textContent=`Error: ${e.message}`; }
}

function cancelAuth() {
  if(state.pollInterval){clearInterval(state.pollInterval);state.pollInterval=null;}
  state.authPending=false; render();
}

async function disconnect() {
  await authFetch(`${BACKEND}/auth/kroger/disconnect`,{method:'DELETE'});
  state.krogerConnected=false; state.authPending=false; render();
}
function toggleCheck(k){ state.checked[k]=!state.checked[k]; save(); render(); }
function resetChecklist(){ Object.keys(state.checked).forEach(k=>{ if(k.startsWith('fam::')) delete state.checked[k]; }); save(); render(); }
function clearResults(){ state.pushResults=null; render(); }

// ── PERSONAL GROCERY ITEMS & STAPLES ──

async function saveMyGroceryData() {
  try {
    await authFetch(`${BACKEND}/grocery/user-data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.userGroceryData),
    });
    await loadFamilyGroceryData();
  } catch {}
}

function openMyItemAdd(type = 'item') {
  state.myItemAdd = { open: true, type, query: '', searching: false, results: null, selectedIdx: 0, note: '' };
  render();
}

function closeMyItemAdd() {
  state.myItemAdd = { open: false, type: 'item', query: '', searching: false, results: null, selectedIdx: 0, note: '' };
  render();
}

async function searchMyItem() {
  const q = (state.myItemAdd.query || '').trim();
  if (!q) return;
  state.myItemAdd.searching = true;
  state.myItemAdd.results = null;
  render();
  try {
    const res = await authFetch(`${BACKEND}/search-cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [q] }),
    });
    const data = await res.json();
    state.myItemAdd.results = (data.results || [])[0] || null;
    state.myItemAdd.selectedIdx = 0;
  } catch {}
  state.myItemAdd.searching = false;
  render();
}

async function confirmMyItemAdd(skipMatch = false) {
  const add = state.myItemAdd;
  if (!add.query.trim()) return;

  const result = add.results;
  const product = !skipMatch && result?.status === 'found' ? result.products[add.selectedIdx] : null;

  let fsFood = null;
  if (product) {
    try {
      fsFood = await _fsBestFood(_cleanProductName(product.name), { branded: true });
    } catch {}
  }

  const newItem = {
    id: crypto.randomUUID(),
    name: add.query.trim(),
    krogerUpc:  product?.upc  || null,
    krogerName: product?.name || null,
    krogerSize: product?.size || null,
    qty: 1,
    fsFood,
    notes: add.note.trim() || null,
  };

  const list = add.type === 'item' ? 'items' : 'staples';
  state.userGroceryData[list].push(newItem);
  closeMyItemAdd();
  saveMyGroceryData();
}

function removeMyItem(id) {
  state.userGroceryData.items = state.userGroceryData.items.filter(i => (i.id || i) !== id);
  render();
  saveMyGroceryData();
}

function updateMyItemQty(id, delta, list = 'items') {
  const arr = state.userGroceryData[list];
  const item = arr.find(i => (i.id || i) === id);
  if (!item || typeof item === 'string') return;
  item.qty = Math.max(1, (item.qty || 1) + delta);
  render();
  saveMyGroceryData();
}

function removeMyStaple(id) {
  state.userGroceryData.staples = state.userGroceryData.staples.filter(i => (i.id || i) !== id);
  render();
  saveMyGroceryData();
}

// Called with a numeric index (from render button onclick) to avoid JSON-in-attribute escaping issues
function addStapleToItems(idx) {
  const s = state.userGroceryData.staples[idx];
  if (!s) return;
  const name = typeof s === 'string' ? s : (s.krogerName || s.name);
  const alreadyHas = state.userGroceryData.items.some(i => {
    const n = typeof i === 'string' ? i : (i.krogerName || i.name);
    return n === name;
  });
  if (!alreadyHas) {
    const copy = typeof s === 'string' ? { id: crypto.randomUUID(), name: s, qty: 1 } : { ...s, id: crypto.randomUUID() };
    state.userGroceryData.items.push(copy);
    render();
    saveMyGroceryData();
  }
}

async function removeFamilyItem(email, idx, type) {
  try {
    await authFetch(`${BACKEND}/grocery/family-item-remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, idx, type }),
    });
    await loadFamilyGroceryData();
  } catch {}
}

function setFamilyItemQty(key, delta) {
  const cur = state.familyItemQty[key] ?? 1;
  state.familyItemQty[key] = Math.max(1, cur + delta);
  render();
}

async function pushMyItems() {
  const items = state.userGroceryData.items.map(i => typeof i === 'string' ? i : (i.krogerName || i.name));
  if (!items.length || state.myItemsPushLoading) return;
  state.myItemsPushLoading = true;
  state.myItemsPushResults = null;
  render();
  try {
    const res = await authFetch(`${BACKEND}/push-cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (res.status === 401) {
      state.myItemsPushResults = { _error: 'City Market not connected — ask Caleb to connect in Settings.' };
    } else {
      state.myItemsPushResults = data;
    }
  } catch (e) {
    state.myItemsPushResults = { _error: e.message };
  }
  state.myItemsPushLoading = false;
  render();
}

// ── FAMILY ACCESS MANAGEMENT (owner only) ──

async function addFamilyMember(email, name) {
  if (!email || !email.trim()) return;
  try {
    const res = await authFetch(`${BACKEND}/family-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), name: (name || '').trim() }),
    });
    const data = await res.json();
    state.familyAccessList = data.members || [];
    render();
  } catch {}
}

async function removeFamilyMember(email) {
  try {
    const res = await authFetch(`${BACKEND}/family-access/${encodeURIComponent(email)}`, { method: 'DELETE' });
    const data = await res.json();
    state.familyAccessList = data.members || [];
    render();
  } catch {}
}

// ── NUTRITIONIST ACCESS MANAGEMENT (owner only) ──

async function addNutritionist(email, name) {
  if (!email || !email.trim()) return;
  try {
    const res = await authFetch(`${BACKEND}/nutritionist-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), name: (name || '').trim() }),
    });
    const data = await res.json();
    state.nutritionistAccessList = data.members || [];
    render();
  } catch {}
}

async function removeNutritionist(email) {
  try {
    const res = await authFetch(`${BACKEND}/nutritionist-access/${encodeURIComponent(email)}`, { method: 'DELETE' });
    const data = await res.json();
    state.nutritionistAccessList = data.members || [];
    render();
  } catch {}
}

async function pushCart() {
  if(!state.krogerConnected||state.pushLoading)return;
  state.pushLoading=true; render();
  const ownerItems = state.userGroceryData.items.map(i => typeof i === 'string' ? i : (i.krogerName || i.name));
  const familyItems = state.familyGroceryData.flatMap(u => {
    const allItems = [...(u.items||[]),...(u.staples||[])];
    return allItems.flatMap((it, idx) => {
      const k = `fam::${u.email}::${idx}`;
      if (!state.checked[k]) return [];
      const qty = state.familyItemQty[k] ?? 1;
      const name = typeof it === 'string' ? it : (it.krogerName || it.name);
      return Array(qty).fill(name);
    });
  });
  const items=[...ownerItems,...familyItems];
  try {
    const res=await authFetch(`${BACKEND}/push-cart`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({items}),
    });
    const data=await res.json();
    if(res.status===401){
      state.krogerConnected=false;
      state.pushResults={results:[],summary:{added:0,failed:items.length,total:items.length},_error:'Session expired — reconnect City Market'};
    } else {
      state.pushResults=data;
    }
  } catch(e){
    state.pushResults={results:[],summary:{added:0,failed:items.length,total:items.length},_error:e.message};
  }
  state.pushLoading=false;

  // Add matched items (those with fsFood) to pantry
  _addItemsToPantryAfterPush();

  render();
}

function _addItemsToPantryAfterPush() {
  const toAdd = [];
  const allSourceItems = [
    ...state.userGroceryData.items,
    ...state.familyGroceryData.flatMap(u => {
      const allItems = [...(u.items||[]),...(u.staples||[])];
      return allItems.filter((_, idx) => !!state.checked[`fam::${u.email}::${idx}`]);
    }),
  ].filter(it => typeof it === 'object' && it.fsFood?.servings?.[0]);

  for (const it of allSourceItems) {
    const ppu = (it.krogerSize && it.fsFood?.servings?.[0])
      ? _servingsPerContainer(it.krogerSize, it.fsFood.servings[0].description, it.name)
      : null;
    toAdd.push({
      id: crypto.randomUUID(),
      display: it.krogerName || it.name,
      ingredientName: it.name.toLowerCase(),
      recipeAmount: 1, recipeUnit: it.krogerSize || '',
      amount: it.qty || 1, remaining: it.qty || 1, quantity: it.qty || 1,
      portionsPerUnit: ppu || 1,
      fsFood: it.fsFood,
      krogerName: it.krogerName || it.name,
      krogerSize: it.krogerSize || '',
      krogerUpc: it.krogerUpc || '',
      purchasedAt: new Date().toISOString(),
      fromRecipes: [],
    });
  }
  if (!toAdd.length) return;

  // Merge: bump remaining if ingredientName matches, else append
  const updated = state.pantry.map(p => {
    const match = toAdd.find(n => n.ingredientName === p.ingredientName);
    if (!match) return p;
    return { ...p, remaining: Math.round((p.remaining + match.remaining) * 100) / 100,
             amount: Math.round(((p.amount || 0) + match.amount) * 100) / 100,
             portionsPerUnit: (p.portionsPerUnit && p.portionsPerUnit !== 1) ? p.portionsPerUnit : match.portionsPerUnit,
             fsFood: match.fsFood || p.fsFood, krogerName: match.krogerName || p.krogerName };
  });
  const existing = new Set(updated.map(p => p.ingredientName));
  state.pantry = [...updated, ...toAdd.filter(n => !existing.has(n.ingredientName))];
  authFetch(`${BACKEND}/pantry`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pantry: state.pantry }),
  }).catch(() => {});
}
