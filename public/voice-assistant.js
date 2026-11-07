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
  const adminAreas={
    students:['students','#addStudentBtn'], admissions:['admissions',null], lecturers:['lecturers','#addLecturerBtn'],
    'password requests':['password-resets',null], courses:['courses','#addCourseBtn'], announcements:['announcements','#addAnnBtn'],
    jobs:['jobs','#addJobBtn'], results:['results','#addResultBtn'], fees:['fees','#addFeeBtn'], timetable:['timetable','#addTTBtn'],
    assignments:['assignments','#addAsgBtn'], attendance:['attendance','#takeAttendanceBtn'],
    'lecturer attendance':['lecturer-attendance',null], materials:['materials','#adminAddMaterialBtn'],
    'books and materials':['materials','#adminAddMaterialBtn'], 'live classes':['liveclasses','#addLiveClassBtn'], exams:['exams',null]
  };
  function startAdminForm(text){
    const normalized=normalize(text);
    const area=Object.keys(adminAreas).sort((a,b)=>b.length-a.length).find(name=>{const key=normalize(name);return normalized.includes(key)||normalized.includes(key.replace(/s$/,''));});
    if(!area)return false;
    const [panel,defaultButton]=adminAreas[area];
    const button=role==='lecturer'&&panel==='assignments'?null:defaultButton;
    if(panel==='courses'&&/\b(assign|allocate)\b/.test(normalized))return false;
    if(panel==='liveclasses'&&/\b(schedule|create|plan)\b/.test(normalized)&&/\b(class|session|live)\b/.test(normalized))return false;
    if(panel==='attendance'&&/\b(mark|register)\b/.test(normalized)&&/\b(present|absent|late|excused)\b/.test(normalized))return false;
    if(panel==='exams'){
      if(/\b(open|show|go to)\b/.test(normalized)){location.href='admin-exams.html';return true;}
      say('Assistant','Open Exams first, then say “create exam” or “publish [exam title]”.');window.heraldVoiceTaskActive=false;return true;
    }
    const openDialog=[...document.querySelectorAll('.modal-overlay')].find(node=>node.id==='modal'?!node.classList.contains('hidden'):node.isConnected);
    if(openDialog){say('Assistant','A form is already open. Save or close that form first; I will not submit it as a different action.');window.heraldVoiceTaskActive=false;return true;}
    document.querySelector(`.admin-tab[data-panel="${panel}"]`)?.click();
    if(!button){say('Assistant',`I opened ${area}. Use a command such as “approve [name]” or “load today” and I’ll guide the action.`);window.heraldVoiceTaskActive=false;return true;}
    const formAction=/\b(add|new|create|post|publish|upload|schedule|take|record|enter)\b/.test(normalized);
    const attendanceAction=panel==='attendance'&&/\b(present|absent|late)\b/.test(normalized);
    if(!formAction&&!attendanceAction){
      say('Assistant',`I opened ${area}. To make a change, say “create ${area}” or “publish a ${area==='jobs'?'job':'new announcement'}”.`);window.heraldVoiceTaskActive=false;return true;
    }
    document.querySelector(button)?.click();
    waitForAdminForm(area,text);
    return true;
  }
  async function waitForAdminForm(area,command){const expected=modalTitles[area];for(let i=0;i<60;i++){if(area==='attendance'&&document.querySelector('#attForm')){beginAttendanceVoice(command);return;}if(expected&&document.querySelector('#modalTitle')?.textContent.trim()===expected&&document.querySelector('#modalForm')?.elements.length){beginModalVoice(command,area);return;}await new Promise(resolve=>setTimeout(resolve,100));}say('Assistant','The requested form did not open. Please open it in the dashboard and try again.');window.heraldVoiceTaskActive=false;}
  const modalTitles={students:'Add Student',lecturers:'Add Lecturer',courses:'Add Course',announcements:'New Announcement',jobs:'Post a Job',results:'Add Result',fees:'Add Fee Record',timetable:'Add Timetable Slot',assignments:'New Assignment','live classes':'Schedule Live Class'};
  function fieldLabel(field){return field.labels?.[0]?.textContent||field.previousElementSibling?.tagName==='LABEL'&&field.previousElementSibling.textContent||field.name.replace(/_/g,' ');}
  function beginModalVoice(command,area){
    const form=document.querySelector('#modalForm');
    const expected=modalTitles[area];
    if(!form||!form.elements.length||!expected||document.querySelector('#modalTitle')?.textContent.trim()!==expected){say('Assistant','I could not verify the form for that action. Close any open dialog, then repeat the command.');window.heraldVoiceTaskActive=false;return;}
    const fields=[...form.elements].filter(el=>el.name&&!el.disabled);
    if(!fields.length){say('Assistant','I could not find any fields in that form. I will not submit it.');window.heraldVoiceTaskActive=false;return;}
    draft={kind:'admin-form',form,fields,index:0,values:{},command,area};
    askModalField();
  }
  function beginAttendanceVoice(){const form=document.querySelector('#attForm');if(!form){say('Assistant','I could not open the attendance form. Close any open dialog and try again.');window.heraldVoiceTaskActive=false;return;}draft={kind:'admin-attendance',form,step:0,course:form.querySelector('#attFormCourse'),date:form.querySelector('#attFormDate'),status:''};say('Assistant','Which course should I take attendance for? Say the course code or title.');}
  function askModalField(){
    if(!draft||draft.kind!=='admin-form')return;
    while(draft.index<draft.fields.length){const el=draft.fields[draft.index];if(el.value){draft.values[el.name]=el.value;draft.index++;continue;}break;}
    if(draft.index>=draft.fields.length){clearActions();const b=document.createElement('button');b.textContent='Confirm and save';b.onclick=submitVoiceForm;const c=document.createElement('button');c.className='secondary';c.textContent='Cancel';c.onclick=()=>{document.querySelector('#modalCancel')?.click();draft=null;clearActions();say('Assistant','Cancelled.');};actions.append(b,c);const preview=draft.fields.map(field=>`${fieldLabel(field)}: ${draft.values[field.name]||'—'}`).join('; ');say('Assistant',`Review before saving: ${preview}. Say “confirm” to submit or “cancel”.`);return;}
    const field=draft.fields[draft.index];const hint=field.type==='date'?' Use YYYY-MM-DD.':field.type==='datetime-local'?' Use YYYY-MM-DDTHH:MM, for example 2026-11-05T14:30.':field.type==='email'?' Say the complete email address.':field.tagName==='TEXTAREA'?' You can type long text into the Help box if that is easier.':'';say('Assistant',`${fieldLabel(field)}${field.required?' (required)':''}?${hint} Say “skip” for an optional field.`);
  }
  async function submitVoiceForm(){const btn=actions.querySelector('button');if(btn)btn.disabled=true;try{for(const [key,value] of Object.entries(draft.values)){const el=[...draft.form.elements].find(item=>item.name===key);if(el)el.value=value;}if(!draft.form.reportValidity())throw Error('A required field or value is invalid. Please correct it before saving.');draft.form.requestSubmit();draft=null;clearActions();window.heraldVoiceTaskActive=false;say('Assistant','Submitted. The admin form is saving your change.');}catch(e){if(btn)btn.disabled=false;say('Assistant',e.message);}}
  async function submitAttendance(){const btn=actions.querySelector('button');if(btn)btn.disabled=true;try{draft.form.querySelectorAll('.att-status').forEach(select=>select.value=draft.status);draft.form.querySelector('#attSaveBtn').click();draft=null;clearActions();window.heraldVoiceTaskActive=false;say('Assistant','Attendance submitted for the selected course.');}catch(e){if(btn)btn.disabled=false;say('Assistant',e.message);}}
  function attendanceReview(){clearActions();const confirm=document.createElement('button');confirm.textContent='Confirm and save';confirm.onclick=submitAttendance;const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.className='secondary';cancel.onclick=()=>{draft.form.closest('.modal-overlay')?.remove();draft=null;clearActions();window.heraldVoiceTaskActive=false;say('Assistant','Attendance cancelled.');};actions.append(confirm,cancel);say('Assistant',`Review: mark ${draft.studentCount} enrolled student(s) ${draft.status} in ${draft.courseLabel} for ${draft.date.value}. Confirm to save.`);}
  async function waitForAttendanceRows(){for(let i=0;i<40;i++){if(draft?.form.querySelectorAll('.att-status').length)return true;await new Promise(resolve=>setTimeout(resolve,100));}return false;}
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
  const summary=()=>draft.kind==='class'?`Schedule “${draft.title}” for ${draft.course.title} on ${new Date(draft.scheduled_at).toLocaleString()} (${draft.duration_minutes} min). Students join inside Herald.` : draft.kind==='assign'?`Assign ${draft.lecturer.name} to ${draft.course.code} — ${draft.course.title}.` : draft.kind==='lecturer-attendance'?`Mark ${draft.records.length} lecturer(s) ${draft.records[0]?.status} for ${draft.date}${draft.records[0]?.name?`: ${draft.records[0].name}`:''}.` : draft.kind==='admin-action'?`${draft.verb==='approve'?'Approve':'Reject'} ${draft.type} application for ${draft.person.name}.` : draft.kind==='admin-reminders'?'Send fee reminder emails to all students with outstanding balances.':draft.kind==='cat-generation'?`Generate a five-question CAT for ${draft.course.code} — ${draft.course.title}, focused on: ${draft.topics}. It will be saved as an unpublished draft for review.`:`Mark ${draft.records.length} student(s) ${draft.records[0]?.status} in ${draft.course.title} for ${draft.date}.`;
  async function save(){const btn=actions.querySelector('button');btn.disabled=true;try{let result;if(draft.kind==='class'){if(!draft.course?.id||!draft.title||!draft.scheduled_at)throw Error('I still need the course, class title, and start date and time.');await api(role==='admin'?'/api/admin/live-classes':'/api/lecturer/live-classes',{method:'POST',body:{course_id:draft.course.id,title:draft.title,description:draft.description||'',scheduled_at:draft.scheduled_at,duration_minutes:draft.duration_minutes||60,notify:draft.notify!==false}});}else if(draft.kind==='assign'){await api(`/api/admin/courses/${draft.course.id}/assign-lecturer`,{method:'POST',body:{lecturer_id:draft.lecturer.id}});}else if(draft.kind==='lecturer-attendance'){await api('/api/admin/lecturer-attendance',{method:'POST',body:{date:draft.date,records:draft.records}});}else if(draft.kind==='admin-action'){await api(draft.endpoint,{method:'POST'});}else if(draft.kind==='admin-reminders'){result=await api('/api/admin/send-fee-reminders',{method:'POST'});}else if(draft.kind==='cat-generation'){const prefix=role==='admin'?'/api/admin':'/api/lecturer';result=await api(`${prefix}/courses/${draft.course.id}/generate-cat`,{method:'POST',body:{topics:draft.topics}});}else{await api(role==='admin'?'/api/admin/attendance':'/api/lecturer/attendance',{method:'POST',body:{course_id:draft.course.id,date:draft.date,records:draft.records}});}say('Assistant',draft.kind==='admin-reminders'?`Sent ${result.sent} of ${result.total} fee reminder email(s).`:draft.kind==='cat-generation'?`Created a ${result.question_count}-question CAT draft for ${draft.course.code}. Review its questions and publish it from Exams → when ready.`:'Done. The portal saved that change.');draft=null;clearActions();window.heraldVoiceTaskActive=false;}catch(e){btn.disabled=false;say('Assistant',e.message);}}
  async function process(raw){const text=raw.trim();if(!text)return;window.heraldVoiceTaskActive=true;say('You',text);const low=text.toLowerCase();if(/^(no|cancel|never mind|stop)$/i.test(low)){const active=draft?.form;draft=null;waiting=null;clearActions();if(active?.id==='attForm')active.closest('.modal-overlay')?.remove();else document.querySelector('#modalCancel')?.click();window.heraldVoiceTaskActive=false;say('Assistant','Cancelled.');return;}if(role&&!draft){const openDialog=[...document.querySelectorAll('.modal-overlay')].find(node=>node.id==='modal'?!node.classList.contains('hidden'):node.isConnected);if(openDialog){say('Assistant','A form is already open. Save or close it first, then repeat the voice command.');window.heraldVoiceTaskActive=false;return;}}if(draft?.kind==='cat-generation'){
      if(draft.step==='course'){const course=match(draft.courses,text);if(!course){say('Assistant','I could not match that course. Please say its course code or full title.');return;}draft.course=course;draft.step='topics';say('Assistant',`Which topics should the CAT for ${course.code} — ${course.title} cover? Please name the units, chapters, or concepts.`);return;}
      if(draft.step==='topics'){if(text.length<3||text.length>1000){say('Assistant','Please provide topic feedback between 3 and 1,000 characters.');return;}draft.topics=text;draft.step='review';review();return;}
      if(draft.step==='review'&&/\b(confirm|yes|proceed|go ahead|generate|create it)\b/i.test(low)){await save();return;}say('Assistant','Say “confirm” to generate this CAT draft or “cancel” to discard it.');return;
    }if(draft?.kind==='admin-attendance'){
      if(draft.step===0){const query=normalize(text);const option=[...draft.course.options].find(item=>item.value&&(normalize(item.textContent)===query||normalize(item.textContent).includes(query)||query.includes(normalize(item.textContent))));if(!option){say('Assistant',`I couldn't match that course. Choose from: ${[...draft.course.options].filter(item=>item.value).map(item=>item.textContent).join('; ')}.`);return;}draft.course.value=option.value;draft.courseLabel=option.textContent;draft.course.dispatchEvent(new Event('change',{bubbles:true}));if(!await waitForAttendanceRows()){say('Assistant','No enrolled students were found for that course.');return;}draft.studentCount=draft.form.querySelectorAll('.att-status').length;draft.step=1;say('Assistant',`I found ${draft.studentCount} enrolled student(s). Which status should I apply: present, absent, or late?`);return;}
      if(draft.step===1){const status=(low.match(/\b(present|absent|late)\b/)||[])[1];if(!status){say('Assistant','Please choose present, absent, or late.');return;}draft.status=status;draft.step=2;attendanceReview();return;}
      if(/\b(confirm|save|yes|proceed|go ahead)\b/i.test(low)){await submitAttendance();return;}say('Assistant','Say “confirm” to save or “cancel” to discard.');return;
    }if(draft?.kind==='admin-form'){
      if(/^(go ahead|proceed|yes|confirm|save|do it|publish it|create it)$/i.test(low)){await submitVoiceForm();return;}
      if(/^(skip|next)$/i.test(low)){const field=draft.fields[draft.index];if(field?.required){say('Assistant','That field is required. Please provide a value.');return;}draft.index++;askModalField();return;}
      const field=draft.fields[draft.index];if(!field){askModalField();return;}let value=text;
      if(field.tagName==='SELECT'){const option=[...field.options].find(o=>normalize(o.textContent)===normalize(text)||normalize(o.textContent).includes(normalize(text)));if(!option){say('Assistant',`Please choose one of: ${[...field.options].filter(o=>o.value).map(o=>o.textContent).join(', ')}.`);return;}value=option.value;}
      if(field.type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(value)){say('Assistant','Please say the full date as YYYY-MM-DD, or say “skip” if it is optional.');return;}
      if(field.type==='datetime-local'&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)){say('Assistant','Please say the date and time as YYYY-MM-DDTHH:MM.');return;}
      const original=field.value;field.value=value;const valid=field.checkValidity();field.value=original;if(!valid){say('Assistant',field.type==='date'?'Please say a full date as YYYY-MM-DD.':'That value is not valid for this field. Please try again.');return;}draft.values[field.name]=value;draft.index++;askModalField();return;
    }if(draft&&/\b(go ahead|proceed|yes|confirm|save|do it|schedule it|create it)\b/i.test(low)){await save();return;}if(draft?.kind==='class'&&/\b(schedule|create|plan)\b/i.test(low)&&/\b(class|session|live)\b/i.test(low)){await askClassField();return;}
    try{
      if(waiting){const step=waiting;waiting=null;await step(text);return;}
      if(role&&/\b(generate|create|make|build)\b/.test(low)&&/\b(cat|class assessment test)\b/.test(low)){await beginCatGeneration(text);return;}
      if(role==='admin'&&/\b(send|issue)\b/.test(low)&&/\bfee\b/.test(low)&&/\b(reminder|reminders)\b/.test(low)){if([...document.querySelectorAll('.modal-overlay')].some(node=>node.id==='modal'?!node.classList.contains('hidden'):node.isConnected)){say('Assistant','A form is already open. Save or close it before sending fee reminders.');window.heraldVoiceTaskActive=false;return;}draft={kind:'admin-reminders'};review();return;}
      if(role==='admin'&&/\b(approve|reject)\b/i.test(text)){if(await prepareNamedApproval(text))return;}
      if(role==='admin'&&(/\blecturers?\b|\b(?:dr|mr|mrs|ms)\b/i.test(text))&&/\b(attendance|present|absent|late|excused)\b/.test(low)){if(await prepareLecturerAttendance(text))return;}
      if(role==='admin'&&startAdminForm(text))return;
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
        const start=parseStartTime(text);
        draft={kind:'class',course,title,scheduled_at:start?.toISOString()||'',duration_minutes:60,description:'',notify:true};
        await askClassField();return;
      }
      window.heraldVoiceTaskActive=false;
      say('Assistant',role==='admin'?'Say “open students”, “create a course”, “publish an announcement”, “publish a job”, or “open exams”.':'Try “schedule a live class” or “mark [course] attendance present”.');
    }catch(e){window.heraldVoiceTaskActive=false;say('Assistant',e.message);}
  }
  window.addEventListener('herald-help-command', event => { process(String(event.detail || '')); });
  window.heraldVoiceTaskActive = false;
  let waitingCourse=()=>{};
  async function askLecturer(){const lecturers=await api('/api/admin/lecturers');waiting=answer=>{draft.lecturer=match(lecturers,answer,'name')||match(lecturers,answer,'staff_no');if(!draft.lecturer){say('Assistant','I could not find that lecturer. Please say their full name.');waiting=askLecturer;return;}review();};say('Assistant','Which lecturer? Say their name.');}
  async function prepareLecturerAttendance(command){
    const openDialog=[...document.querySelectorAll('.modal-overlay')].find(node=>node.id==='modal'?!node.classList.contains('hidden'):node.isConnected);
    if(openDialog){say('Assistant','A form is already open. Save or close that form first; I will not submit it as a different action.');window.heraldVoiceTaskActive=false;return true;}
    const lecturers=await api('/api/admin/lecturers');
    const status=(command.toLowerCase().match(/\b(present|absent|late|excused)\b/)||[])[1];
    const date=(command.match(/\b\d{4}-\d{2}-\d{2}\b/)||[])[0]||new Date().toISOString().slice(0,10);
    const approved=lecturers.filter(item=>item.approved&&item.status!=='rejected');
    let selected=[];
    if(/\b(all|every|everyone)\b/.test(command.toLowerCase()))selected=approved;
    else{
      const query=normalize(command).replace(/\b(attendance|mark|present|absent|late|excused|today|lecturer|lecturers|please|dr|mr|mrs|ms)\b/g,' ').trim();
      const ranked=approved.map(item=>({item,score:normalize(item.name).split(' ').filter(word=>word.length>1&&query.split(' ').includes(word)).length})).sort((a,b)=>b.score-a.score);
      if(!ranked[0]?.score){say('Assistant','Say a lecturer’s name, for example “mark Dr Obara lecturer attendance present”.');return true;}
      if(ranked[1]?.score===ranked[0].score){say('Assistant',`I found more than one match. Please say the lecturer’s full name. Matches: ${ranked.filter(item=>item.score===ranked[0].score).map(item=>item.item.name).join(', ')}.`);return true;}
      selected=[ranked[0].item];
    }
    if(!selected.length){say('Assistant','There are no approved lecturers to mark.');return true;}
    const makeDraft=value=>{draft={kind:'lecturer-attendance',date,records:selected.map(item=>({lecturer_id:Number(item.id),name:item.name,status:value,notes:''}))};review();};
    if(status)makeDraft(status);else{const askStatus=()=>{waiting=answer=>{const value=(answer.toLowerCase().match(/\b(present|absent|late|excused)\b/)||[])[1];if(!value){say('Assistant','Please say present, absent, late, or excused.');askStatus();return;}makeDraft(value);};say('Assistant','Which status should I record: present, absent, late, or excused?');};askStatus();}
    return true;
  }
  async function prepareNamedApproval(command){
    const openDialog=[...document.querySelectorAll('.modal-overlay')].find(node=>node.id==='modal'?!node.classList.contains('hidden'):node.isConnected);
    if(openDialog){say('Assistant','A form is already open. Save or close that form first, then repeat the approval request.');window.heraldVoiceTaskActive=false;return true;}
    const reject=/\breject\b/i.test(command),verb=reject?'reject':'approve';
    const explicitLecturer=/\blemploy(?:ee)?|lecturer\b/i.test(command),explicitStudent=/\bstudent|admission|application\b/i.test(command);
    const target=normalize(command).replace(/\b(approve|reject|the|student|lecturer|admission|application|applicant|please)\b/g,' ').trim();
    if(!target){say('Assistant',`Say “${verb}” followed by the student or lecturer name.`);return true;}
    const [lecturers,students]=await Promise.all([api('/api/admin/lecturers'),api('/api/admin/students')]);
    const score=(person)=>normalize(person.name).split(' ').filter(word=>word.length>1&&target.split(' ').includes(word)).length;
    let choices=[];
    if(!explicitStudent)choices.push(...lecturers.filter(person=>!person.approved&&person.status!=='rejected').map(person=>({person,type:'lecturer',score:score(person)})));
    if(!explicitLecturer)choices.push(...students.filter(person=>person.status==='pending').map(person=>({person,type:'student',score:score(person)})));
    choices=choices.filter(item=>item.score>0).sort((a,b)=>b.score-a.score);
    if(!choices.length){say('Assistant',`I couldn't find a pending student or lecturer matching “${target}”.`);return true;}
    const best=choices[0].score,matches=choices.filter(item=>item.score===best);
    if(matches.length>1){say('Assistant',`I found multiple pending applications. Please specify student or lecturer, and say the full name.`);return true;}
    const {person,type}=matches[0],endpoint=type==='lecturer'?`/api/admin/lecturers/${person.id}/${verb}`:`/api/admin/students/${person.id}/${verb}`;
    draft={kind:'admin-action',person,type,verb,endpoint};review();return true;
  }
  async function beginCatGeneration(command=''){
    const selectedId=document.querySelector('#assignmentCatCourse')?.value;
    if(!document.querySelector('.admin-tab[data-panel="assignments"]')?.classList.contains('active'))document.querySelector('.admin-tab[data-panel="assignments"]')?.click();
    const courses=await api(role==='admin'?'/api/admin/courses':'/api/lecturer/my-courses');
    if(!courses.length){say('Assistant','There are no courses available for your account to generate a CAT for.');window.heraldVoiceTaskActive=false;return;}
    const selectedCourse=courses.find(course=>String(course.id)===String(selectedId));
    const course=match(courses,command)||selectedCourse||(courses.length===1?courses[0]:null);
    draft={kind:'cat-generation',courses,course,step:course?'topics':'course'};
    if(course){say('Assistant',`Which topics should the CAT for ${course.code} — ${course.title} cover? Please name the units, chapters, or concepts.`);return;}
    say('Assistant','Which of your courses should the CAT be for? Say its course code or title.');
  }
  async function prepareRoster(course,date,status){const roster=await api(role==='admin'?`/api/admin/courses/${course.id}/students`:`/api/lecturer/courses/${course.id}/students`);if(!roster.length){say('Assistant','There are no enrolled students in that course.');return;}draft={kind:'attendance',course,date,records:roster.map(s=>({student_id:s.id,status,notes:''}))};review();}
  async function askClassField(){if(!draft.course){const data=await getData();waiting=async answer=>{draft.course=match(data[0],answer);if(!draft.course){say('Assistant','I could not match that course. Please say its course code or a few words from its title.');await askClassField();return;}if(draft.title==='Live Class')draft.title=`${draft.course.title} Live Class`;const start=parseStartTime(answer);if(start)draft.scheduled_at=start.toISOString();await askClassField();};say('Assistant','Which course is the live class for? Say its course code or title.');return;}if(!draft.scheduled_at){waiting=async answer=>{const d=parseStartTime(answer);if(!d){say('Assistant','Please include a date and time, such as “today at 6:00 p.m.” or “tomorrow at 4 pm”.');await askClassField();return;}draft.scheduled_at=d.toISOString();await askClassField();};say('Assistant','When should it start? You can say “today at 6:00 p.m.” or give a date and time.');return;}review();}
  form.addEventListener('submit',e=>{e.preventDefault();const v=input.value;input.value='';process(v);});
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;const mic=form.querySelector('.va-mic');if(!SR){mic.disabled=true;mic.title='Speech recognition is unavailable in this browser';}else mic.onclick=()=>{const rec=new SR();rec.lang='en-KE';rec.interimResults=false;rec.onresult=e=>{input.value=e.results[0][0].transcript;process(input.value);input.value='';};rec.onerror=()=>say('Assistant','I could not access speech recognition. Check microphone permission or type your request.');rec.start();};
  say('Assistant',`I’m ready. Tell me what you need to do${role==='admin'?'—schedule a class, assign a course, or mark attendance.':'—schedule a class or mark attendance.'}`);
  root.remove();
})();
