// ── CALENDAR KV ──
async function loadCalUrls() {
  try {
    const [calRes,msRes,gRes]=await Promise.all([
      authFetch(`${BACKEND}/cal-urls`),
      authFetch(`${BACKEND}/auth/microsoft/status`),
      authFetch(`${BACKEND}/auth/google/status`),
    ]);
    const calData=await calRes.json();
    state.calUrls=calData.urls||[];
    state.msStatus=await msRes.json();
    const gData=await gRes.json();
    state.googleConnected=gData.connected||false;
    if(state.googleConnected){
      const gcRes=await authFetch(`${BACKEND}/auth/google/calendars`);
      const gcData=await gcRes.json();
      state.googleCalendars=gcData.calendars||[];
    } else {
      state.googleCalendars=[];
    }
  } catch(e) { console.error('loadCalUrls',e); }
}

async function toggleGoogleCal(i) {
  const gc=state.googleCalendars[i];
  if(!gc)return;
  const added=state.calUrls.find(c=>c.type==='google'&&c.calendarId===gc.id);
  if(added) await removeCalUrl(gc.id);
  else await addGoogleCalendar(gc.id,gc.name);
}

async function addGoogleCalendar(calendarId, name) {
  try {
    const res=await authFetch(`${BACKEND}/cal-urls`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'google',calendarId,name}),
    });
    const data=await res.json();
    state.calUrls=data.urls||[];
    fetchCalendars();
    render();
  } catch(e){console.error('addGoogleCalendar',e);}
}

async function disconnectGoogle() {
  try {
    await authFetch(`${BACKEND}/auth/google/disconnect`,{method:'DELETE'});
    state.googleConnected=false;
    state.googleCalendars=[];
    state.calUrls=state.calUrls.filter(c=>c.type!=='google');
    state.calEvents=[];state.calTomorrowEvents=[];
    render();
  } catch(e){console.error('disconnectGoogle',e);}
}

async function disconnectMicrosoft(account) {
  try {
    await authFetch(`${BACKEND}/auth/microsoft/disconnect?account=${account}`,{method:'DELETE'});
    state.msStatus={...state.msStatus,[account]:false};
    state.calUrls=state.calUrls.filter(c=>!(c.type==='microsoft'&&c.account===account));
    state.calEvents=[];state.calTomorrowEvents=[];
    render();
  } catch(e){console.error('disconnectMicrosoft',e);}
}


async function removeCalUrl(id) {
  try {
    const res=await authFetch(`${BACKEND}/cal-urls/${encodeURIComponent(id)}`,{method:'DELETE'});
    const data=await res.json();
    state.calUrls=data.urls||[];
    state.calEvents=[];state.calTomorrowEvents=[];
    render();
    if(state.calUrls.length) fetchCalendars();
  } catch(e){console.error('removeCalUrl',e);}
}

// ── CALENDAR FETCH ──
async function fetchCalendars() {
  if(!state.calUrls.length)return;
  state.calLoading=true;
  if(state.tab==='day')render();
  const now=new Date();
  const tom=new Date(now);tom.setDate(now.getDate()+1);
  const pad=n=>String(n).padStart(2,'0');
  const toDateStr=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const dates=[toDateStr(now),toDateStr(tom)];
  try {
    const res=await authFetch(`${BACKEND}/fetch-calendars`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        calendars:state.calUrls.map(c=>({id:c.id,type:c.type||'ics',url:c.url,account:c.account,calendarId:c.calendarId})),
        dates,
      }),
    });
    if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error(d.detail||d.error||`HTTP ${res.status}`);}
    const data=await res.json();
    let todayEvs=[],tomorrowEvs=[];
    for(const result of data.results){
      if(!result.events) continue;
      const entry=state.calUrls.find(c=>c.id===result.id);
      const label=entry?entry.name:'Calendar';
      let color=calColor(result.id);
      if(entry?.type==='google'){
        const gc=state.googleCalendars.find(g=>g.id===entry.calendarId);
        if(gc?.color) color=gc.color;
      }
      for(const ev of result.events){
        const start=new Date(ev.start);
        const end=new Date(ev.end);
        const startMins=start.getHours()*60+start.getMinutes();
        const endMins=end.getHours()*60+end.getMinutes();
        const obj={
          label:ev.summary,mins:startMins,endMins,
          duration:endMins-startMins,
          sub:`${minsToFmt(startMins)} – ${minsToFmt(endMins)}`,
          color,type:'cal',source:label,
        };
        if(ev.date===dates[0]) todayEvs.push(obj);
        else tomorrowEvs.push(obj);
      }
    }
    const dedup=evs=>{
      const seen=new Set();
      return evs.filter(e=>{const k=`${e.label}-${e.mins}`;if(seen.has(k))return false;seen.add(k);return true;});
    };
    state.calEvents=dedup(todayEvs);
    state.calTomorrowEvents=dedup(tomorrowEvs);
    state.calError=null;
  } catch(e){state.calError=e.message;}
  state.calLoading=false;
  render();
}
