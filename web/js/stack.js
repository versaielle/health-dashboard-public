const minsToFmt = (mins) => {
  const h=Math.floor(mins/60)%24, m=mins%60;
  const ap=h>=12?'PM':'AM', hh=h>12?h-12:h===0?12:h;
  return `${hh}:${String(m).padStart(2,'0')} ${ap}`;
};

function getStackEvents(firstMeetingMins, targetDate, actualWakeMins = null) {
  const dow=targetDate.getDay();
  const ws=(state.workoutOverrides&&state.workoutOverrides[dow])||WORKOUT_START;
  const isWeekend=dow===0||dow===6;
  const isWFH=!isWeekend&&!!(state.wfhDays&&state.wfhDays[dow]);
  const buffer=isWFH?WAKE_BUFFER_WFH:WAKE_BUFFER_OFFICE;
  const wakeMins=actualWakeMins !== null ? actualWakeMins : firstMeetingMins-buffer;

  // Next day's wake time drives curfew/sunset
  const nextDow=(dow+1)%7;
  const nextWakeVal=state.wakeOverrides[nextDow];
  const nextWakeMins=nextWakeVal?(+nextWakeVal.split(':')[0]*60+(+nextWakeVal.split(':')[1])):360;
  const zynCurfew=nextWakeMins-11*60+1440;   // 11 hrs before next wake
  const digitalSunset=nextWakeMins-8*60+1440; // 8 hrs before next wake

  return [
    {mins:wakeMins,label:'Wake up',sub:`${isWeekend?'Weekend':isWFH?'WFH':'Office'} day · 16oz water immediately`,color:'#1D9E75',type:'stack'},
    {mins:wakeMins+15,label:'Quick-fuel breakfast',sub:'Eggs + berries · ~35g protein',color:'#378ADD',type:'stack'},
    {mins:720,label:'Lunch',sub:'Turkey or chicken bowl · ~45g protein',color:'#378ADD',type:'stack'},
    {mins:ws-60,label:'Pre-workout fuel',sub:'Banana + walnuts · 60 min buffer',color:'#EF9F27',type:'stack'},
    {mins:ws-ZYN_STOP_BEFORE_WORKOUT,label:'Zyn hard stop',sub:'90 min pre-decompression cutoff',color:'#7F77DD',type:'stack'},
    {mins:ws,label:'Decompression stack',sub:'Calisthenics → Peloton → Stretch · 70 min',color:'#D85A30',type:'stack',duration:70,draggable:true},
    {mins:ws+70,label:'Post-workout shake',sub:'ON Whey + Fairlife · ~40g protein',color:'#1D9E75',type:'stack'},
    {mins:1050,label:'Family dinner',sub:'Plus-One strategy · ~40g protein',color:'#378ADD',type:'stack'},
    {mins:zynCurfew,label:'Zyn curfew',sub:`11 hrs before ${minsToFmt(nextWakeMins)} wake · REM protection`,color:'#7F77DD',type:'stack'},
    {mins:digitalSunset,label:'Digital sunset',sub:`Screens off · 8 hrs before ${minsToFmt(nextWakeMins)} wake`,color:'#534AB7',type:'stack'},
  ].filter(e=>e.mins>=0);
}

function getFirstMeetingMins(calEvents, fallbackHour) {
  if(calEvents.length){
    return [...calEvents].sort((a,b)=>a.mins-b.mins)[0].mins;
  }
  return fallbackHour*60;
}

function getConflicts(calEvents, ws) {
  const blocks=[
    {label:'Pre-workout fuel window',start:ws-60,end:ws},
    {label:'Decompression stack',start:ws,end:ws+70},
    {label:'Family dinner',start:1050,end:1110},
  ];
  const conflicts=[];
  for(const ev of calEvents){
    for(const b of blocks){
      if(ev.mins<b.end&&ev.endMins>b.start){
        conflicts.push(`"${ev.label}" (${minsToFmt(ev.mins)}–${minsToFmt(ev.endMins)}) overlaps your ${b.label}`);
      }
    }
  }
  return conflicts;
}
