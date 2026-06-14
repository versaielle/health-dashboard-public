const el = id => document.getElementById(id);
const pct = (v,t) => Math.min(100,Math.round(v/t*100));

function render() {
  ['day','macros','grocery','recipes'].forEach(t=>
    el(`tab-${t}`).classList.toggle('active',state.tab===t)
  );
  const c=el('content');
  // Anchor-based scroll preservation for recipes tab; simple offset-restore for others
  let anchor=null, anchorTop=0;
  if(state.tab==='recipes'&&c){
    for(const node of c.querySelectorAll('[data-rid]')){
      const r=node.getBoundingClientRect();
      if(r.top>=56&&r.top<window.innerHeight){anchor=node.dataset.rid;anchorTop=r.top;break;}
    }
  }
  const scrollY=c?c.scrollTop:0;
  if(state.tab==='day')c.innerHTML=renderDay();
  else if(state.tab==='macros')c.innerHTML=renderMacros();
  else if(state.tab==='grocery')c.innerHTML=renderGrocery();
  else if(state.tab==='recipes')c.innerHTML=renderRecipes();
  requestAnimationFrame(()=>{
    if(!c)return;
    if(anchor){
      const found=c.querySelector(`[data-rid="${anchor}"]`);
      if(found){c.scrollTop+=found.getBoundingClientRect().top-anchorTop;return;}
    }
    if(scrollY)c.scrollTop=scrollY;
  });
  _syncWeeklyDrawer();
  _syncWaterDrawer();
  _syncDrawerPeek();
  const overlay=el('settings-overlay');
  overlay.classList.toggle('open',state.settingsOpen);
  overlay.querySelector('.settings-body').innerHTML=renderSettings();
}

function openSettings(){state.settingsOpen=true;render();}
function closeSettings(){state.settingsOpen=false;render();}

// ── TIME PICKER ──
// Native <input type="time">: iOS (PWA) opens the system wheel, desktop Chromium shows a
// compact segmented hh:mm AM/PM field (type or arrow keys). No custom state, no popup.
// callbackStr must use `time` as the variable holding the resulting "HH:MM" 24h string.
// Example: renderTimePicker('wake-1', '06:30', 'setWakeOverride(1,time)', { step: 300 })
// options: step (seconds; 300 = 5-min increments on the iOS wheel & desktop arrows),
//          allowClear (small ✕ that fires the callback with time='').
function renderTimePicker(pickerId, value24h, callbackStr, { step = 60, allowClear = false } = {}) {
  const clear = allowClear && value24h
    ? `<button class="time-clear" title="Clear" onclick="const time='';${callbackStr}">✕</button>`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:2px">
    <input type="time" class="time-input" id="tp-${pickerId}" value="${value24h || ''}" step="${step}"
      onchange="const time=this.value;${callbackStr}">
    ${clear}
  </span>`;
}

function layoutCols(events) {
  const evs=events.map(e=>({...e,_s:e.mins,_e:e.endMins!==undefined?e.endMins:e.mins+Math.max(32,e.duration||0)}));
  evs.sort((a,b)=>a._s-b._s);
  const ends=[];
  for(const ev of evs){let c=ends.findIndex(x=>x<=ev._s);if(c<0)c=ends.length;ends[c]=ev._e;ev._c=c;}
  for(const ev of evs){let mx=0;for(const o of evs)if(o._s<ev._e&&o._e>ev._s)mx=Math.max(mx,o._c);ev._n=mx+1;}
  return evs;
}

// ── DAY ──
function renderDay() {
  const isToday=state.viewDay==='today';
  const today=new Date();today.setHours(0,0,0,0);
  const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  const targetDate=isToday?today:tomorrow;
  const dow=targetDate.getDay();
  const ws=(state.workoutOverrides&&state.workoutOverrides[dow])||WORKOUT_START;
  const calEvents=isToday?state.calEvents:state.calTomorrowEvents;
  const firstMins=getFirstMeetingMins(calEvents,state.meetingHour);
  const wakeVal=state.wakeOverrides[dow];
  const wakeOverrideMins=wakeVal?((+wakeVal.split(':')[0])*60+(+wakeVal.split(':')[1])):null;
  const stackEvents=getStackEvents(firstMins,targetDate,wakeOverrideMins);
  const conflicts=getConflicts(calEvents, ws);
  const isWeekend=dow===0||dow===6;
  const isWFH=!isWeekend&&!!(state.wfhDays&&state.wfhDays[dow]);
  const dayTag=isWeekend
    ?`<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(127,119,221,.15);color:#7F77DD">Weekend</span>`
    :`<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${isWFH?'rgba(29,158,117,.15)':'rgba(55,138,221,.15)'};color:${isWFH?'var(--green)':'var(--blue)'}">${isWFH?'WFH':'Office'}</span>`;
  const autoNotice=calEvents.length
    ?`<div style="font-size:11px;color:var(--green);margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        First meeting ${minsToFmt(firstMins)} · ${dayTag}
       </div>`
    :`<div style="margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <span style="font-size:12px;color:var(--text3)">No calendar events</span>${dayTag}
       </div>`;
  const calStatus=state.calLoading
    ?`<div style="text-align:center;padding:16px;color:var(--text3);font-size:13px">Syncing calendars...</div>`
    :state.calError?`<div style="font-size:12px;color:var(--danger);margin-bottom:8px">Calendar error: ${state.calError}</div>`:'';
  const visibleConflicts=_woDrag?[]:conflicts.filter(c=>!state.ignoredConflicts.includes(c));
  state._conflicts=visibleConflicts;
  const banners=visibleConflicts.map((c,i)=>`<div class="conflict-banner" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <span>⚠️ ${esc(c)}</span>
      <button onclick="ignoreConflict(${i})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;flex-shrink:0;padding:0">×</button>
    </div>`).join('');

  // ── Block timeline ──
  const latestMins=Math.max(...stackEvents.map(e=>e.mins+Math.max(32,e.duration||0)),...calEvents.map(e=>e.endMins!=null?e.endMins:e.mins+32),1440);
  const TL_END_MINS=Math.max(1440,Math.ceil((latestMins+30)/60)*60);
  const totalH = (TL_END_MINS - TL_START_MINS) * TL_SCALE;

  // Hour labels + grid lines
  const endHour=Math.ceil(TL_END_MINS/60);
  const hours=[];
  for(let h=0;h<=endHour;h++) hours.push(h);
  const hourLabels=hours.map(h=>{
    const label=h===0||h===24?'12 AM':h>24?`${h-24} AM`:h<12?`${h} AM`:h===12?'12 PM':`${h-12} PM`;
    const top=(h*60-TL_START_MINS)*TL_SCALE;
    return `<div style="position:absolute;top:${top}px;right:6px;font-size:10px;color:var(--text3);transform:translateY(-50%);white-space:nowrap;line-height:1">${label}</div>`;
  }).join('');
  const hourLines=hours.map(h=>`<div style="position:absolute;top:${(h*60-TL_START_MINS)*TL_SCALE}px;left:0;right:0;border-top:1px solid var(--border);opacity:.25;pointer-events:none"></div>`).join('');

  // "Now" indicator
  const nowDate=new Date();
  const nowMins=nowDate.getHours()*60+nowDate.getMinutes();
  const nowLine=(isToday&&nowMins>TL_START_MINS&&nowMins<TL_END_MINS)?`
    <div style="position:absolute;top:${(nowMins-TL_START_MINS)*TL_SCALE}px;left:0;right:0;z-index:10;pointer-events:none;display:flex;align-items:center">
      <div style="width:8px;height:8px;border-radius:50%;background:var(--danger);flex-shrink:0;margin-left:-4px"></div>
      <div style="flex:1;height:2px;background:var(--danger)"></div>
    </div>`:'';

  // Unified column layout for stack + cal events
  const _laid=layoutCols([...stackEvents,...calEvents]);
  const blocks=_laid.map(e=>{
    const top=(e.mins-TL_START_MINS)*TL_SCALE;
    const isStack=e.type==='stack';
    const h=isStack?Math.max(32,(e.duration||0)*TL_SCALE):Math.max(32,(e.endMins-e.mins)*TL_SCALE);
    const pos=e._n>1?`left:calc(${e._c/e._n*100}% + 1px);width:calc(${100/e._n}% - 3px)`:`left:2px;right:2px`;
    const color=isStack?e.color:(e.color||'var(--cal)');
    const drag=e.draggable;
    if(isStack){
      return `<div ${drag?`ontouchstart="startWorkoutDrag(event)" onmousedown="startWorkoutDrag(event)"`:''}
        style="position:absolute;top:${top}px;height:${h}px;${pos};
          background:${color}${drag?'28':'18'};border-left:3px solid ${color};
          border-radius:0 6px 6px 0;padding:3px 6px;box-sizing:border-box;overflow:hidden;
          z-index:${drag?5:2};${drag?'cursor:grab;touch-action:none;user-select:none':''}">
        <div style="font-size:10px;color:${color};opacity:.7;line-height:1.2">${minsToFmt(e.mins)}</div>
        <div style="font-size:11px;font-weight:600;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3">
          ${drag?'<span style="opacity:.5;margin-right:2px">⠿</span>':''}${esc(e.label)}
          ${drag?`<button onclick="pushWorkoutToCalendar(event)" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()" style="margin-left:5px;background:none;border:none;cursor:pointer;padding:0;vertical-align:middle;opacity:.6" title="Add to Google Calendar"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></button>`:''}
        </div>
        ${h>=48?`<div style="font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.sub)}</div>`:''}
      </div>`;
    }
    return `<div style="position:absolute;top:${top}px;height:${h}px;${pos};
      background:${color}22;border-left:3px solid ${color};
      border-radius:0 6px 6px 0;padding:3px 6px;box-sizing:border-box;overflow:hidden;z-index:3">
      <div style="font-size:10px;color:${color};opacity:.7;line-height:1.2">${minsToFmt(e.mins)}</div>
      <div style="font-size:11px;font-weight:600;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3">${esc(e.label)}</div>
      ${h>=48?`<div style="font-size:10px;color:var(--text3)">${esc(e.source||'')}</div>`:''}
    </div>`;
  }).join('');

  const tl=`
    <div style="position:relative;display:flex;height:${totalH}px">
      <div style="width:44px;flex-shrink:0;position:relative">${hourLabels}</div>
      <div id="day-tl" style="flex:1;position:relative;border-left:1px solid var(--border)">
        ${hourLines}${nowLine}${blocks}
      </div>
    </div>`;

  return `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button onclick="setViewDay('today')" class="btn ${isToday?'btn-green':'btn-gray'}" style="flex:1;padding:10px">Today</button>
      <button onclick="setViewDay('tomorrow')" class="btn ${!isToday?'btn-green':'btn-gray'}" style="flex:1;padding:10px">Tomorrow</button>
    </div>
    ${calStatus}
    <div class="card" style="padding:12px 8px 12px 4px">${autoNotice}${tl}</div>
    <button class="btn btn-gray btn-full" onclick="fetchCalendars()" style="margin-bottom:12px">${state.calLoading?'Syncing...':'↻ Refresh calendars'}</button>
    ${banners}`;
}

function renderCalManager() {
  const ms=state.msStatus||{};
  const msAccounts=[
    {account:'bba',name:'BBA (Outlook)',connected:!!ms.bba},
    {account:'craft',name:'CRAFT (Outlook)',connected:!!ms.craft},
  ];
  return `
    <div class="card">
      <div class="card-title">Calendar sources</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Google Calendar</div>
      ${state.googleConnected
        ?`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--green)"></div>
              <span style="font-size:13px">Google Account</span>
            </div>
            <button onclick="disconnectGoogle()" class="btn btn-red" style="padding:4px 10px;font-size:12px">Disconnect</button>
          </div>
          ${state.googleCalendars.map((gc,i)=>{
            const added=state.calUrls.find(c=>c.type==='google'&&c.calendarId===gc.id);
            return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-left:16px">
              <div style="display:flex;align-items:center;gap:8px">
                <div style="width:8px;height:8px;border-radius:50%;background:${gc.color||'#A78BFA'}"></div>
                <span style="font-size:12px">${esc(gc.name)}${gc.primary?' ★':''}</span>
              </div>
              ${added
                ?`<button onclick="toggleGoogleCal(${i})" class="btn btn-red" style="padding:3px 8px;font-size:11px">Remove</button>`
                :`<button onclick="toggleGoogleCal(${i})" class="btn btn-blue" style="padding:3px 8px;font-size:11px">Add</button>`
              }
            </div>`;
          }).join('')}`
        :`<a href="${BACKEND}/auth/google/start" target="_blank" onclick="scheduleStatusRefresh()" class="btn btn-blue btn-full" style="text-decoration:none;display:block;text-align:center;margin-bottom:16px">Connect Google Account</a>`
      }
      <div style="font-size:11px;color:var(--text3);margin-bottom:8px;margin-top:8px;text-transform:uppercase;letter-spacing:.04em">Microsoft / Outlook</div>
      ${msAccounts.map(m=>`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:8px;height:8px;border-radius:50%;background:${m.connected?'var(--green)':'var(--text3)'}"></div>
            <span style="font-size:13px">${m.name}</span>
          </div>
          ${m.connected
            ?`<button onclick="disconnectMicrosoft('${m.account}')" class="btn btn-red" style="padding:4px 10px;font-size:12px">Disconnect</button>`
            :`<a href="${BACKEND}/auth/microsoft/start?account=${m.account}" target="_blank" onclick="scheduleStatusRefresh()" class="btn btn-blue" style="padding:4px 10px;font-size:12px;text-decoration:none">Connect</a>`
          }
        </div>`).join('')}
      ${state.ignoredConflicts.length?`
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:var(--text3)">${state.ignoredConflicts.length} dismissed overlap${state.ignoredConflicts.length>1?'s':''}</span>
          <button onclick="clearIgnoredConflicts()" class="btn btn-gray" style="padding:4px 10px;font-size:12px">Restore all</button>
        </div>
      </div>`:''}
    </div>`;
}

function renderCityMarketSettings() {
  const connected=state.krogerConnected;
  const authPanel=connected
    ?`<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex;align-items:center;gap:8px"><div class="status-dot" style="background:var(--green)"></div><span style="font-size:13px">City Market · Craig, CO</span></div><button class="btn btn-gray" onclick="disconnect()" style="padding:6px 12px;font-size:12px">Disconnect</button></div>`
    :state.authPending
    ?`<div><div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><div class="status-dot" style="background:var(--orange)"></div><span style="font-size:13px;color:var(--text2)">Waiting for authorization...</span></div><div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.6">Complete login in the browser window, then tap below.</div><div style="display:flex;gap:8px"><button class="btn btn-green" style="flex:1" onclick="manualPoll()">I've authorized — connect</button><button class="btn btn-gray" onclick="cancelAuth()">Cancel</button></div><div id="auth-error" style="margin-top:8px;font-size:12px;color:var(--danger)"></div></div>`
    :`<div><div style="font-size:12px;color:var(--text2);margin-bottom:12px">Connect your City Market account to push your grocery list to your cart.</div><button class="btn btn-blue btn-full" onclick="startAuth()">Connect City Market account</button></div>`;
  return `<div class="card"><div class="card-title" style="margin-bottom:${connected?'0':'12px'}">City Market</div>${authPanel}</div>`;
}

function renderWakeTimes() {
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const rows=days.map((d,i)=>{
    const isWeekend=i===0||i===6;
    const wfh=!!(state.wfhDays&&state.wfhDays[i]);
    return `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
      <div style="font-size:13px;color:var(--text2);width:32px;flex-shrink:0">${d}</div>
      ${renderTimePicker(`wake-${i}`, state.wakeOverrides[i]||'', `setWakeOverride(${i},time)`, { step: 300, allowClear: true })}
      ${isWeekend
        ?`<span style="flex-shrink:0;padding:3px 8px;font-size:11px;border-radius:6px;border:1px solid #7F77DD;background:rgba(127,119,221,.15);color:#7F77DD;white-space:nowrap">Weekend</span>`
        :`<button onclick="setWfhDay(${i},${!wfh})" style="flex-shrink:0;padding:3px 8px;font-size:11px;border-radius:6px;border:1px solid ${wfh?'var(--green)':'var(--blue)'};background:${wfh?'rgba(29,158,117,.15)':'rgba(55,138,221,.15)'};color:${wfh?'var(--green)':'var(--blue)'};cursor:pointer;white-space:nowrap">${wfh?'WFH':'Office'}</button>`
      }
      ${state.wakeOverrides[i]?`<button onclick="setWakeOverride(${i},'')" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0 4px;flex-shrink:0">×</button>`:'<div style="width:26px;flex-shrink:0"></div>'}
    </div>`;
  }).join('');
  return `<div class="card" style="margin-top:8px"><div class="card-title">Wake times</div>${rows}</div>`;
}

function renderThemePicker() {
  return `<div class="card" style="margin-top:8px">
    <div class="card-title">Appearance</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${Object.entries(THEMES).map(([k,t])=>`
        <button onclick="setTheme('${k}')" style="background:${t.bg2};border:2px solid ${state.theme===k?'var(--green)':t.border};border-radius:12px;padding:14px 10px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
          <div style="width:16px;height:16px;border-radius:50%;background:${t.bg};border:2px solid ${t.border};flex-shrink:0"></div>
          <span style="font-size:14px;font-weight:500;color:${t.text}">${t.name}</span>
        </button>`).join('')}
    </div>
  </div>`;
}

function renderFamilyAccessSettings() {
  const members = state.familyAccessList || [];
  const memberRows = members.length
    ? members.map(m => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${esc(m.name)}</div>
            <div style="font-size:11px;color:var(--text3)">${esc(m.email)}</div>
          </div>
          <button onclick="removeFamilyMember('${m.email.replace(/'/g,"\\'")}')"
            style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid var(--danger);background:rgba(226,75,74,.1);color:var(--danger);cursor:pointer">Remove</button>
        </div>`).join('')
    : `<div style="font-size:12px;color:var(--text3);padding:8px 0">No family members added yet</div>`;

  return `<div class="card" style="margin-top:8px">
    <div class="card-title">Family Grocery Access</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px">Family members can see the grocery list and manage their own items. Grocery-only access.</div>
    ${memberRows}
    <div style="margin-top:12px">
      <input id="fa-name" class="input" placeholder="Name (e.g. Jen)" style="margin-bottom:6px;font-size:13px"/>
      <input id="fa-email" class="input" placeholder="Google email address" style="margin-bottom:8px;font-size:13px"/>
      <button onclick="addFamilyMember(document.getElementById('fa-email').value,document.getElementById('fa-name').value);document.getElementById('fa-email').value='';document.getElementById('fa-name').value=''"
        class="btn btn-green btn-full">Add Family Member</button>
    </div>
  </div>`;
}

function renderNutritionistAccessSettings() {
  const members = state.nutritionistAccessList || [];
  const memberRows = members.length
    ? members.map(m => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${esc(m.name)}</div>
            <div style="font-size:11px;color:var(--text3)">${esc(m.email)}</div>
          </div>
          <button onclick="removeNutritionist('${m.email.replace(/'/g,"\\'")}')"
            style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid var(--danger);background:rgba(226,75,74,.1);color:var(--danger);cursor:pointer">Remove</button>
        </div>`).join('')
    : `<div style="font-size:12px;color:var(--text3);padding:8px 0">No nutritionists added yet</div>`;

  return `<div class="card" style="margin-top:8px">
    <div class="card-title">Nutritionist Access</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px">Nutritionists get read-only access to your macro logs. They cannot see or change anything else.</div>
    ${memberRows}
    <div style="margin-top:12px">
      <input id="na-name" class="input" placeholder="Name (e.g. Dr. Lee)" style="margin-bottom:6px;font-size:13px"/>
      <input id="na-email" class="input" placeholder="Google email address" style="margin-bottom:8px;font-size:13px"/>
      <button onclick="addNutritionist(document.getElementById('na-email').value,document.getElementById('na-name').value);document.getElementById('na-email').value='';document.getElementById('na-name').value=''"
        class="btn btn-green btn-full">Add nutritionist</button>
    </div>
  </div>`;
}

function renderAdminSettings() {
  const r = state.backfillResult;
  let resultHtml = '';
  if (r) {
    if (r.error) {
      resultHtml = `<div style="font-size:12px;color:var(--danger);margin-top:8px">${esc(r.error)}</div>`;
    } else {
      const errCount = (r.errors || []).length;
      const summary = `Updated ${r.updated} of ${r.total} recipes.${errCount ? ` ${errCount} error${errCount > 1 ? 's' : ''}.` : ''}`;
      const errToggle = errCount
        ? `<button onclick="state.backfillErrorsOpen=!state.backfillErrorsOpen;render()" style="background:none;border:none;color:var(--blue);font-size:11px;cursor:pointer;padding:0;margin-top:4px">${state.backfillErrorsOpen ? 'Hide' : 'Show'} errors</button>`
        : '';
      const errList = errCount && state.backfillErrorsOpen
        ? `<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">${r.errors.map(e => `<div style="font-size:11px;color:var(--text3);padding:2px 0">${esc(e.name || e.id)} — ${esc(e.error)}</div>`).join('')}</div>`
        : '';
      resultHtml = `<div style="font-size:12px;color:var(--text2);margin-top:8px">${esc(summary)}</div>${errToggle}${errList}`;
    }
  }
  return `<div class="card" style="margin-top:8px">
    <div class="card-title">Admin</div>
    <button onclick="backfillRecipeComponents()" class="btn btn-gray btn-full" ${state.backfillRunning ? 'disabled' : ''}>
      ${state.backfillRunning ? 'Backfilling components…' : 'Backfill recipe components'}
    </button>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">Adds component data to older recipes so they can be logged piece-by-piece.</div>
    ${resultHtml}
  </div>`;
}

function renderSettings() {
  const familySection = state.userRole === 'owner' ? renderFamilyAccessSettings() : '';
  const nutriSection  = state.userRole === 'owner' ? renderNutritionistAccessSettings() : '';
  const adminSection  = state.userRole === 'owner' ? renderAdminSettings() : '';
  // Read-only nutritionist sees only Appearance + Sign Out — no owner config sections.
  const ownerConfig = state.userRole === 'nutritionist' ? '' : renderCalManager() + renderCityMarketSettings() + renderWakeTimes();
  return ownerConfig + renderThemePicker() + familySection + nutriSection + adminSection + `<div class="card" style="margin-top:8px"><button class="btn btn-red btn-full" onclick="logout()">Sign Out</button></div>`;
}

// ── MACROS ──
function renderLogPanel(slot, color) {
  const subTab = state.logPanel?.subTab || 'recipes';
  const tabs = [['prepared','Prepared'],['staples','Staples'],['recipes','Recipes'],['pantry','Pantry'],['search','Search'],['custom','Custom']].map(([t,l]) =>
    `<button onclick="setLogPanelSubTab('${t}')"
      style="flex:1;padding:6px 4px;font-size:11px;border-radius:8px;border:1px solid ${subTab===t?color:'var(--border)'};background:${subTab===t?color+'22':'var(--bg3)'};color:${subTab===t?color:'var(--text3)'};cursor:pointer">${l}</button>`
  ).join('');
  const tabBar = `<div style="display:flex;gap:6px;margin:10px 0">${tabs}</div>`;

  if (subTab === 'prepared') {
    const available = state.preparedMeals.filter(p => p.portionsRemaining > 0);
    if (!available.length) {
      return `${tabBar}<div style="font-size:12px;color:var(--text3);padding:6px 0">No prepared meals — open a recipe and tap "Prepare (meal prep)" to cook in advance.</div>`;
    }
    const cards = available.map(pm => {
      const srv = Math.min(state.logPanelServings[pm.id] || 1, pm.portionsRemaining);
      const m = pm.portionMacros;
      const prepDate = new Date(pm.preparedAt).toLocaleDateString('en-US', { month:'short', day:'numeric' });
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:5px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600">${esc(pm.recipeName)}
              <span style="font-size:10px;color:var(--orange);margin-left:5px">● Prepped ${prepDate}</span>
            </div>
            <div style="font-size:11px;color:var(--text3)">${m.blended ? '~' : ''}${Math.round(m.kcal * srv)} kcal · ${m.blended ? '~' : ''}${Math.round(m.protein * srv * 10)/10}g P · ${m.blended ? '~' : ''}${Math.round(m.carbs * srv * 10)/10}g C · ${m.blended ? '~' : ''}${Math.round(m.fat * srv * 10)/10}g F</div>
            <div style="font-size:10px;color:var(--text3)">${pm.portionsRemaining} portion${pm.portionsRemaining !== 1 ? 's' : ''} remaining</div>
          </div>
          <button onclick="discardPreparedMeal('${pm.id}')" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:2px 4px;flex-shrink:0" title="Discard remaining portions">×</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="font-size:11px;color:var(--text3)">Servings:</span>
          <button onclick="setPreparedServings('${pm.id}',${(state.logPanelServings[pm.id]||1)-0.125})" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
          <span style="font-size:13px;font-weight:600;min-width:16px;text-align:center">${fmtPortion(srv)}</span>
          <button onclick="setPreparedServings('${pm.id}',${(state.logPanelServings[pm.id]||1)+0.125})" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
          <span style="font-size:10px;color:var(--text3)">(max ${pm.portionsRemaining})</span>
        </div>
        <div style="display:flex;gap:6px">
          <button onclick="logPreparedMeal('${pm.id}','${slot}')" class="btn btn-green" style="flex:1;font-size:12px;padding:5px">Log (me)</button>
          <button onclick="othersAtePrepared('${pm.id}')" style="flex:1;padding:5px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:12px;cursor:pointer">Others ate</button>
        </div>
      </div>`;
    }).join('');
    return tabBar + cards;
  }

  if (subTab === 'staples') {
    const cards = STAPLES.map((s, si) => {
      const curPortion = state.staplePortion[si] || 1;
      const portBtns = PORTION_OPTIONS.map(p => {
        const sel = Math.abs(curPortion - p.v) < 0.01;
        return `<button onclick="setStaplePortion(${si},${p.v})"
          style="padding:3px 8px;border-radius:6px;border:1px solid ${sel?color:'var(--border)'};background:${sel?color+'22':'var(--bg3)'};color:${sel?color:'var(--text2)'};font-size:11px;cursor:pointer;font-weight:${sel?'600':'400'}">${p.label}</button>`;
      }).join('');
      const q = curPortion;
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:5px">
          <div>
            <div style="font-size:12px;font-weight:600">${esc(s.name)}</div>
            <div style="font-size:11px;color:var(--text3)">${Math.round(s.kcal*q)} kcal · ${Math.round(s.protein*q*10)/10}g P · ${Math.round(s.carbs*q*10)/10}g C · ${Math.round(s.fat*q*10)/10}g F</div>
          </div>
          <button onclick="addMeal(${si},'${slot}')" class="btn btn-green" style="padding:3px 10px;font-size:12px;flex-shrink:0">Log</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">${portBtns}</div>
      </div>`;
    }).join('');
    return tabBar + cards;
  }

  if (subTab === 'recipes') {
    // Show all recipes regardless of mealType so out-of-slot recipes (e.g. a dinner
    // eaten at lunch) remain loggable. Recipes matching the current slot sort first,
    // then by pantry availability.
    const list = state.recipes.slice().sort((a, b) => {
      const aMatch = (a.mealType || 'dinner') === slot;
      const bMatch = (b.mealType || 'dinner') === slot;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return hasPantryIngredients(b) - hasPantryIngredients(a);
    });
    if (!list.length) return `${tabBar}<div style="font-size:12px;color:var(--text3);padding:6px 0">No recipes saved yet — generate some in the Recipes tab.</div>`;
    // Subtle meal-type badge (mirrors renderRecipeDetail's mealTag) so users can see
    // at a glance when they're logging an out-of-type recipe.
    const mealColors = { breakfast:'#1D9E75', lunch:'#378ADD', dinner:'#EF9F27', snack:'#7F77DD' };
    const mealLabels = { breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snack' };
    const cards = list.map(r => {
      const p = r.perServing;
      const inPantry = hasPantryIngredients(r);
      const inPantryBadge = inPantry ? '<span style="font-size:10px;color:var(--green);margin-left:5px">● In pantry</span>' : '';
      const rmt = r.mealType || 'dinner';
      const mc = mealColors[rmt] || 'var(--text3)';
      const mealBadge = `<span style="font-size:9px;padding:1px 6px;border-radius:8px;background:${mc}22;color:${mc};margin-left:5px">${mealLabels[rmt] || rmt}</span>`;

      // Recipes with components log piece-by-piece; legacy recipes keep the single-unit UI.
      if (r.components?.length) {
        return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">${esc(r.name)}${mealBadge}${inPantryBadge}<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(138,110,255,.15);color:#8a6eff;margin-left:5px">components</span></div>
          ${renderRecipeComponentLog(r, slot, color)}
        </div>`;
      }

      const srv = state.logPanelServings[r.id] || 1;
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:5px">
          <div>
            <div style="font-size:12px;font-weight:600">${esc(r.name)}${mealBadge}${inPantryBadge}</div>
            <div style="font-size:11px;color:var(--text3)">${Math.round(p.kcal*srv)} kcal · ${Math.round(p.protein*srv)}g P · ${Math.round(p.carbs*srv)}g C · ${Math.round(p.fat*srv)}g F</div>
          </div>
          <button onclick="logRecipeAsMeal('${r.id}','${slot}')" class="btn btn-green" style="padding:3px 10px;font-size:12px;flex-shrink:0">Log</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text3)">Servings:</span>
          <button onclick="setLogPanelServings('${r.id}',${srv-0.125})" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
          <input type="number" min="0.125" step="0.125" value="${srv}"
            style="width:48px;padding:2px 4px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;font-weight:600;text-align:center"
            onchange="setLogPanelServings('${r.id}',this.value)" />
          <button onclick="setLogPanelServings('${r.id}',${srv+0.125})" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
        </div>
      </div>`;
    }).join('');
    return tabBar + cards;
  }

  if (subTab === 'pantry') {
    const available = state.pantry.filter(p => p.remaining > 0);
    if (!available.length) {
      return `${tabBar}<div style="font-size:12px;color:var(--text3);padding:6px 0">No pantry items — add items via the Grocery tab.</div>`;
    }
    const sorted = available.slice().sort((a, b) =>
      (a.krogerName || a.ingredientName).localeCompare(b.krogerName || b.ingredientName)
    );
    const cards = sorted.map(p => {
      const hasNutrition = !!p.fsFood?.servings?.[0];
      const srv = state.logPanelServings[p.id] || 1;
      const serving = p.fsFood?.servings?.[0];
      const n = serving?.nutrition;
      const fmt = v => v % 1 === 0 ? v : parseFloat(v.toFixed(1));
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:${hasNutrition ? '5' : '0'}px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600">${esc(p.krogerName || p.ingredientName)}
              <span style="font-size:10px;color:var(--text3);margin-left:4px">${(p.portionsPerUnit || 1) !== 1 ? `${fmt(Math.round(p.remaining * (p.portionsPerUnit || 1) * 10) / 10)} portions left` : `${fmt(p.remaining)} left`}</span>
            </div>
            ${hasNutrition
              ? `<div style="font-size:10px;color:var(--text3)">${esc(_servingLabel(serving))}</div>
                 <div style="font-size:11px;color:var(--text3)">${Math.round(n.kcal*srv)} kcal · ${Math.round(n.protein*srv*10)/10}g P · ${Math.round(n.carbs*srv*10)/10}g C · ${Math.round(n.fat*srv*10)/10}g F</div>`
              : `<div style="font-size:10px;color:var(--text3);font-style:italic">No nutrition data</div>`}
          </div>
          ${hasNutrition
            ? `<button onclick="logPantryItemAsMeal('${p.id}','${slot}')" class="btn btn-green" style="padding:3px 10px;font-size:12px;flex-shrink:0">Log</button>`
            : ''}
        </div>
        ${hasNutrition ? `<div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text3)">Servings:</span>
          <button onclick="setPreparedServings('${p.id}',${srv-0.125})" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
          <span style="font-size:13px;font-weight:600;min-width:16px;text-align:center">${fmtPortion(srv)}</span>
          <button onclick="setPreparedServings('${p.id}',${srv+0.125})" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
        </div>` : ''}
      </div>`;
    }).join('');
    return tabBar + cards;
  }

  if (subTab === 'search') return tabBar + renderFsSearchTab(slot);

  // Custom
  const fields = ['name','kcal','protein','carbs','fat'].map(f =>
    `<input class="input" placeholder="${f.charAt(0).toUpperCase()+f.slice(1)}" oninput="state.customMeal.${f}=this.value" value="${state.customMeal[f]}"/>`
  ).join('');
  return `${tabBar}<div style="display:flex;flex-direction:column;gap:8px">${fields}<button class="btn btn-green" onclick="logCustomMeal()">Log meal</button></div>`;
}

function renderMealSlot(slot, label, color) {
  const ro = state.userRole === 'nutritionist';
  const tgt = MEAL_TARGETS[slot];
  const slotMeals = state.meals.filter(m => (m.mealSlot||'other') === slot);
  const stRaw = slotMeals.reduce((a,m)=>({kcal:a.kcal+m.kcal,protein:a.protein+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat}),{kcal:0,protein:0,carbs:0,fat:0});
  const st = {kcal:Math.round(stRaw.kcal),protein:roundMacro(stRaw.protein),carbs:roundMacro(stRaw.carbs),fat:roundMacro(stRaw.fat)};
  const isOpen = state.logPanel?.slot === slot;
  const over = st.kcal > tgt.kcal * 1.1;
  const met  = st.kcal >= tgt.kcal * 0.85;
  const kcalColor = over ? 'var(--danger)' : met ? color : 'var(--text3)';

  const mealRows = slotMeals.length
    ? slotMeals.map(m => {
        const i = state.meals.indexOf(m);
        const logTime = m.loggedAt ? new Date(m.loggedAt).toLocaleTimeString('en-US',{timeZone:'America/Denver',hour:'numeric',minute:'2-digit',hour12:true}) : '';
        const logTimeInput = m.loggedAt ? (() => { const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(m.loggedAt)); return (p.find(x=>x.type==='hour').value+':'+p.find(x=>x.type==='minute').value).replace(/^24/,'00'); })() : '';
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px">${esc(m.name)}${m.fromPrepared ? '<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(239,159,39,.15);color:var(--orange);margin-left:5px">prepped</span>' : m.fromPantry ? '<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(29,158,117,.15);color:var(--green);margin-left:5px">pantry</span>' : m.blended ? '<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(138,110,255,.15);color:#8a6eff;margin-left:5px">~est.</span>' : ''}</div>
            ${logTime?`<div style="margin-top:2px">${renderTimePicker(`meal-${m.id}`,logTimeInput,`setMealTime(${m.id},time)`)}</div>`:''}
            <div style="font-size:11px;color:var(--text3)">${m.blended ? '~' : ''}${m.kcal} kcal · ${m.blended ? '~' : ''}${m.protein}g P · ${m.blended ? '~' : ''}${m.carbs}g C · ${m.blended ? '~' : ''}${m.fat}g F</div>
            ${renderMealNutritionPills(m)}
          </div>
          ${ro ? '' : `<button onclick="removeMeal(${i})" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:4px;flex-shrink:0">×</button>`}
        </div>`;
      }).join('')
    : `<div style="font-size:12px;color:var(--text3);padding:4px 0 6px">Nothing logged yet</div>`;

  const totRow = slotMeals.length ? `
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding:6px 0 2px;border-top:1px solid var(--border)">
      <span style="font-size:11px;font-weight:600;color:${kcalColor}">${st.kcal}/${tgt.kcal} kcal</span>
      <span style="font-size:11px;color:var(--text3)">${st.protein}/${tgt.protein}g P</span>
      <span style="font-size:11px;color:var(--text3)">${st.carbs}/${tgt.carbs}g C</span>
      <span style="font-size:11px;color:var(--text3)">${st.fat}/${tgt.fat}g F</span>
    </div>` : '';

  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:10px;height:10px;border-radius:50%;background:${color}"></div>
        <span class="card-title" style="margin:0;color:${color}">${label}</span>
        <span style="font-size:11px;color:var(--text3)">${tgt.kcal} kcal target</span>
      </div>
      ${ro ? '' : `<button onclick="${isOpen?'closeLogPanel()':'openLogPanel(\''+slot+'\')'}"
        class="btn ${isOpen?'btn-gray':'btn-green'}" style="padding:3px 10px;font-size:12px">
        ${isOpen ? 'Done' : '+ Log'}
      </button>`}
    </div>
    ${mealRows}${totRow}
    ${(!ro && isOpen) ? `<div style="border-top:1px solid var(--border);margin-top:4px">${renderLogPanel(slot,color)}</div>` : ''}
  </div>`;
}

// Windowed water logger (fluid ounces) — hard 7 PM cutoff. Rendered into the
// bottom drawer on the Macros tab: a peeking summary handle + an expandable body
// of per-window rows. Each WATER_WINDOWS window is tracked and logged
// independently; the active window (by clock time, today only) is highlighted.
// Read-only for the nutritionist role.
function renderWaterDrawer() {
  const ro = state.userRole === 'nutritionist';
  const c = '#38BDF8';
  const dateStr = getMacroDateStr();
  const isToday = dateStr === todayDateStr();
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  const ws  = (state.workoutOverrides && state.workoutOverrides[dow]) || WORKOUT_START;
  const resolveEnd = e => e === 'ws' ? ws : e === 'ws+70' ? ws + 70 : e;

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const logged = state.waterWindows || {};
  const totalLogged = Object.values(logged).reduce((a, b) => a + (b || 0), 0);
  const pTotal = Math.min(100, Math.round(totalLogged / WATER_TARGET * 100));

  const addBtn = (id, amt, label, primary) => `<button onclick="addWater('${id}', ${amt})"
    style="padding:4px 9px;border-radius:7px;border:1px solid ${primary?c:'var(--border)'};background:${primary?'rgba(56,189,248,.15)':'var(--bg3)'};color:${primary?c:'var(--text2)'};font-size:12px;cursor:pointer;font-weight:${primary?'600':'400'};line-height:1.2">${label}</button>`;

  let prevEnd = 0;
  const rows = WATER_WINDOWS.map(w => {
    const start = prevEnd, end = resolveEnd(w.end);
    prevEnd = end;
    const active = isToday && nowMins >= start && nowMins < end;
    const got    = logged[w.id] || 0;
    const sipsOnly = w.target == null;

    const targetLabel = sipsOnly
      ? `<span style="font-size:11px;color:var(--text3);font-style:italic">Sips only</span>`
      : `<span style="font-size:12px;font-weight:600;color:${got>=w.target?c:'var(--text2)'}">${got}<span style="font-size:10px;color:var(--text3);font-weight:400"> / ${w.target} oz</span></span>`;

    const bar = sipsOnly ? '' :
      `<div class="bar-track" style="height:5px;margin-top:5px"><div class="bar-fill" style="width:${Math.min(100, Math.round(got / w.target * 100))}%;background:${c}"></div></div>`;

    // Log in 4 oz steps (4, 8, 12, 16, …). −4 appears only once there's something to subtract.
    const controls = ro ? '' : `
      <div style="display:flex;gap:5px;margin-top:6px">
        ${got > 0 ? addBtn(w.id, -4, '−4 oz', false) : ''}
        ${addBtn(w.id, 4, '+4 oz', !sipsOnly)}
      </div>`;

    const noteHtml = w.note ? `<span style="font-size:10px;color:var(--text3)"> · ${w.note}</span>` : '';
    return `<div style="padding:9px 10px;border-radius:10px;margin-top:8px;
        border:1px solid ${active?c:'var(--border)'};
        background:${active?'rgba(56,189,248,.07)':'transparent'}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-size:12px;color:var(--text)">${active?'▸ ':''}${w.label}${noteHtml}</span>
        ${targetLabel}
      </div>
      ${bar}
      ${controls}
    </div>`;
  }).join('');

  const handle = `
    <div class="weekly-drawer-handle" onclick="toggleWaterDrawer()">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <span style="font-size:13px;font-weight:600;color:${c}">💧 Water</span>
        <span style="font-size:12px;color:var(--text2);white-space:nowrap">${totalLogged} / ${WATER_TARGET} oz</span>
        <div class="bar-track" style="flex:1;max-width:140px;height:5px"><div class="bar-fill" style="width:${pTotal}%;background:${c}"></div></div>
      </div>
      <svg class="weekly-drawer-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>`;

  const body = `<div class="weekly-drawer-body">
    <div style="font-size:11px;color:var(--text3);margin-bottom:2px">Hard 7 PM cutoff · front-load early, sip after</div>
    ${rows}
  </div>`;

  return handle + body;
}

function renderMacros() {
  // Read-only mode for the nutritionist role: no logging affordances, view only.
  const ro = state.userRole === 'nutritionist';
  // Date navigator
  const dateStr = getMacroDateStr();
  const todayStr = todayDateStr();
  const isToday = dateStr === todayStr;
  const yd = new Date(todayStr + 'T12:00:00'); yd.setDate(yd.getDate()-1);
  const yStr = `${yd.getFullYear()}-${String(yd.getMonth()+1).padStart(2,'0')}-${String(yd.getDate()).padStart(2,'0')}`;
  const dateLabel = isToday ? 'Today' : dateStr === yStr ? 'Yesterday'
    : new Date(dateStr+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const dateNav = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <button onclick="navMacroDate(-1)" style="width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center">‹</button>
      <div style="text-align:center">
        <div style="font-size:15px;font-weight:600">${dateLabel}</div>
        <div style="font-size:11px;color:var(--text3)">${dateStr}</div>
      </div>
      <button onclick="navMacroDate(1)" ${isToday?'disabled':''}
        style="width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:18px;display:flex;align-items:center;justify-content:center;cursor:${isToday?'default':'pointer'};opacity:${isToday?0.3:1}">›</button>
    </div>`;

  if (state.mealsLoading) return dateNav + `<div class="card" style="text-align:center;padding:24px"><div style="font-size:13px;color:var(--text2)">Loading...</div></div>`;

  // ── Quick food log (FatSecret search → any meal slot) ──
  const quickLog = ro ? '' : (() => {
    if (!state.fsQuickLogOpen) {
      return `<div style="margin-bottom:12px">
        <button onclick="state.fsQuickLogOpen=true;render()"
          style="width:100%;padding:10px;border-radius:12px;border:1px dashed var(--border);background:var(--bg2);color:var(--text2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          Search &amp; log food to any meal
        </button>
      </div>`;
    }
    const slots = ['breakfast','lunch','dinner','snack','other'];
    const slotLabels = {breakfast:'Breakfast',lunch:'Lunch',dinner:'Dinner',snack:'Snack',other:'Other'};
    const cur = state.fsQuickLogSlot || 'other';
    const slotPills = slots.map(s =>
      `<button onclick="state.fsQuickLogSlot='${s}';render()"
        style="padding:5px 10px;border-radius:8px;border:1px solid ${cur===s?'var(--green)':'var(--border)'};background:${cur===s?'rgba(29,158,117,.15)':'var(--bg3)'};color:${cur===s?'var(--green)':'var(--text3)'};font-size:12px;cursor:pointer">${slotLabels[s]}</button>`
    ).join('');
    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="card-title" style="margin:0">Log Food</div>
        <button onclick="state.fsQuickLogOpen=false;state.fsFood=null;state.fsQuery='';state.fsResults=[];render()"
          style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0;line-height:1">×</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${slotPills}</div>
      ${renderFsSearchTab(cur)}
    </div>`;
  })();

  const t = totals();
  const cards = [
    {l:'Calories',v:t.kcal,tgt:MACROS.kcal,c:'#D85A30',u:'kcal'},
    {l:'Protein', v:t.protein,tgt:MACROS.protein,c:'#1D9E75',u:'g'},
    {l:'Carbs',   v:t.carbs,tgt:MACROS.carbs,c:'#378ADD',u:'g'},
    {l:'Fat',     v:t.fat,tgt:MACROS.fat,c:'#EF9F27',u:'g'},
  ].map(m=>`<div class="macro-card"><div class="macro-val" style="color:${m.v>m.tgt*1.1?'#E24B4A':m.c}">${m.v}</div><div class="macro-lbl">/${m.tgt}${m.u}</div><div class="macro-lbl">${m.l}</div></div>`).join('');
  const bars = [
    {l:'Calories',v:t.kcal,tgt:MACROS.kcal,c:'#D85A30'},
    {l:'Protein', v:t.protein,tgt:MACROS.protein,c:'#1D9E75'},
    {l:'Carbs',   v:t.carbs,tgt:MACROS.carbs,c:'#378ADD'},
    {l:'Fat',     v:t.fat,tgt:MACROS.fat,c:'#EF9F27'},
  ].map(m=>`<div class="bar-wrap"><div class="bar-label"><span style="color:var(--text2)">${m.l}</span><span>${m.v}/${m.tgt}</span></div><div class="bar-track"><div class="bar-fill" style="width:${pct(m.v,m.tgt)}%;background:${m.c}"></div></div></div>`).join('');

  const slots = [
    {slot:'breakfast',label:'Breakfast',color:'#1D9E75'},
    {slot:'lunch',    label:'Lunch',    color:'#378ADD'},
    {slot:'dinner',   label:'Dinner',   color:'#EF9F27'},
    {slot:'snack',    label:'Snacks',   color:'#7F77DD'},
  ];

  const otherMeals = state.meals.filter(m => !m.mealSlot || m.mealSlot === 'other');
  const otherSection = otherMeals.length ? `<div class="card">
    <div class="card-title">Other</div>
    ${otherMeals.map(m => {
      const i = state.meals.indexOf(m);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <div><div style="font-size:12px">${esc(m.name)}</div><div style="font-size:11px;color:var(--text3)">${m.kcal} kcal · ${m.protein}g P · ${m.carbs}g C · ${m.fat}g F</div></div>
        ${ro ? '' : `<button onclick="removeMeal(${i})" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:4px">×</button>`}
      </div>`;
    }).join('')}
  </div>` : '';

  const clearBtn = (!ro && state.meals.length)
    ? `<button class="btn btn-gray btn-full" style="margin-top:4px" onclick="clearMeals()">Clear all logged meals</button>` : '';

  return dateNav + quickLog + `<div class="macro-grid">${cards}</div><div class="card">${bars}</div>${slots.map(s=>renderMealSlot(s.slot,s.label,s.color)).join('')}${otherSection}${renderDailyNutritionCard()}${clearBtn}`;
}

// ── RECIPES ──
function renderRecipes() {
  if (state.recipeView) {
    const recipe = state.recipes.find(r => r.id === state.recipeView);
    if (!recipe) { state.recipeView = null; return renderRecipes(); }
    return `<div class="card">${renderRecipeDetail(recipe, false)}</div>`;
  }

  const subTabs = `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button onclick="setRecipeSubTab('library')" class="btn ${state.recipeSubTab==='library'?'btn-green':'btn-gray'}" style="flex:1;padding:10px">Library (${state.recipes.length})</button>
      <button onclick="setRecipeSubTab('generate')" class="btn ${state.recipeSubTab==='generate'?'btn-green':'btn-gray'}" style="flex:1;padding:10px">✦ Generate</button>
      <button onclick="setRecipeSubTab('import')" class="btn ${state.recipeSubTab==='import'?'btn-green':'btn-gray'}" style="flex:1;padding:10px">⬇ Import</button>
      <button onclick="setRecipeSubTab('create')" class="btn ${state.recipeSubTab==='create'?'btn-green':'btn-gray'}" style="flex:1;padding:10px">＋ Create</button>
    </div>`;

  if (state.recipeSubTab === 'library') {
    const weeklyRecipes = state.recipes.filter(r => state.weeklyPlan.has(r.id));
    // Weekly plan content moved to bottom drawer — not rendered inline

    const mealTypes = [
      { key:'breakfast', label:'Breakfast', color:'#1D9E75' },
      { key:'lunch',     label:'Lunch',     color:'#378ADD' },
      { key:'dinner',    label:'Dinner',    color:'#EF9F27' },
      { key:'snack',     label:'Snacks',    color:'#7F77DD' },
    ];
    const grouped = mealTypes.map(mt => {
      const rs = state.recipes.filter(r => (r.mealType || 'dinner') === mt.key);
      if (!rs.length) return '';
      const cuisines = [...new Set(rs.map(r => r.cuisine))];
      const byC = cuisines.map(c => {
        const crs = rs.filter(r => r.cuisine === c);
        return `<div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 2px">${c}</div>
          ${crs.map(renderRecipeCard).join('')}
        </div>`;
      }).join('');
      return `<div class="card">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <div style="width:10px;height:10px;border-radius:50%;background:${mt.color}"></div>
          <div class="card-title" style="margin:0;color:${mt.color}">${mt.label}</div>
          <span style="font-size:11px;color:var(--text3);margin-left:auto">${rs.length} recipe${rs.length!==1?'s':''}</span>
        </div>
        ${byC}
      </div>`;
    }).join('');

    const empty = !state.recipes.length
      ? `<div class="card" style="text-align:center;padding:32px 16px">
          <div style="font-size:13px;color:var(--text2);margin-bottom:6px">No recipes saved yet</div>
          <div style="font-size:12px;color:var(--text3)">Tap Generate to create your first recipe</div>
          <button onclick="setRecipeSubTab('generate')" class="btn btn-green" style="margin-top:14px">✦ Generate a recipe</button>
        </div>` : '';

    const verifyLabel = state.nutriVerifyRunning && state.nutriVerifyProgress
      ? `Verifying… ${state.nutriVerifyProgress.done}/${state.nutriVerifyProgress.total}`
      : !state.nutriVerifyRunning && state.nutriVerifyProgress
        ? `✓ Verified — ${state.nutriVerifyProgress.fixed} recipe${state.nutriVerifyProgress.fixed !== 1 ? 's' : ''} updated`
        : 'Verify nutrition';
    const normalizeBtn = state.userRole === 'owner'
      ? `<div style="text-align:right;margin-bottom:8px;display:flex;gap:6px;justify-content:flex-end">
          <button onclick="backfillRecipeNutrition()" ${state.nutriVerifyRunning ? 'disabled' : ''}
            style="font-size:10px;padding:3px 10px;border-radius:6px;border:1px solid var(--green);background:rgba(29,158,117,.08);color:var(--green);cursor:pointer">
            ${verifyLabel}
          </button>
          <button onclick="normalizeStoredRecipes()"
            style="font-size:10px;padding:3px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text3);cursor:pointer">
            Normalize ingredient data
          </button>
        </div>`
      : '';
    return subTabs + normalizeBtn + empty + grouped;
  }

  if (state.recipeSubTab === 'import') {
    const imp = state.recipeImport;
    const spinner = '<span style="display:flex;align-items:center;justify-content:center;gap:8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Importing… (this can take 5-10s)</span>';
    const importForm = `<div class="card">
      <div class="card-title">Import recipe from URL</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Paste a link to any recipe page — it'll be extracted, macro-estimated, and formatted for your library.</div>
      <input class="input" type="url" placeholder="https://www.allrecipes.com/recipe/..."
        style="margin-bottom:10px;width:100%;box-sizing:border-box"
        oninput="state.recipeImport.url=this.value" value="${esc(imp.url)}"/>
      <button onclick="importRecipeFromUrl()" class="btn btn-green btn-full" ${imp.loading?'disabled':''}>
        ${imp.loading ? spinner : '⬇ Import recipe'}
      </button>
      ${imp.error ? `<div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(220,80,80,.12);border:1px solid rgba(220,80,80,.4);color:#e88;font-size:12px">${esc(imp.error)}</div>` : ''}
    </div>`;
    const preview = state.generatedRecipe ? `
      <div class="card" style="border-color:var(--green)">
        <div style="font-size:11px;font-weight:600;color:var(--green);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">⬇ Imported from ${esc(imp.source || 'the web')} — review before saving</div>
        ${renderRecipeDetail(state.generatedRecipe, true)}
      </div>` : '';
    return subTabs + importForm + preview;
  }

  if (state.recipeSubTab === 'create') return subTabs + renderRecipeCreate();

  // Generate sub-tab
  const mealTypeOpts = [['dinner','Dinner (family)'],['breakfast','Breakfast (solo)'],['lunch','Lunch (solo)'],['snack','Snack (solo)']].map(([v,l]) =>
    `<option value="${v}" ${state.recipeGenForm.mealType===v?'selected':''}>${l}</option>`).join('');
  const cuisineOpts = ['','Mexican','Asian','American','Italian'].map(c =>
    `<option value="${c}" ${state.recipeGenForm.cuisine===c?'selected':''}>${c||'Any cuisine'}</option>`).join('');
  const timeOpts = [['','Any time'],['15','Under 15 min'],['20','Under 20 min'],['35','Under 35 min'],['45','Under 45 min'],['90','Weekend project']].map(([v,l]) =>
    `<option value="${v}" ${state.recipeGenForm.cookTime===v?'selected':''}>${l}</option>`).join('');

  const genForm = `<div class="card">
    <div class="card-title">Generate a new recipe</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <select class="input" style="flex:1" onchange="state.recipeGenForm.mealType=this.value">${mealTypeOpts}</select>
      <select class="input" style="flex:1" onchange="state.recipeGenForm.cuisine=this.value">${cuisineOpts}</select>
    </div>
    <select class="input" style="margin-bottom:10px;width:100%" onchange="state.recipeGenForm.cookTime=this.value">${timeOpts}</select>
    <input class="input" placeholder="What sounds good? (spicy, comfort food, Cuban...)"
      style="margin-bottom:10px;width:100%;box-sizing:border-box"
      oninput="state.recipeGenForm.notes=this.value" value="${state.recipeGenForm.notes}"/>
    <button onclick="generateRecipe()" class="btn btn-green btn-full" ${state.recipeGenerating?'disabled':''}>
      ${state.recipeGenerating
        ? '<span style="display:flex;align-items:center;justify-content:center;gap:8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Generating...</span>'
        : '✦ Generate recipe'}
    </button>
  </div>`;

  const preview = state.generatedRecipe ? `
    <div class="card" style="border-color:var(--green)">
      <div style="font-size:11px;font-weight:600;color:var(--green);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">✦ AI Generated — Review & Save</div>
      ${renderRecipeDetail(state.generatedRecipe, true)}
    </div>` : '';

  return subTabs + genForm + preview;
}

// ── GROCERY ──
function _renderGroceryCheckItem(item, k) {
  const chk = state.checked[k];
  return `<div class="grocery-item" onclick="toggleCheck('${k}')">
    <div class="check-box" style="border-color:${chk?'var(--green)':'var(--border)'};background:${chk?'rgba(29,158,117,.2)':'transparent'}">
      ${chk?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1D9E75" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>':''}
    </div>
    <span style="font-size:13px;color:${chk?'var(--text3)':'var(--text)'};text-decoration:${chk?'line-through':'none'}">${item}</span>
  </div>`;
}

function _renderItemRow(it, removeCall, qtyCall) {
  const isObj = typeof it === 'object' && it !== null;
  const id    = isObj ? it.id : it;
  const name  = isObj ? (it.krogerName || it.name) : it;
  const size  = isObj && it.krogerSize ? ` · ${it.krogerSize}` : '';
  const qty   = isObj ? (it.qty || 1) : 1;
  const kcal  = isObj && it.fsFood?.servings?.[0] ? `${Math.round(it.fsFood.servings[0].nutrition.kcal)} kcal/srv` : null;
  const note  = isObj && it.notes ? it.notes : null;
  const safeName = esc(name);
  return `<div style="padding:7px 0;border-bottom:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px">${safeName}${size ? `<span style="font-size:11px;color:var(--text3)">${esc(size)}</span>` : ''}</div>
        ${kcal ? `<div style="font-size:10px;color:var(--text3)">${kcal}</div>` : ''}
        ${note ? `<div style="font-size:11px;color:var(--text2);font-style:italic;margin-top:2px">${esc(note)}</div>` : ''}
      </div>
      ${qtyCall ? `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <button onclick="${qtyCall.replace('__D__','-1')}" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
        <span style="font-size:12px;font-weight:600;min-width:16px;text-align:center">${qty}</span>
        <button onclick="${qtyCall.replace('__D__','1')}" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
      </div>` : ''}
      <button onclick="${removeCall}" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0">×</button>
    </div>
  </div>`;
}

function _renderItemAddPanel() {
  const add = state.myItemAdd;
  if (!add.open) return '';
  const result = add.results;
  const productOpts = result?.status === 'found'
    ? result.products.slice(0, 10).map((p, i) => `
        <div onclick="state.myItemAdd.selectedIdx=${i};render()"
          style="padding:8px;border-radius:8px;border:1px solid ${i===add.selectedIdx?'var(--green)':'var(--border)'};background:${i===add.selectedIdx?'rgba(29,158,117,.08)':'var(--bg3)'};cursor:pointer;margin-bottom:6px">
          <div style="font-size:12px;font-weight:500">${esc(p.name)}</div>
          <div style="font-size:10px;color:var(--text3)">${esc(p.size||'')}${p.price?' · $'+p.price:''}</div>
        </div>`).join('')
    : result ? `<div style="font-size:12px;color:var(--text3);padding:6px 0">No City Market match found — item will be saved without a product link.</div>` : '';

  return `<div style="margin-top:10px;padding:12px;background:var(--bg3);border-radius:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-size:12px;font-weight:600">Add ${add.type === 'item' ? 'Item' : 'Staple'}</div>
      <button onclick="closeMyItemAdd()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0">×</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input class="input" placeholder="Item name…" style="flex:1;font-size:13px"
        value="${esc(add.query)}"
        oninput="state.myItemAdd.query=this.value"
        onkeydown="if(event.key==='Enter')searchMyItem()"/>
      <button onclick="searchMyItem()"
        style="padding:8px 12px;border-radius:10px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;font-size:13px;flex-shrink:0"
        ${add.searching?'disabled':''}>${add.searching?'…':'Search'}</button>
    </div>
    ${productOpts}
    ${result !== null ? `
      <input class="input" placeholder="Note for owner (optional)…" style="width:100%;box-sizing:border-box;font-size:12px;margin-bottom:8px"
        value="${esc(add.note)}" oninput="state.myItemAdd.note=this.value"/>
      <div style="display:flex;gap:6px">
        ${result?.status === 'found' ? `<button onclick="confirmMyItemAdd(false)" class="btn btn-green" style="flex:2;font-size:12px">Add matched product</button>` : ''}
        <button onclick="confirmMyItemAdd(true)" class="btn btn-gray" style="flex:1;font-size:12px">Add as typed</button>
      </div>` : ''}
  </div>`;
}

function _renderMyItemsSection() {
  const { staples, items } = state.userGroceryData;
  const add = state.myItemAdd;

  const itemsHtml = items.length
    ? items.map(it => _renderItemRow(it,
        `removeMyItem('${typeof it==='object'?it.id:it}')`,
        `updateMyItemQty('${typeof it==='object'?it.id:it}',__D__,'items')`
      )).join('')
    : `<div style="font-size:12px;color:var(--text3);padding:8px 0">No items yet</div>`;

  const staplesHtml = staples.length
    ? staples.map((s, si) => {
        const id   = typeof s === 'object' ? s.id : s;
        const name = typeof s === 'object' ? (s.krogerName || s.name) : s;
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
          <button onclick="addStapleToItems(${si})" title="Add to this week's list"
            style="width:22px;height:22px;border-radius:50%;border:1px solid var(--green);background:rgba(29,158,117,.1);color:var(--green);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">+</button>
          <span style="flex:1;font-size:13px">${esc(name)}</span>
          <button onclick="removeMyStaple('${id}')" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0 4px;line-height:1">×</button>
        </div>`;
      }).join('')
    : `<div style="font-size:12px;color:var(--text3);padding:8px 0">No staples yet</div>`;

  const pushRes = state.myItemsPushResults;
  const pushResultsHtml = pushRes ? (
    pushRes._error
      ? `<div style="font-size:12px;color:var(--danger);margin-top:8px;padding:8px;background:rgba(226,75,74,.1);border-radius:8px">${pushRes._error}</div>`
      : `<div style="font-size:12px;color:var(--text2);margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
           Pushed ${pushRes.summary?.added ?? 0}/${pushRes.summary?.total ?? 0} items to City Market
           <button onclick="state.myItemsPushResults=null;render()" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;margin-left:6px">✕ Clear</button>
         </div>`
  ) : '';

  const addItemPanel  = (add.open && add.type === 'item')   ? _renderItemAddPanel() : '';
  const addStaplePanel = (add.open && add.type === 'staple') ? _renderItemAddPanel() : '';

  return `
    <div class="card">
      <div class="card-title">My Items This Week</div>
      ${itemsHtml}
      ${addItemPanel}
      ${!add.open || add.type !== 'item' ? `<button onclick="openMyItemAdd('item')"
        style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px dashed var(--border);background:var(--bg2);color:var(--text2);font-size:12px;cursor:pointer">+ Add item</button>` : ''}
      ${pushResultsHtml}
    </div>
    <div class="card">
      <div class="card-title">My Staples</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:8px">Tap + to add to this week's list</div>
      ${staplesHtml}
      ${addStaplePanel}
      ${!add.open || add.type !== 'staple' ? `<button onclick="openMyItemAdd('staple')"
        style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px dashed var(--border);background:var(--bg2);color:var(--text2);font-size:12px;cursor:pointer">+ Add staple</button>` : ''}
    </div>`;
}

// ── CUSTOM RECIPE CREATE ──
function renderRecipeCreate() {
  const f = state.recipeCreateForm;
  const ings = state.recipeCreateIngSearch;

  // Live macro total
  const totals = f.ingredients.reduce((a, i) => ({
    kcal: a.kcal + i.kcalTotal, protein: a.protein + i.proteinTotal,
    carbs: a.carbs + i.carbsTotal, fat: a.fat + i.fatTotal,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const perSrv = f.servings > 0 ? {
    kcal: Math.round(totals.kcal / f.servings),
    protein: Math.round(totals.protein / f.servings * 10) / 10,
    carbs: Math.round(totals.carbs / f.servings * 10) / 10,
    fat: Math.round(totals.fat / f.servings * 10) / 10,
  } : { kcal: 0, protein: 0, carbs: 0, fat: 0 };

  const mealTypeOpts = [['dinner','Dinner'],['breakfast','Breakfast'],['lunch','Lunch'],['snack','Snack']].map(([v,l]) =>
    `<option value="${v}" ${f.mealType===v?'selected':''}>${l}</option>`).join('');
  const cuisineOpts = ['Mexican','Asian','American','Italian'].map(c =>
    `<option value="${c}" ${f.cuisine===c?'selected':''}>${c}</option>`).join('');

  // Ingredient search UI
  const ingSearchUI = ings.food ? (() => {
    const food = ings.food;
    const idx = ings.servingIdx;
    const srv = food.servings[idx];
    const servingOpts = food.servings.map((s,i) =>
      `<option value="${i}" ${i===idx?'selected':''}>${esc(_servingLabel(s))}</option>`).join('');
    const preview = srv ? (() => {
      const n = srv.nutrition;
      const q = ings.qty;
      return `<div style="font-size:11px;color:var(--text3);margin:6px 0">${Math.round(n.kcal*q)} kcal · ${Math.round(n.protein*q*10)/10}g P · ${Math.round(n.carbs*q*10)/10}g C · ${Math.round(n.fat*q*10)/10}g F</div>`;
    })() : '';
    return `<div style="padding:10px;background:var(--bg3);border-radius:10px;margin-top:8px">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(food.name)}${food.brand?` <span style="font-weight:400;color:var(--text3);font-size:11px">(${esc(food.brand)})</span>`:''}</div>
      <select onchange="state.recipeCreateIngSearch.servingIdx=+this.value;render()"
        style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:6px 8px;font-size:12px;font-family:inherit;margin-bottom:8px">${servingOpts}</select>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:var(--text2)">How many servings:</span>
        <button onclick="state.recipeCreateIngSearch.qty=Math.max(0.5,state.recipeCreateIngSearch.qty-0.5);render()"
          style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
        <span style="font-size:15px;font-weight:600;min-width:24px;text-align:center">${ings.qty}</span>
        <button onclick="state.recipeCreateIngSearch.qty=state.recipeCreateIngSearch.qty+0.5;render()"
          style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
      </div>
      ${preview}
      <div style="display:flex;gap:6px">
        <button onclick="state.recipeCreateIngSearch.food=null;state.recipeCreateIngSearch.results=[];render()"
          class="btn btn-gray" style="flex:1;font-size:12px">← Back</button>
        <button onclick="addIngredientToCreate()" class="btn btn-green" style="flex:2;font-size:12px">Add to recipe</button>
      </div>
    </div>`;
  })() : `<div>
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <input class="input" placeholder="Search ingredient (e.g. chicken breast)…" style="flex:1;font-size:13px"
        value="${esc(ings.query)}"
        oninput="state.recipeCreateIngSearch.query=this.value"
        onkeydown="if(event.key==='Enter')recipeIngSearch(state.recipeCreateIngSearch.query)"/>
      <button onclick="recipeIngSearch(state.recipeCreateIngSearch.query)"
        style="padding:8px 12px;border-radius:10px;border:1px solid var(--blue);background:rgba(55,138,221,.15);color:var(--blue);cursor:pointer;font-size:13px;flex-shrink:0"
        ${ings.loading?'disabled':''}>${ings.loading?'…':'Search'}</button>
    </div>
    ${ings.results.slice(0,10).map(r => `
      <div onclick="recipeIngSelectFood('${r.id}')"
        style="padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px;font-weight:500">
        ${esc(r.name)}${r.brand?` <span style="font-weight:400;color:var(--text3);font-size:11px">(${esc(r.brand)})</span>`:''}
        <div style="font-size:11px;color:var(--text3);font-weight:400;margin-top:1px">${esc(r.description||'')}</div>
      </div>`).join('')}
  </div>`;

  const ingList = f.ingredients.length ? f.ingredients.map((ing, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:500">${esc(ing.name)}</div>
        <div style="font-size:11px;color:var(--text3)">${ing.qty} × ${ing.servingDesc} · ${Math.round(ing.kcalTotal)} kcal</div>
      </div>
      <button onclick="removeCreateIngredient(${i})" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0">×</button>
    </div>`).join('') : `<div style="font-size:12px;color:var(--text3);padding:6px 0">No ingredients yet — search above to add.</div>`;

  const stepsList = f.steps.map((step, i) => `
    <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px">
      <div style="width:22px;height:22px;border-radius:50%;background:var(--bg3);color:var(--text3);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">${i+1}</div>
      <textarea class="input" rows="2" style="flex:1;font-size:13px;resize:vertical"
        oninput="state.recipeCreateForm.steps[${i}]=this.value">${esc(step)}</textarea>
      <button onclick="state.recipeCreateForm.steps.splice(${i},1);render()"
        style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0;flex-shrink:0">×</button>
    </div>`).join('');

  return `
    <div class="card">
      <div class="card-title">Recipe info</div>
      <input class="input" placeholder="Recipe name *" style="margin-bottom:8px;width:100%;box-sizing:border-box"
        value="${esc(f.name)}" oninput="state.recipeCreateForm.name=this.value"/>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <select class="input" style="flex:1" onchange="state.recipeCreateForm.mealType=this.value">${mealTypeOpts}</select>
        <select class="input" style="flex:1" onchange="state.recipeCreateForm.cuisine=this.value">${cuisineOpts}</select>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:8px;align-items:center">
        <span style="font-size:12px;color:var(--text2)">Cook time (min):</span>
        <button onclick="state.recipeCreateForm.cookTime=Math.max(5,state.recipeCreateForm.cookTime-5);render()"
          style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
        <span style="font-size:15px;font-weight:600;min-width:30px;text-align:center">${f.cookTime}</span>
        <button onclick="state.recipeCreateForm.cookTime=state.recipeCreateForm.cookTime+5;render()"
          style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
        <span style="font-size:12px;color:var(--text2);margin-left:8px">Servings:</span>
        <button onclick="state.recipeCreateForm.servings=Math.max(1,state.recipeCreateForm.servings-1);render()"
          style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
        <span style="font-size:15px;font-weight:600;min-width:20px;text-align:center">${f.servings}</span>
        <button onclick="state.recipeCreateForm.servings=state.recipeCreateForm.servings+1;render()"
          style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <button onclick="state.recipeCreateForm.weekendOnly=!state.recipeCreateForm.weekendOnly;render()"
          style="width:20px;height:20px;border-radius:5px;border:2px solid ${f.weekendOnly?'#7F77DD':'var(--border)'};background:${f.weekendOnly?'rgba(127,119,221,.2)':'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">
          ${f.weekendOnly?'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#7F77DD" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>':''}
        </button>
        <span style="font-size:12px;color:var(--text2)">Weekend only</span>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Ingredients</div>
      ${ingSearchUI}
      <div style="margin-top:10px">${ingList}</div>
      ${f.ingredients.length ? `<div style="font-size:12px;color:var(--text2);margin-top:8px;padding:8px;background:var(--bg3);border-radius:8px">
        Per serving (${f.servings}): <strong>${perSrv.kcal} kcal · ${perSrv.protein}g P · ${perSrv.carbs}g C · ${perSrv.fat}g F</strong>
      </div>` : ''}
    </div>
    <div class="card">
      <div class="card-title">Steps</div>
      ${stepsList}
      <button onclick="state.recipeCreateForm.steps.push('');render()"
        style="margin-top:6px;width:100%;padding:8px;border-radius:8px;border:1px dashed var(--border);background:var(--bg2);color:var(--text3);font-size:12px;cursor:pointer">+ Add step</button>
    </div>
    <div class="card">
      <div style="font-size:11px;color:var(--text3);margin-bottom:4px">Kid plate (optional)</div>
      <input class="input" placeholder="Separate plate notes…" style="width:100%;box-sizing:border-box;margin-bottom:10px"
        value="${esc(f.kidPlate)}" oninput="state.recipeCreateForm.kidPlate=this.value"/>
      <div style="font-size:11px;color:var(--text3);margin-bottom:4px">Notes (optional)</div>
      <textarea class="input" placeholder="Any notes…" rows="2" style="width:100%;box-sizing:border-box;resize:vertical"
        oninput="state.recipeCreateForm.notes=this.value">${esc(f.notes)}</textarea>
    </div>
    <button onclick="saveCustomRecipe()" class="btn btn-green btn-full" style="margin-bottom:8px"
      ${!f.name.trim()||!f.ingredients.length?'disabled style="opacity:.5"':''}>
      Save Recipe
    </button>
    <button onclick="state.recipeCreateForm={name:'',mealType:'dinner',cuisine:'Mexican',cookTime:30,servings:4,weekendOnly:false,kidPlate:'',notes:'',ingredients:[],steps:[]};state.recipeCreateIngSearch={query:'',results:[],loading:false,food:null,servingIdx:0,qty:1};render()"
      class="btn btn-gray btn-full">Clear form</button>`;
}

// ── WEEKLY PLAN BOTTOM DRAWER ──

function toggleWeeklyDrawer() {
  state.weeklyDrawerOpen = !state.weeklyDrawerOpen;
  _syncWeeklyDrawer();
}

function _syncWeeklyDrawer() {
  const drawerEl = document.getElementById('weekly-drawer');
  if (!drawerEl) return;
  const show = state.tab === 'recipes' && state.recipeSubTab === 'library'
               && !state.recipeView && state.weeklyPlan.size > 0;
  drawerEl.classList.toggle('has-recipes', show);
  drawerEl.classList.toggle('open', show && state.weeklyDrawerOpen);
  if (show) drawerEl.innerHTML = renderWeeklyDrawer();
  else drawerEl.innerHTML = '';
}

// ── WATER LOG BOTTOM DRAWER ──
// Peeks on the Macros tab (always available); expands to log per-window water.

function toggleWaterDrawer() {
  state.waterDrawerOpen = !state.waterDrawerOpen;
  _syncWaterDrawer();
}

function _syncWaterDrawer() {
  const drawerEl = document.getElementById('water-drawer');
  if (!drawerEl) return;
  const show = state.tab === 'macros';
  drawerEl.classList.toggle('has-water', show);
  drawerEl.classList.toggle('open', show && state.waterDrawerOpen);
  if (show) drawerEl.innerHTML = renderWaterDrawer();
  else drawerEl.innerHTML = '';
}

// Push the scroll content up so its last card clears whichever drawer is peeking.
function _syncDrawerPeek() {
  const contentEl = el('content');
  if (!contentEl) return;
  const weekly = document.getElementById('weekly-drawer');
  const water  = document.getElementById('water-drawer');
  const peek = (weekly && weekly.classList.contains('has-recipes'))
            || (water  && water.classList.contains('has-water'));
  contentEl.classList.toggle('drawer-peek', !!peek);
}

function renderWeeklyDrawer() {
  const weeklyRecipes = state.recipes.filter(r => state.weeklyPlan.has(r.id));
  if (!weeklyRecipes.length) return '';
  const count = weeklyRecipes.length;
  const totalKcal = weeklyRecipes.reduce((sum, r) => {
    const scale = getRecipeScale(r.id, r.servings);
    return sum + Math.round(r.perServing.kcal * scale);
  }, 0);
  const isOpen = state.weeklyDrawerOpen;
  return `
    <div class="weekly-drawer-handle" onclick="toggleWeeklyDrawer()">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;font-weight:600;color:var(--green)">${count} recipe${count!==1?'s':''} selected</span>
        <span style="font-size:11px;color:var(--text3)">·</span>
        <span style="font-size:12px;color:var(--text2)">${totalKcal.toLocaleString()} kcal this week</span>
      </div>
      <svg class="weekly-drawer-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="weekly-drawer-body">${renderWeeklyDrawerBody(weeklyRecipes)}</div>`;
}

function renderWeeklyDrawerBody(weeklyRecipes) {
  const consolidated = consolidateIngredients();
  const ING_CATS = [
    { key:'meat',    label:'Meat & Seafood',     color:'#E24B4A' },
    { key:'produce', label:'Produce',             color:'#1D9E75' },
    { key:'dairy',   label:'Dairy & Eggs',        color:'#378ADD' },
    { key:'pantry',  label:'Pantry',              color:'#EF9F27' },
    { key:'spices',  label:'Spices & Seasonings', color:'#7F77DD' },
  ];
  const byCategory = {};
  ING_CATS.forEach(c => byCategory[c.key] = []);
  consolidated.forEach(i => (byCategory[i.category] || byCategory['pantry']).push(i));

  const ingList = ING_CATS.filter(cat => byCategory[cat.key].length).map(cat => {
    const isSpiceCat = cat.key === 'spices';
    const rows = byCategory[cat.key].map(c => {
      const safeKey = c.display.replace(/'/g, "\\'");
      const excluded = isSpiceCat
        ? !state.recipeIngredientIncludes.has(c.display)
        : state.recipeIngredientExcludes.has(c.display);
      const toggle = isSpiceCat ? `toggleSpiceInclude('${safeKey}')` : `toggleIngredientExclude('${safeKey}')`;
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:8px">
        <button onclick="${toggle}"
          style="flex-shrink:0;margin-top:1px;width:18px;height:18px;border-radius:4px;border:2px solid ${excluded?'var(--text3)':'var(--border)'};background:${excluded?'rgba(100,100,100,.15)':'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">
          ${excluded?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>':''}
        </button>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:${excluded?'var(--text3)':'var(--text2)'};text-decoration:${excluded?'line-through':'none'}">${esc(c.display)}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px;line-height:1.4">${esc(c.fromRecipes.join(', '))}</div>
        </div>
      </div>`;
    }).join('');
    const hint = isSpiceCat ? ' <span style="font-size:10px;color:var(--text3);font-weight:400;text-transform:none;letter-spacing:0">(uncheck to buy)</span>' : '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;color:${cat.color};text-transform:uppercase;letter-spacing:.06em;padding:4px 0;border-bottom:2px solid ${cat.color}33">${cat.label}${hint}</div>
      ${rows}
    </div>`;
  }).join('');

  const MT_ORDER  = ['breakfast','lunch','dinner','snack'];
  const MT_LABELS = { breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snacks' };
  const MT_COLORS = { breakfast:'#1D9E75', lunch:'#378ADD', dinner:'#EF9F27', snack:'#7F77DD' };
  const groupedByMT = {};
  for (const r of weeklyRecipes) {
    const mt = MT_ORDER.includes(r.mealType||'dinner') ? (r.mealType||'dinner') : 'other';
    (groupedByMT[mt] = groupedByMT[mt] || []).push(r);
  }
  const orderedKeys = [...MT_ORDER.filter(k => groupedByMT[k]), ...(groupedByMT['other'] ? ['other'] : [])];
  const recipeList = orderedKeys.map(mt => {
    const label = MT_LABELS[mt] || 'Other';
    const color = MT_COLORS[mt] || 'var(--text3)';
    const header = orderedKeys.length > 1
      ? `<div style="font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.06em;padding:6px 0 3px;margin-top:4px">${label}</div>`
      : '';
    return header + groupedByMT[mt].map(r => {
      const isDinner = (r.mealType || 'dinner') === 'dinner';
      const scale = getRecipeScale(r.id, r.servings);
      const unitLabel = isDinner ? 'people' : `serving${scale !== 1 ? 's' : ''}`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:12px;color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">· ${esc(r.name)}</div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          <button onclick="setRecipeScale('${r.id}',${scale-1})" style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
          <span style="font-size:12px;font-weight:600;min-width:52px;text-align:center">${scale} ${unitLabel}</span>
          <button onclick="setRecipeScale('${r.id}',${scale+1})" style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
        </div>
      </div>`;
    }).join('');
  }).join('');

  const groceryBtn = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div style="font-size:13px;font-weight:600;color:var(--green)">This Week (${weeklyRecipes.length})</div>
    ${state.krogerConnected
      ? `<button onclick="searchRecipeIngredients()" class="btn btn-blue" style="padding:5px 12px;font-size:12px" ${state.cartSearchLoading?'disabled':''}>${state.cartSearchLoading?'Searching...':'Preview grocery list'}</button>`
      : '<span style="font-size:11px;color:var(--text3)">Connect City Market to push</span>'}
  </div>`;

  return groceryBtn + recipeList
    + (consolidated.length ? `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Consolidated ingredients</div>
        ${ingList}
      </div>` : '');
}

function renderGrocery() {
  // ── Grocery-role view (family members) ──
  if (state.userRole === 'grocery') {
    return `${_renderMyItemsSection()}`;
  }

  // ── Owner view ──
  const connected = state.krogerConnected;
  const statusBar = connected
    ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px"><div class="status-dot" style="background:var(--green)"></div><span style="font-size:12px;color:var(--text2)">City Market connected</span></div>`
    : state.authPending
    ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px"><div class="status-dot" style="background:var(--orange)"></div><span style="font-size:12px;color:var(--text2)">Waiting for authorization...</span></div>`
    : `<div style="font-size:12px;color:var(--text3);margin-bottom:12px">Not connected · <button onclick="openSettings()" style="background:none;border:none;color:var(--blue);font-size:12px;cursor:pointer;padding:0">Open Settings to connect</button></div>`;
  const cartReview = renderCartReview();
  const results = state.pushResults && !cartReview
    ? `<div class="card" style="border-color:${state.pushResults.summary?.failed===0?'var(--green)':'var(--orange)'}"><div class="card-title">Cart push — ${state.pushResults.summary?.added??0}/${state.pushResults.summary?.total??0} added</div>${(state.pushResults.results||[]).map(r=>`<div class="push-result"><div><div style="font-size:13px">${esc(r.item)}</div>${r.searchTerm?`<div style="font-size:11px;color:var(--text3)">Searched: "${esc(r.searchTerm)}"</div>`:''} ${r.productName?`<div style="font-size:11px;color:var(--text3)">→ ${esc(r.productName)}</div>`:''}</div><span class="pill" style="background:${r.status==='added'?'rgba(29,158,117,.2)':'rgba(226,75,74,.15)'};color:${r.status==='added'?'var(--green)':'var(--danger)'}">${r.status==='added'?'Added':r.status==='not_found'?'Not found':'Error'}</span></div>`).join('')}<button class="btn btn-gray" style="width:100%;margin-top:10px" onclick="clearResults()">Clear</button></div>`
    : '';

  // Family additions section — owner checks items and sets quantity for their cart push
  const familySection = state.familyGroceryData.length ? state.familyGroceryData.map(u => {
    const allItems = [...(u.items || []), ...(u.staples || [])];
    if (!allItems.length) return '';
    const itemCount = (u.items || []).length;
    const rows = allItems.map((it, idx) => {
      const k    = `fam::${u.email}::${idx}`;
      const sel  = !!state.checked[k];
      const qty  = state.familyItemQty[k] ?? 1;
      const name = typeof it === 'object' ? (it.krogerName || it.name) : it;
      const note = typeof it === 'object' && it.notes ? it.notes : null;
      const size = typeof it === 'object' && it.krogerSize ? ` · ${it.krogerSize}` : '';
      const type = idx < itemCount ? 'item' : 'staple';
      const subIdx = idx < itemCount ? idx : idx - itemCount;
      return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
        <div class="check-box" onclick="toggleCheck('${k}')"
          style="flex-shrink:0;cursor:pointer;${sel?'background:var(--green);border-color:var(--green)':''}">
          ${sel?`<svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`:''}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px">${esc(name)}${size?`<span style="font-size:10px;color:var(--text3)">${esc(size)}</span>`:''}</div>
          ${note?`<div style="font-size:11px;color:var(--blue);font-style:italic">${esc(note)}</div>`:''}
        </div>
        ${sel?`<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          <button onclick="setFamilyItemQty('${k}',-1)" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
          <span style="font-size:12px;font-weight:600;min-width:16px;text-align:center">${qty}</span>
          <button onclick="setFamilyItemQty('${k}',1)" style="width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
        </div>`:''}
        <button onclick="removeFamilyItem('${u.email}',${subIdx},'${type}')"
          style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0;line-height:1;flex-shrink:0">×</button>
      </div>`;
    }).join('');
    return `<div class="card">
      <div class="card-title">${esc(u.name || u.email)}'s Additions</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:8px">Check items · adjust qty before pushing to cart</div>
      ${rows}
    </div>`;
  }).join('') : '';

  const ownerItemCount = state.userGroceryData.items.length;
  const familyCheckedCount = state.familyGroceryData.flatMap(u =>
    [...(u.items || []), ...(u.staples || [])].map((_, idx) => {
      const k = `fam::${u.email}::${idx}`;
      return state.checked[k] ? (state.familyItemQty[k] ?? 1) : 0;
    })
  ).reduce((a, b) => a + b, 0);
  const totalPush = ownerItemCount + familyCheckedCount;

  const pantryCard = (() => {
    const depleted = state.pantry.filter(p => p.remaining === 0);
    const rows = state.pantry.map(p => {
      const pct = p.amount > 0 ? Math.min(100, Math.round(p.remaining / p.amount * 100)) : 0;
      const barColor = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--orange)' : 'var(--danger)';
      const fmt = n => n % 1 === 0 ? n : parseFloat(n.toFixed(2).replace(/\.?0+$/,''));
      const ppu = p.portionsPerUnit || 1;
      // With a portions/container set, the stepper counts portions; otherwise containers.
      const counter = ppu !== 1
        ? `${fmt(Math.round(p.remaining * ppu * 10) / 10)} / ${fmt(Math.round(p.amount * ppu * 10) / 10)} <span style="font-size:9px;color:var(--text3)">portions</span>`
        : `${fmt(p.remaining)} / ${fmt(p.amount)}`;
      const miniBtn = 'width:18px;height:18px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text3);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0';
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border);opacity:${p.remaining===0?0.4:1}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:500">${esc(p.krogerName || p.ingredientName)}${p.krogerSize ? `<span style="font-size:10px;font-weight:400;color:var(--text3);margin-left:5px">${esc(p.krogerSize)}</span>` : ''}</div>
            <div style="font-size:10px;color:var(--text3)">${esc(p.ingredientName)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
            <button onclick="adjustPantryItem('${p.id}',-1)" style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">−</button>
            <span style="font-size:12px;min-width:44px;text-align:center;color:var(--text2)">${counter}</span>
            <button onclick="adjustPantryItem('${p.id}',1)" style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">+</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="font-size:10px;color:var(--text3)">${fmt(p.amount)} container${p.amount !== 1 ? 's' : ''} ·</span>
          <span style="font-size:10px;color:var(--text3)">portions/container:</span>
          <button onclick="setPantryPortionsPerUnit('${p.id}',-1)" style="${miniBtn}">−</button>
          <span style="font-size:11px;font-weight:600;min-width:18px;text-align:center;color:var(--text2)">${fmt(ppu)}</span>
          <button onclick="setPantryPortionsPerUnit('${p.id}',1)" style="${miniBtn}">+</button>
        </div>
        <div style="height:4px;background:var(--bg3);border-radius:2px">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width .3s"></div>
        </div>
      </div>`;
    }).join('');
    const addPanel = state.pantryAddOpen
      ? `<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:12px;font-weight:600;color:var(--text2)">Search food to add</div>
            <button onclick="state.pantryAddOpen=false;state.pantryFsContainerServings=1;state.fsFood=null;state.fsQuery='';state.fsResults=[];render()"
              style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0;line-height:1">×</button>
          </div>
          ${renderFsSearchTab(null,'pantry')}
        </div>`
      : `<button onclick="state.pantryAddOpen=true;state.fsFood=null;state.fsQuery='';state.fsResults=[];render()"
          style="width:100%;margin-top:${state.pantry.length?'10':'0'}px;padding:8px;border-radius:10px;border:1px dashed var(--border);background:var(--bg2);color:var(--text2);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          Search &amp; add item to pantry
        </button>`;

    const headerButtons = state.pantry.length ? `
      <div style="display:flex;gap:6px">
        ${depleted.length?`<button onclick="clearDepletedPantry()" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text3);cursor:pointer">Clear depleted (${depleted.length})</button>`:''}
        <button onclick="clearPantry()" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--danger);background:rgba(226,75,74,.08);color:var(--danger);cursor:pointer">Clear all</button>
      </div>` : '';

    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="card-title" style="margin:0">Pantry${state.pantry.length ? ` (${state.pantry.length})` : ''}</div>
        ${headerButtons}
      </div>
      ${!state.pantry.length ? `<div style="font-size:12px;color:var(--text3);padding:4px 0 6px">No items — search below to add ingredients.</div>` : ''}
      ${rows}
      ${addPanel}
    </div>`;
  })();

  const mealPrepCard = (() => {
    const available = state.preparedMeals.filter(p => p.portionsRemaining > 0);
    if (!available.length) return '';
    const rows = available.map(pm => {
      const prepDate = new Date(pm.preparedAt).toLocaleDateString('en-US', { month:'short', day:'numeric' });
      const m = pm.portionMacros;
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:500">${esc(pm.recipeName)}</div>
            <div style="font-size:11px;color:var(--text2);margin-top:1px">${m.kcal} kcal · ${m.protein}g P · ${m.carbs}g C · ${m.fat}g F per portion</div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px">Prepped ${prepDate}</div>
          </div>
          <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
            <button onclick="othersAtePrepared('${pm.id}')" style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0" title="Someone else ate a portion">−</button>
            <span style="font-size:12px;min-width:24px;text-align:center;color:var(--orange);font-weight:500">${pm.portionsRemaining}</span>
            <button onclick="addPreparedMealPortion('${pm.id}')" style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0" title="Undo — add a portion back">+</button>
            <button onclick="discardPreparedMeal('${pm.id}')" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0;line-height:1;margin-left:2px" title="Discard remaining portions">×</button>
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:12px;border-color:var(--orange)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="card-title" style="margin:0;color:var(--orange)">Meal Prep (${available.length})</div>
      </div>
      ${rows}
    </div>`;
  })();

  return `${statusBar}${cartReview}${results}
    ${mealPrepCard}
    ${pantryCard}
    ${_renderMyItemsSection()}
    ${familySection}
    <button class="btn btn-green btn-full" onclick="pushCart()"
      ${!connected || state.pushLoading || totalPush === 0 ? 'disabled' : ''}
      style="opacity:${!connected || state.pushLoading || totalPush === 0 ? 0.6 : 1};margin-bottom:8px">
      ${state.pushLoading ? 'Pushing to cart...' : `Push ${totalPush} item${totalPush !== 1 ? 's' : ''} to City Market`}
    </button>
    <button class="btn btn-gray btn-full" onclick="resetChecklist()">Reset family selections</button>`;
}
