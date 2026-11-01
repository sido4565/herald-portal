(() => {
  const role = document.body.classList.contains('admin-body') && document.getElementById('adminName') ? 'admin' : 'lecturer';
  const root = document.createElement('details'); root.className = 'voice-assistant';
  root.innerHTML = `<summary>🎙️ Voice Assistant</summary><div class="va-content"><div class="va-log" aria-live="polite"></div><form class="va-compose"><input aria-label="Voice command" placeholder="Try: schedule a live class" autocomplete="off"><button type="button" class="va-mic" aria-label="Start voice input">🎙️</button><button>Send</button></form><div class="va-actions"></div><p class="va-hint">Speech recognition requires a supported browser and microphone permission. Review every action before it is saved.</p></div>`;
  document.body.appendChild(root);
  // The commands now run inside Herald Help. Keep this legacy controller
  // mounted for its authenticated API workflows, but do not show a second UI.
  root.hidden = true;
  const log=root.querySelector('.va-log'), form=root.querySelector('form'), input=form.querySelector('input'), actions=root.querySelector('.va-actions');
  let draft=null, waiting=null;
  const MEETING_LINK_KEY='herald_voice_last_meeting_link';
  let lastMeetingUrl='';
  try{lastMeetingUrl=sessionStorage.getItem(MEETING_LINK_KEY)||'';}catch{}
  const rememberMeetingUrl=url=>{lastMeetingUrl=url;try{sessionStorage.setItem(MEETING_LINK_KEY,url);}catch{}};
  const say=(who,msg)=>{const p=document.createElement('p');p.className='va-msg';const b=document.createElement('b');b.textContent=who;const span=document.createElement('span');span.textContent=msg;p.append(b,span);log.append(p);log.scrollTop=log.scrollHeight;window.dispatchEvent(new CustomEvent('herald-help-bot-reply',{detail:{who,msg}}));};
  const api=async(url,opts={})=>{const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...opts,body:opts.body?JSON.stringify(opts.body):undefined});let x={};try{x=await r.json()}catch{}if(!r.ok)throw Error(x.error||`Request failed (${r.status})`);return x;};
  const normalize=value=>String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const match=(list,text,key='title')=>{
    const query=normalize(text).replace(/\b(schedule|create|plan|a|the|live|class|session|in|for|course)\b/g,' ').replace(/\s+/g,' ').trim();
    const exact=list.find(x=>{const title=normalize(x[key]);const code=normalize(x.code);return (title&&query.includes(title))||(code&&query.split(' ').includes(code));});
    if(exact)return exact;
    const ranked=list.map(item=>({item,score:normalize(item[key]).split(' ').filter(word=>word.length>2&&query.split(' ').includes(word)).length})).sort((a,b)=>b.score-a.score);
    return ranked[0]?.score>=2?ranked[0].item:null;
  };
  function parseStartTime(value){
    const text=value.trim().replace(/\b([ap])\s*\.\s*m\.?/gi,'$1m');
    const direct=new Date(text);
    if(!Number.isNaN(direct.getTime())&&/\d/.test(text))return direct;
    const clock=text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if(!clock)return null;
    const date=new Date();
    if(/\btom+o?r+ow\b/i.test(text))date.setDate(date.getDate()+1);
    else if(!/\btoday\b/i.test(text))return null;
    let hour=Number(clock[1])%12;
    if(clock[3].toLowerCase()==='pm')hour+=12;
    date.setHours(hour,Number(clock[2]||0),0,0);
    return date;
  }
  const getData=async()=>role==='admin'?Promise.all([api('/api/admin/courses'),api('/api/admin/lecturers')]):Promise.all([api('/api/lecturer/my-courses'),Promise.resolve([])]);
  const clearActions=()=>actions.replaceChildren();
  function review(){clearActions();if(!draft)return;const confirm=document.createElement('button');confirm.textContent='Confirm and save';confirm.onclick=save;const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='Cancel';cancel.onclick=()=>{draft=null;clearActions();say('Assistant','Draft cancelled.');};actions.append(confirm,cancel);say('Assistant',summary());}
  const summary=()=>draft.kind==='class'?`Schedule “${draft.title}” for ${draft.course.title} on ${new Date(draft.scheduled_at).toLocaleString()} (${draft.duration_minutes} min), link ${draft.meeting_url}.` : draft.kind==='assign'?`Assign ${draft.lecturer.name} to ${draft.course.code} — ${draft.course.title}.`:`Mark ${draft.records.length} student(s) ${draft.records[0]?.status} in ${draft.course.title} for ${draft.date}.`;
  async function save(){const btn=actions.querySelector('button');btn.disabled=true;try{if(draft.kind==='class'){if(!draft.course?.id||!draft.title||!draft.meeting_url||!draft.scheduled_at)throw Error('I still need the course, class title, start date and time, and meeting link.');await api(role==='admin'?'/api/admin/live-classes':'/api/lecturer/live-classes',{method:'POST',body:{course_id:draft.course.id,title:draft.title,description:draft.description||'',meeting_url:draft.meeting_url,scheduled_at:draft.scheduled_at,duration_minutes:draft.duration_minutes||60,notify:draft.notify!==false}});}else if(draft.kind==='assign'){await api(`/api/admin/courses/${draft.course.id}/assign-lecturer`,{method:'POST',body:{lecturer_id:draft.lecturer.id}});}else{await api(role==='admin'?'/api/admin/attendance':'/api/lecturer/attendance',{method:'POST',body:{course_id:draft.course.id,date:draft.date,records:draft.records}});}say('Assistant','Done. The portal saved that change.');draft=null;clearActions();window.heraldVoiceTaskActive=false;}catch(e){btn.disabled=false;say('Assistant',e.message);}}
  async function process(raw){const text=raw.trim();if(!text)return;window.heraldVoiceTaskActive=true;say('You',text);const low=text.toLowerCase();if(/^(no|cancel|never mind|stop)$/i.test(low)){draft=null;waiting=null;clearActions();window.heraldVoiceTaskActive=false;say('Assistant','Cancelled.');return;}if(draft&&/\b(go ahead|proceed|yes|confirm|save|do it|schedule it|create it)\b/i.test(low)){await save();return;}if(draft?.kind==='class'&&/\b(schedule|create|plan)\b/i.test(low)&&/\b(class|session|live)\b/i.test(low)){await askClassField();return;}
    try{
      if(waiting){const step=waiting;waiting=null;await step(text);return;}
      const [courses,lecturers]=await getData();
      if(/assign|allocate/.test(low)&&role==='admin'){
        let course=match(courses,text),lecturer=match(lecturers,text,'name');
        if(!course){waiting=async answer=>{draft={kind:'assign',course:match(courses,answer)};if(!draft.course){say('Assistant','I could not match that course. Please use its code or full title.');waiting=waitingCourse;return;}await askLecturer();};say('Assistant','Which course should I assign?');return;}
        draft={kind:'assign',course,lecturer};if(!lecturer){await askLecturer();return;}review();return;
      }
      if(/attendance|register|mark (everyone|all|the)/.test(low)){
        let course=match(courses,text);const status=(low.match(/\b(present|absent|late|excused)\b/)||[])[1];const date=(text.match(/\b\d{4}-\d{2}-\d{2}\b/)||[])[0]||new Date().toISOString().slice(0,10);
        if(!status){say('Assistant','Which status should I mark: present, absent, late, or excused? For now, voice marking applies one status to the entire course roster.');return;}
        if(!course){const selectCourse=async answer=>{course=match(courses,answer);if(!course){say('Assistant','I could not find that course. Say its code or title.');waiting=selectCourse;return;}await prepareRoster(course,date,status);};waiting=selectCourse;say('Assistant','Which course is this attendance for?');return;}await prepareRoster(course,date,status);return;
      }
      if(/schedule|create|plan/.test(low)&&/class|session|live/.test(low)){
        const course=match(courses,text),named=text.match(/\b(?:called|named|titled)\s+(.+?)(?:\s+for\s+|\s+in\s+|$)/i);
        const title=named?.[1]?.trim()||(course?`${course.title} Live Class`:'Live Class');
        const start=parseStartTime(text),link=text.match(/https?:\/\/\S+/)?.[0]||'';
        if(link)rememberMeetingUrl(link);
        draft={kind:'class',course,title,scheduled_at:start?.toISOString()||'',meeting_url:link||lastMeetingUrl,duration_minutes:60,description:'',notify:true};
        await askClassField();return;
      }
      window.heraldVoiceTaskActive=false;
      say('Assistant',role==='admin'?'Try “schedule a live class”, “assign [course] to [lecturer]”, or “mark [course] attendance present”.':'Try “schedule a live class” or “mark [course] attendance present”.');
    }catch(e){window.heraldVoiceTaskActive=false;say('Assistant',e.message);}
  }
  window.addEventListener('herald-help-command', event => { process(String(event.detail || '')); });
  window.heraldVoiceTaskActive = false;
  let waitingCourse=()=>{};
  async function askLecturer(){const lecturers=await api('/api/admin/lecturers');waiting=answer=>{draft.lecturer=match(lecturers,answer,'name')||match(lecturers,answer,'staff_no');if(!draft.lecturer){say('Assistant','I could not find that lecturer. Please say their full name.');waiting=askLecturer;return;}review();};say('Assistant','Which lecturer? Say their name.');}
  async function prepareRoster(course,date,status){const roster=await api(role==='admin'?`/api/admin/courses/${course.id}/students`:`/api/lecturer/courses/${course.id}/students`);if(!roster.length){say('Assistant','There are no enrolled students in that course.');return;}draft={kind:'attendance',course,date,records:roster.map(s=>({student_id:s.id,status,notes:''}))};review();}
  async function askClassField(){if(!draft.course){let coursesCache=[];const data=await getData();coursesCache=data[0];waiting=async answer=>{draft.course=match(coursesCache,answer);if(!draft.course){say('Assistant','I could not match that course. Please say its course code or a few words from its title.');await askClassField();return;}if(draft.title==='Live Class')draft.title=`${draft.course.title} Live Class`;const start=parseStartTime(answer);if(start)draft.scheduled_at=start.toISOString();const link=answer.match(/https?:\/\/\S+/)?.[0];if(link){draft.meeting_url=link;rememberMeetingUrl(link);}await askClassField();};say('Assistant','Which course is the live class for? Say its course code or title.');return;}if(!draft.scheduled_at){waiting=async answer=>{const d=parseStartTime(answer);if(!d){say('Assistant','Please include a date and time, such as “today at 6:00 p.m.” or “tomorrow at 4 pm”.');await askClassField();return;}draft.scheduled_at=d.toISOString();const link=answer.match(/https?:\/\/\S+/)?.[0];if(link){draft.meeting_url=link;rememberMeetingUrl(link);}await askClassField();};say('Assistant','When should it start? You can say “today at 6:00 p.m.” or give a date and time.');return;}if(!draft.meeting_url){waiting=async answer=>{draft.meeting_url=answer.match(/https?:\/\/\S+/)?.[0]||'';if(!draft.meeting_url){say('Assistant','Please provide a full meeting URL beginning with https://');await askClassField();return;}rememberMeetingUrl(draft.meeting_url);await askClassField();};say('Assistant','What meeting link should students use?');return;}review();}
  form.addEventListener('submit',e=>{e.preventDefault();const v=input.value;input.value='';process(v);});
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;const mic=form.querySelector('.va-mic');if(!SR){mic.disabled=true;mic.title='Speech recognition is unavailable in this browser';}else mic.onclick=()=>{const rec=new SR();rec.lang='en-KE';rec.interimResults=false;rec.onresult=e=>{input.value=e.results[0][0].transcript;process(input.value);input.value='';};rec.onerror=()=>say('Assistant','I could not access speech recognition. Check microphone permission or type your request.');rec.start();};
  say('Assistant',`I’m ready. Tell me what you need to do${role==='admin'?'—schedule a class, assign a course, or mark attendance.':'—schedule a class or mark attendance.'}`);
  root.remove();
})();
