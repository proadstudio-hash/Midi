// Audio → MIDI — Multi‑Algorithm with robust no‑Worker fallback
let audioContext=null, audioBuffer=null, filteredBuffer=null;
let audioSource=null, isPlaying=false, currentTime=0;

let audioWorker=null, USE_WORKER=true;
let isAnalyzing=false, isCancelled=false;
let analysisStartTime=0, processedChunks=0, totalChunks=0;

let detectedNotes=[];
let DETECTED_FROM_WORKER=[];
let SAL_ROWS=[];
let SAL_HOP_SEC=null;

const ANALYSIS_MODES={ full:{fftSize:8192}, fast:{fftSize:4096}, fallback:{fftSize:2048}, cqt:{fftSize:16384} };
const CHUNK_SIZE=4096*32;
const MAX_FILE_SIZE_MB=200, WARNING_SIZE_MB=50, MAX_PROCESSING_TIME_SECONDS=900;
const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const A4=440;

// ===== Utility UI helpers =====
function noteName(m){ return NOTE_NAMES[m%12]; }
function formatFileSize(bytes){ const s=['B','KB','MB','GB']; if(!bytes) return '0 B'; const i=Math.floor(Math.log(bytes)/Math.log(1024)); return (bytes/Math.pow(1024,i)).toFixed(1)+' '+s[i]; }
function formatTime(sec){ const m=Math.floor(sec/60), s=Math.floor(sec%60); return `${m}:${String(s).padStart(2,'0')}`; }
function updateStatusIndicator(state,text){ const d=document.getElementById('statusDot'); if (d) d.className='dot '+state; const s=document.getElementById('statusText'); if (s) s.textContent=text; }
function updateProgress(pct,label){ const bar=document.getElementById('progressFill'); const cont=document.getElementById('progressContainer'); if (cont) cont.style.display='block'; if (bar) bar.style.width=Math.max(0,Math.min(100,pct))+'%'; const pr=document.getElementById('progressPercent'); if (pr) pr.textContent=Math.round(pct)+'%'; }
function showStatus(msg, level='info'){ const w=document.getElementById('warningMessage'); if (!w) return; w.textContent=msg; w.style.display='block'; w.style.color=(level==='success')?'#40c057':(level==='error'?'#fa5252':'#fab005'); setTimeout(()=>{w.style.display='none'}, 6000); }
function showWarn(m){ const w=document.getElementById('warningMessage'); if (!w) return; w.textContent='⚠️ '+m; w.style.color='#fab005'; w.style.display='block'; setTimeout(()=>{w.style.display='none'}, 6000); }

// ===== DOM Ready =====
document.addEventListener('DOMContentLoaded', () => {
  const upload = document.getElementById('uploadSection');
  const fileInput = document.getElementById('fileInput');
  if (upload){
    upload.addEventListener('dragover', e=>{ e.preventDefault(); upload.classList.add('drag'); });
    upload.addEventListener('dragleave', ()=> upload.classList.remove('drag'));
    upload.addEventListener('drop', e=>{ e.preventDefault(); upload.classList.remove('drag'); const f=e.dataTransfer.files; if (f && f.length) handleFile(f[0]); });
  }
  if (fileInput) fileInput.addEventListener('change', e=>{ if (e.target.files && e.target.files.length) handleFile(e.target.files[0]); });

  const btn = (id)=>document.getElementById(id);
  const pb=btn('playBtn'), pa=btn('pauseBtn'), st=btn('stopBtn'), pm=btn('playMidiBtn'), sm=btn('stopMidiBtn');
  if (pb) pb.addEventListener('click', playAudio);
  if (pa) pa.addEventListener('click', pauseAudio);
  if (st) st.addEventListener('click', stopAudio);
  if (pm) pm.addEventListener('click', playMidi);
  if (sm) sm.addEventListener('click', stopMidi);

  const speed=document.getElementById('playbackSpeed');
  if (speed) speed.addEventListener('input', e=>{
    const v=e.target.value; const lbl=document.getElementById('playbackSpeedValue'); if (lbl) lbl.textContent=v+'%';
    if (audioSource && audioSource.playbackRate) audioSource.playbackRate.value=v/100;
  });

  const thr=document.getElementById('threshold');
  if (thr) thr.addEventListener('input', e=>{ const lbl=document.getElementById('thresholdValue'); if (lbl) lbl.textContent=e.target.value; });

  ['hpfInput','lpfInput','minVelInput','minDurInput'].forEach(id=>{
    const el=document.getElementById(id);
    const lblMap={hpfInput:'hpfValue', lpfInput:'lpfValue', minVelInput:'minVelValue', minDurInput:'minDurValue'};
    if (el) el.addEventListener('input', e=>{ const v=e.target.value; const lbl=document.getElementById(lblMap[id]); if (lbl) lbl.textContent=v; if (id==='minVelInput' || id==='minDurInput') reRenderFiltered(); });
  });

  const reanalyze=document.getElementById('reanalyzeBtn');
  if (reanalyze) reanalyze.addEventListener('click', async ()=>{
    if (!audioBuffer) return;
    resetSalience();
    const thrV=parseInt((document.getElementById('threshold')||{}).value||'120');
    filteredBuffer = await applyPreFilters(audioBuffer,
      parseFloat((document.getElementById('hpfInput')||{}).value||'20'),
      parseFloat((document.getElementById('lpfInput')||{}).value||'20000'));
    analyzeAudio(filteredBuffer, thrV);
  });

  const exportBtn=document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportToMIDI);

  const cancelBtn=document.getElementById('cancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelAnalysis);

  const modeSel=document.getElementById('analysisMode');
  const algoSel=document.getElementById('algorithmSelect');
  if (modeSel) modeSel.addEventListener('change', ()=>{ if (audioBuffer && !isAnalyzing) reanalyze?.click(); });
  if (algoSel) algoSel.addEventListener('change', ()=>{ if (audioBuffer && !isAnalyzing) reanalyze?.click(); });

  initializeWorker();
  updateStatusIndicator('idle','Pronto');
});

// ===== Worker init with Blob fallback, else inline processing =====
async function initializeWorker(){
  try{
    audioWorker = new Worker('audio-worker.js');
    audioWorker.onmessage = (e)=>{
      const {type, chunkIndex, totalChunks, notes, salRows, hopSec, error} = e.data || {};
      if (type==='progress'){ handleWorkerProgress(chunkIndex, totalChunks, notes||[], salRows||[], hopSec); }
      else if (type==='error'){ showStatus('Worker error: '+error, 'error'); }
    };
    audioWorker.onerror = (err)=>{ console.error('Worker error', err); showStatus('Worker error: '+(err.message||err.filename||'unknown'),'error'); };
    USE_WORKER = true;
  }catch(err1){
    console.warn('Standard Worker failed. Trying Blob URL...', err1);
    try{
      const txt = await fetch('audio-worker.js').then(r=>r.text());
      const blob = new Blob([txt], {type:'application/javascript'});
      const url  = URL.createObjectURL(blob);
      audioWorker = new Worker(url);
      audioWorker.onmessage = (e)=>{
        const {type, chunkIndex, totalChunks, notes, salRows, hopSec, error} = e.data || {};
        if (type==='progress'){ handleWorkerProgress(chunkIndex, totalChunks, notes||[], salRows||[], hopSec); }
        else if (type==='error'){ showStatus('Worker error: '+error, 'error'); }
      };
      audioWorker.onerror = (err)=>{ console.error('Worker error', err); showStatus('Worker error: '+(err.message||err.filename||'unknown'),'error'); };
      USE_WORKER = true;
    }catch(err2){
      console.warn('Blob Worker failed. Falling back to inline processing.', err2);
      USE_WORKER = false;
      audioWorker = null;
    }
  }
}

// ===== File handling =====
function handleFile(file){
  const szMB = file.size/(1024*1024);
  if (szMB>MAX_FILE_SIZE_MB){ showWarn(`File troppo grande (${szMB.toFixed(1)} MB). Limite ${MAX_FILE_SIZE_MB} MB.`); return; }
  if (szMB>WARNING_SIZE_MB) showWarn(`File grande (${szMB.toFixed(1)} MB). Valuta “Fast” o “Fallback”.`);

  const name=file.name.toLowerCase();
  if (!/\.(wav|mp3)$/.test(name)){ showStatus('Formato non valido (usa WAV o MP3).','error'); return; }

  const fName=document.getElementById('fileName');
  const fSize=document.getElementById('fileSize');
  const fInfo=document.getElementById('fileInfo');
  if (fName) fName.textContent=file.name;
  if (fSize) fSize.textContent=formatFileSize(file.size);
  if (fInfo) fInfo.style.display='block';

  const reader=new FileReader();
  reader.onload = async (e)=>{
    try{
      if (!audioContext) audioContext = new (window.AudioContext||window.webkitAudioContext)();
      updateProgress(30,'Decodifica audio...');
      audioBuffer = await audioContext.decodeAudioData(e.target.result);
      document.getElementById('fileDuration').textContent = formatTime(audioBuffer.duration);
      document.getElementById('sampleRate').textContent = audioBuffer.sampleRate + ' Hz';

      updateProgress(50,'Prefiltri...');
      filteredBuffer = await applyPreFilters(audioBuffer,
        parseFloat((document.getElementById('hpfInput')||{}).value||'20'),
        parseFloat((document.getElementById('lpfInput')||{}).value||'20000'));

      drawWaveform(filteredBuffer);

      updateProgress(70,'Avvio analisi...');
      const thrV=parseInt((document.getElementById('threshold')||{}).value||'120');
      resetSalience();
      await analyzeAudio(filteredBuffer, thrV);
    }catch(err){
      console.error(err);
      showStatus('Errore caricamento/decodifica: '+err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function resetSalience(){ SAL_ROWS=[]; SAL_HOP_SEC=null; }
function getAlgo(){ return (document.getElementById('algorithmSelect')||{}).value || 'hybrid'; }

// ===== Analysis orchestrator =====
async function analyzeAudio(buffer, threshold=120){
  if (isAnalyzing) return showStatus('Analisi già in corso','info');
  try{
    isAnalyzing=true; isCancelled=false; detectedNotes=[]; DETECTED_FROM_WORKER=[]; analysisStartTime=Date.now();
    const prog=document.getElementById('progressContainer'); if (prog) prog.style.display='block';
    const cancel=document.getElementById('cancelBtn'); if (cancel) cancel.style.display='inline-block';
    updateStatusIndicator('processing','Analisi');
    updateProgress(10,'Rilevamento...');

    const mode=(document.getElementById('analysisMode')||{}).value||'full';
    const fftSize=(ANALYSIS_MODES[mode]||ANALYSIS_MODES.full).fftSize;
    const algo = getAlgo();

    await processAudioInChunks(buffer, fftSize, threshold, mode, algo);
    if (isCancelled){ handleCancellation(); return; }

    updateProgress(90,'Ricostruzione note...');
    let built = buildFromWorkerEvents(DETECTED_FROM_WORKER, SAL_HOP_SEC || 0.01);
    if (!built.length && SAL_ROWS.length && SAL_HOP_SEC){
      built = buildNotesFromSalience(SAL_ROWS, SAL_HOP_SEC);
    }
    detectedNotes = built;
    const DETECTED_RAW = detectedNotes.slice();
    detectedNotes = applyPostFilters(DETECTED_RAW);

    updateProgress(95,'Rendering...');
    drawPianoRoll(detectedNotes, buffer.duration);
    updateNotesTable(detectedNotes);

    updateProgress(100,'Completato!');
    updateStatusIndicator('completed','Completato');
    showStatus(`Note trovate: ${detectedNotes.length}`,'success');
    const pb=document.getElementById('playBtn'); if (pb) pb.disabled=false;
    const pm=document.getElementById('playMidiBtn'); if (pm) pm.disabled=false;
  }catch(err){
    console.error(err);
    showStatus('Errore analisi: '+err.message,'error');
  }finally{
    isAnalyzing=false; isCancelled=false; processedChunks=0; totalChunks=0;
    const cancel=document.getElementById('cancelBtn'); if (cancel) cancel.style.display='none';
    const prog=document.getElementById('progressContainer'); if (prog) prog.style.display='none';
    updateStatusIndicator('idle','Pronto');
  }
}

async function processAudioInChunks(buffer, fftSize, threshold, mode, algorithm){
  const data=buffer.getChannelData(0), sr=buffer.sampleRate;
  totalChunks=Math.ceil(data.length/CHUNK_SIZE); processedChunks=0;
  for (let i=0;i<totalChunks;i++){
    if (isCancelled) return;
    const s=i*CHUNK_SIZE, e=Math.min(s+CHUNK_SIZE, data.length);
    const chunk=data.slice(s,e);
    if (USE_WORKER && audioWorker){
      await processChunkWithWorker(chunk, sr, i, totalChunks, fftSize, threshold, s/sr, mode, algorithm);
    } else {
      await processChunkInline(chunk, sr, i, totalChunks, fftSize, threshold, s/sr, mode, algorithm);
    }
    const elapsed=(Date.now()-analysisStartTime)/1000;
    if (elapsed>MAX_PROCESSING_TIME_SECONDS) throw new Error('Timeout analisi.');
  }
}

function processChunkWithWorker(audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm){
  return new Promise((resolve,reject)=>{
    if (!audioWorker){ USE_WORKER=false; resolve(); return; }
    const to=setTimeout(()=>{ cleanup(); USE_WORKER=false; resolve(); }, 20000);
    const handler=(e)=>{
      const m=e.data||{};
      if (m.type==='progress' && m.chunkIndex===chunkIndex){ cleanup(); resolve(); }
      else if (m.type==='error'){ cleanup(); reject(new Error(m.error||'Worker error')); }
      else if (m.type==='cancelled'){ cleanup(); resolve(); }
    };
    function cleanup(){ clearTimeout(to); audioWorker && audioWorker.removeEventListener('message', handler); }
    audioWorker.addEventListener('message', handler);
    audioWorker.postMessage({ type:'analyze', data:{ audioData:Array.from(audioData), sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm } });
  });
}

function handleWorkerProgress(chunkIndex,total,notes,salRows,hopSec){
  if (notes && notes.length){ DETECTED_FROM_WORKER.push(...notes); }
  if (salRows && salRows.length){
    for (const row of salRows){ try{ SAL_ROWS.push(new Uint8Array(row)); }catch{ SAL_ROWS.push(row); } }
    if (!SAL_HOP_SEC && hopSec) SAL_HOP_SEC = hopSec;
  }
  processedChunks++;
  const pct = ((processedChunks/total)*70+20);
  updateProgress(pct, `Chunk ${processedChunks}/${total}...`);
}

function cancelAnalysis(){ isCancelled=true; if(audioWorker) audioWorker.postMessage({type:'cancel'}); showStatus('Analisi annullata','info'); }
function handleCancellation(){ isAnalyzing=false; isCancelled=false; updateStatusIndicator('idle','Annullata'); }

// ===== Prefilters (HPF/LPF cascaded) =====
async function applyPreFilters(buffer, hpfHz=20, lpfHz=20000){
  try{
    const sr=buffer.sampleRate, length=buffer.length;
    const offline = new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(1, length, sr);
    const src = offline.createBufferSource();
    const mono = offline.createBuffer(1, length, sr);
    mono.copyToChannel(buffer.getChannelData(0),0);
    src.buffer=mono;

    let HP = Math.max(10, Math.min(20000, hpfHz));
    let LP = Math.max(100, Math.min(sr/2-10, lpfHz));
    if (HP >= LP){ HP = Math.max(10, LP-50); LP = HP+50; }

    const h1=offline.createBiquadFilter(); h1.type='highpass'; h1.frequency.value=HP; h1.Q.value=0.707;
    const h2=offline.createBiquadFilter(); h2.type='highpass'; h2.frequency.value=HP; h2.Q.value=0.707;
    const l1=offline.createBiquadFilter(); l1.type='lowpass';  l1.frequency.value=LP; l1.Q.value=0.707;
    const l2=offline.createBiquadFilter(); l2.type='lowpass';  l2.frequency.value=LP; l2.Q.value=0.707;

    src.connect(h1).connect(h2).connect(l1).connect(l2).connect(offline.destination);
    src.start();
    const rendered=await offline.startRendering();
    return rendered;
  }catch(e){
    console.warn('applyPreFilters error', e);
    return buffer;
  }
}

// ===== Drawing =====
function drawWaveform(buffer){
  const c=document.getElementById('waveformCanvas'); if (!c) return; const ctx=c.getContext('2d');
  const w=c.width, h=c.height;
  ctx.clearRect(0,0,w,h);
  const data=buffer.getChannelData(0);
  const step=Math.ceil(data.length/w), mid=h/2;
  ctx.strokeStyle='#6aa1ff55'; ctx.beginPath();
  for(let x=0;x<w;x++){
    let mn=1, mx=-1;
    const s=x*step, e=Math.min((x+1)*step, data.length);
    for(let i=s;i<e;i++){ const v=data[i]; if (v<mn) mn=v; if (v>mx) mx=v; }
    ctx.moveTo(x, mid+mn*mid); ctx.lineTo(x, mid+mx*mid);
  }
  ctx.stroke();
}

function drawPianoRoll(notes, duration){
  const c=document.getElementById('pianoRollCanvas'); if (!c) return; const ctx=c.getContext('2d');
  const width=c.width, height=c.height;
  const axis=90, keysW=40, tickPad=axis-keysW-6;

  const fMin=20, fMax=20000;
  const logMin=Math.log10(fMin), logMax=Math.log10(fMax);
  const toY=(f)=>{ const lf=Math.log10(Math.max(fMin, Math.min(fMax, f))); return height*(1 - (lf-logMin)/(logMax-logMin)); };
  const midiToFreq=(m)=> A4*Math.pow(2,(m-69)/12);
  const noteCenterY=(m)=> toY(midiToFreq(m));
  const noteHalfH=(m)=>{ const fC=midiToFreq(m); const fU=midiToFreq(m+0.5); const fD=midiToFreq(m-0.5); return Math.max(1, Math.abs(toY(fD)-toY(fU))/2); };
  const isBlack=(m)=> [1,3,6,8,10].includes(m%12);

  ctx.clearRect(0,0,width,height);
  ctx.fillStyle='#0a0d12'; ctx.fillRect(0,0,width,height);

  const ticks=[20,50,100,200,500,1000,2000,5000,10000,20000];
  ctx.strokeStyle='#2a2f3a'; ctx.fillStyle='#99a1b3'; ctx.font='11px system-ui'; ctx.textAlign='right'; ctx.textBaseline='middle';
  for(const f of ticks){
    const y=toY(f);
    ctx.lineWidth=(f===100||f===1000||f===10000)?1.2:0.6;
    ctx.beginPath(); ctx.moveTo(axis, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.fillText((f>=1000? (f/1000)+'k' : f)+' Hz', axis-8, y);
  }

  for(let m=21;m<=108;m++){
    const yC=noteCenterY(m), hH=noteHalfH(m);
    const y=yC-hH, h=2*hH;
    ctx.fillStyle = isBlack(m) ? '#222' : '#eee';
    ctx.fillRect(tickPad, y, keysW, h);
    ctx.strokeStyle='#2a2f3a'; ctx.strokeRect(tickPad, y, keysW, h);
  }

  if (!notes?.length || !duration) return;
  const plotW=width-axis;
  const timeScale=plotW/Math.max(0.01, duration);

  for(const n of notes){
    const x = axis + n.time*timeScale;
    const w = Math.max(2, n.duration*timeScale);
    const yC = noteCenterY(n.pitch);
    const hH = noteHalfH(n.pitch);
    const y  = yC - hH;
    const v  = (n.velocity||80)/127;
    const hue=180-(v*60), sat=70+(v*30), light=45+(v*20);
    ctx.fillStyle=`hsl(${hue} ${sat}% ${light}%)`;
    ctx.fillRect(x,y,w,Math.max(2,2*hH-1));
    ctx.strokeStyle=`hsl(${hue} ${sat}% ${Math.max(10,light-25)}%)`;
    ctx.strokeRect(x,y,w,Math.max(2,2*hH-1));
  }
}

function updateNotesTable(notes){
  const tbody=document.getElementById('notesTableBody'); if (!tbody) return;
  tbody.innerHTML='';
  notes.forEach((n,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${i+1}</td><td>${n.time.toFixed(3)}</td><td>${noteName(n.pitch)}</td><td>${Math.floor(n.pitch/12)-1}</td><td>${(A4*Math.pow(2,(n.pitch-69)/12)).toFixed(2)}</td><td>${n.duration.toFixed(3)}</td><td>${n.velocity}</td>`;
    tbody.appendChild(tr);
  });
}

// ===== Post filters =====
function getFilterParams(){
  const minVel = Math.max(1, Math.min(127, parseInt((document.getElementById('minVelInput')||{}).value||'25')));
  const minDur = Math.max(0.001, parseFloat((document.getElementById('minDurInput')||{}).value||'0.06'));
  return {minVel, minDur};
}
function applyPostFilters(notes){
  const {minVel, minDur} = getFilterParams();
  return (notes||[]).filter(n => (n.velocity||0) >= minVel && (n.duration||0) >= minDur);
}
function reRenderFiltered(){
  if (!detectedNotes.length) return;
  const filtered = applyPostFilters(detectedNotes);
  drawPianoRoll(filtered, audioBuffer?.duration||0);
  updateNotesTable(filtered);
}

// ===== Duration builders =====
function buildFromWorkerEvents(events, hopSec){
  if (!events || !events.length) return [];
  const byPitch = new Map();
  for (const ev of events){
    const p = ev.pitch|0;
    if (!byPitch.has(p)) byPitch.set(p, []);
    byPitch.get(p).push({t:ev.time, vel: ev.velocity||100, dur: ev.duration||hopSec});
  }
  const notes=[];
  for (const [p, arr] of byPitch){
    arr.sort((a,b)=>a.t-b.t);
    let cur=null;
    for (const e of arr){
      if (!cur){ cur={time:e.t, duration:Math.max(e.dur, hopSec), pitch:p, velocity:e.vel}; continue; }
      const gap = e.t - (cur.time + cur.duration);
      if (gap <= hopSec*2){
        const newEnd = Math.max(cur.time+cur.duration, e.t + Math.max(e.dur, hopSec));
        cur.duration = newEnd - cur.time;
        cur.velocity = Math.max(cur.velocity, e.vel);
      } else {
        notes.push(cur); cur = {time:e.t, duration:Math.max(e.dur, hopSec), pitch:p, velocity:e.vel};
      }
    }
    if (cur) notes.push(cur);
  }
  notes.sort((a,b)=>a.time-b.time || a.pitch-b.pitch);
  return notes;
}

function buildNotesFromSalience(rows, hopSec){
  const P_MIN=21, P_MAX=108, nP=P_MAX-P_MIN+1;
  const T=rows.length; if (!T) return [];
  const notes=[];
  for(let p=0;p<nP;p++){
    const series = new Uint8Array(T);
    for(let t=0;t<T;t++) series[t] = rows[t][p] || 0;
    const arr=Array.from(series).sort((a,b)=>a-b);
    const med=arr[Math.floor(T*0.5)], p80=arr[Math.floor(T*0.8)];
    const thr=Math.max(10, Math.min(220, Math.floor(med*0.6 + p80*0.4)));
    let t=0;
    while(t<T){
      while(t<T && series[t]<thr) t++;
      if (t>=T) break;
      const on=t; let last=on; t++; let dips=0;
      while(t<T){
        if (series[t]>=thr){ last=t; dips=0; }
        else { dips++; if (dips>2) break; }
        t++;
      }
      const off=last+1;
      const time=on*hopSec, duration=Math.max(1,off-on)*hopSec;
      const pitch=P_MIN+p;
      let vmax=0; for(let k=on;k<off;k++) if (series[k]>vmax) vmax=series[k];
      const velocity=Math.max(10, Math.min(127, Math.round(20 + 0.42*vmax)));
      notes.push({ time, pitch, velocity, duration });
    }
  }
  notes.sort((a,b)=> (a.time-b.time)||(a.pitch-b.pitch));
  const out=[];
  for(const n of notes){
    const prev=out[out.length-1];
    if (prev && prev.pitch===n.pitch && Math.abs(prev.time+prev.duration - n.time) < hopSec*2){
      const end=Math.max(prev.time+prev.duration, n.time+n.duration);
      prev.duration=end-prev.time; prev.velocity=Math.max(prev.velocity, n.velocity);
    } else out.push(n);
  }
  return out;
}

// ===== Inline analyzer (fallback if Worker unavailable) =====
function hannWindow(len){ const w=new Float32Array(len); const d=len-1; for(let i=0;i<len;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/d); return w; }
function applyWindow(x,w){ const y=new Float32Array(x.length); for(let i=0;i<x.length;i++) y[i]=x[i]*w[i]; return y; }
function rms(x){ let s=0; for (let i=0;i<x.length;i++) s+=x[i]*x[i]; return Math.sqrt(s/x.length); }
function fftRadix2(re, im){
  const n=re.length; let i=0, j=0;
  for (i=1; i<n-1; i++){ let bit = n>>1; for ( ; j>=bit; bit>>=1) j -= bit; j += bit; if (i<j){ let tr=re[i]; re[i]=re[j]; re[j]=tr; tr=im[i]; im[i]=im[j]; im[j]=tr; } }
  for (let len=2; len<=n; len<<=1){
    const ang = -2*Math.PI/len, wlen_r = Math.cos(ang), wlen_i = Math.sin(ang);
    for (i=0; i<n; i+=len){
      let wr=1, wi=0;
      for (j=0; j<len/2; j++){
        const u_r = re[i+j], u_i = im[i+j];
        const v_r = re[i+j+len/2]*wr - im[i+j+len/2]*wi;
        const v_i = re[i+j+len/2]*wi + im[i+j+len/2]*wr;
        re[i+j] = u_r + v_r; im[i+j] = u_i + v_i;
        re[i+j+len/2] = u_r - v_r; im[i+j+len/2] = u_i - v_i;
        const next_wr = wr*wlen_r - wi*wlen_i; wi = wr*wlen_i + wi*wlen_r; wr = next_wr;
      }
    }
  }
}
function goertzelPower(frame, coeff){ let s0=0, s1=0, s2=0; for (let i=0;i<frame.length;i++){ s0 = frame[i] + coeff*s1 - s2; s2 = s1; s1 = s0; } return (s1*s1 + s2*s2 - coeff*s1*s2)/frame.length; }

const MIDI_MIN=21, MIDI_MAX=108;
function midiToFreq(m){ return A4 * Math.pow(2, (m-69)/12); }
function freqToMidi(f){ return 69 + 12*Math.log2(f/A4); }

function buildHarmonicTables(sampleRate, maxHarm, frameSize){
  const nyq = sampleRate / 2;
  const window = hannWindow(frameSize);
  const tables = [];
  for (let m=MIDI_MIN; m<=MIDI_MAX; m++){
    const f0 = midiToFreq(m); const hs = [];
    for (let k=1; k<=maxHarm; k++){ const fk = f0*k; if (fk >= nyq) break; const omega = 2*Math.PI*fk/sampleRate; const coeff = 2*Math.cos(omega); hs.push({k, coeff}); }
    tables.push({m, f0, harmonics: hs});
  }
  return { tables, window };
}
function yinMono(frame, sr, fmin=40, fmax=5000){
  const N=frame.length;
  const maxLag = Math.min(N-2, Math.floor(sr/fmin));
  const minLag = Math.max(2, Math.floor(sr/fmax));
  const diff = new Float32Array(maxLag+1); diff[0]=0;
  for (let tau=1; tau<=maxLag; tau++){ let sum=0; for (let i=0; i<N-tau; i++){ const d = frame[i]-frame[i+tau]; sum += d*d; } diff[tau]=sum; }
  const cmnd = new Float32Array(maxLag+1); cmnd[0]=1; let running=0;
  for (let tau=1; tau<=maxLag; tau++){ running += diff[tau]; cmnd[tau] = diff[tau] * tau / (running||1e-12); }
  let tauBest=-1, valBest=1e9; const thresh=0.15;
  for (let tau=minLag+1; tau<=maxLag; tau++){ const v=cmnd[tau]; if (v<thresh && v<valBest){ valBest=v; tauBest=tau; } }
  if (tauBest<0){ for (let tau=minLag+1; tau<=maxLag; tau++){ const v=cmnd[tau]; if (v<valBest){ valBest=v; tauBest=tau; } } }
  if (tauBest>0){ const c=cmnd[tauBest], l=cmnd[tauBest-1], r=cmnd[tauBest+1]||c; const den=(l-2*c+r); const delta = den!==0 ? 0.5*(l-r)/den : 0; const tauR = Math.max(minLag, Math.min(maxLag, tauBest+delta)); const f0 = sr / tauR; return f0; }
  return null;
}
function spectralFluxOnsets(framesMag, hopSec){
  const onsets=[]; let prev=null; const N = framesMag.length; const flux = new Float32Array(N);
  for (let i=0;i<N;i++){ const cur=framesMag[i]; if (!prev){ flux[i]=0; prev=cur; continue; } let s=0; for (let k=0;k<cur.length;k++){ const d = cur[k]-prev[k]; if (d>0) s += d; } flux[i]=s; prev=cur; }
  const win=16; const thr=new Float32Array(N);
  for (let i=0;i<N;i++){ let a=[]; for (let j=Math.max(0,i-win); j<Math.min(N,i+win); j++) a.push(flux[j]); a.sort((x,y)=>x-y); thr[i]=a.length? a[Math.floor(a.length*0.6)]*1.2 : 0; }
  for (let i=1;i<N-1;i++){ if (flux[i]>thr[i] && flux[i]>=flux[i-1] && flux[i]>=flux[i+1]){ const t=i*hopSec; const vel = Math.max(10, Math.min(127, Math.round(20 + 100*(flux[i]/(thr[i]+1e-9))))); onsets.push({ time:t, pitch:36, velocity:vel, duration:0.1 }); } }
  return onsets;
}

async function processChunkInline(audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm){
  const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
  const isCQT = (mode === 'cqt');
  const frameSize = Math.max(1024, isCQT ? Math.max(fftSize, 16384) : (fftSize|0));
  const hopSize   = isCQT ? Math.max(128, Math.floor(frameSize/8)) : Math.floor(frameSize/2);
  const maxHarm   = isCQT ? 8 : 6;
  const { tables, window } = buildHarmonicTables(sampleRate, maxHarm, frameSize);
  const maxPolyphony = 16;

  const numFrames = Math.max(0, Math.floor((audioArray.length - frameSize)/hopSize));
  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);
  const framesMag = [];
  const salienceRows=[];
  const notesOut=[];

  for (let f=0; f<numFrames; f++){
    if (isCancelled) break;
    const start = f*hopSize;
    const frame = applyWindow(audioArray.subarray(start, start+frameSize), window);
    const frameRMS = rms(frame);
    const time = timeOffset + start / sampleRate;
    const frameDur = hopSize / sampleRate;

    re.set(frame); im.fill(0); fftRadix2(re, im);
    const mags = new Float32Array(frameSize/2);
    for (let k=0;k<mags.length;k++){ const rr=re[k], ii=im[k]; mags[k]=Math.hypot(rr,ii); }
    framesMag.push(mags);

    if (frameRMS < 1e-4){ salienceRows.push(new Uint8Array(MIDI_MAX-MIDI_MIN+1)); continue; }

    const sal = new Float32Array(MIDI_MAX-MIDI_MIN+1);
    let maxSal = 0;
    for (let idx=0; idx<tables.length; idx++){
      const hs = tables[idx].harmonics;
      let s = 0;
      for (let h=0; h<hs.length; h++){ const {k, coeff} = hs[h]; s += (1/k) * goertzelPower(frame, coeff); }
      sal[idx] = s; if (s > maxSal) maxSal = s;
    }
    const salW = new Float32Array(sal.length);
    if (maxSal>0){
      for (let i=0;i<sal.length;i++){
        let v0=sal[i], v1=sal[i-1]||sal[i], v2=sal[i+1]||sal[i], v3=sal[i-2]||sal[i], v4=sal[i+2]||sal[i];
        const vals = [v0,v1,v2,v3,v4].sort((a,b)=>a-b); const med = vals[2];
        salW[i] = Math.max(0, sal[i] - 0.8*med);
      }
    }
    let maxW = 0; for (let i=0;i<salW.length;i++) if (salW[i]>maxW) maxW = salW[i];
    const row = new Uint8Array(salW.length);
    if (maxW>0){ for (let i=0;i<salW.length;i++){ row[i] = Math.max(0, Math.min(255, Math.round(255 * salW[i]/maxW))); } }
    salienceRows.push(row);

    const cand_poly = [];
    if (maxW>0){
      const relThresh = 0.5 * maxW;
      const masked = salW.slice();
      function isLocalPeak(arr,i){ const L=i>0?arr[i-1]:-Infinity, R=i<arr.length-1?arr[i+1]:-Infinity; return arr[i]>=L && arr[i]>=R; }
      function maskSeries(idxBase){
        const m0 = MIDI_MIN + idxBase;
        for (let h=1; h<=8; h++){
          const fH = midiToFreq(m0)*h;
          const mH = 69 + 12*Math.log2(fH/A4);
          const iH = Math.round(mH) - MIDI_MIN;
          for (let d=-1; d<=1; d++){ const j=iH+d; if (j>=0 && j<masked.length) masked[j] *= 0.1; }
        }
        for (let d=-1; d<=1; d++){ const j=idxBase+d; if (j>=0 && j<masked.length) masked[j] *= 0.1; }
      }
      let picks=0;
      while (picks < maxPolyphony){
        let best=-1, bestVal=relThresh;
        for (let i=0;i<masked.length;i++){
          const v=masked[i];
          if (v>bestVal && isLocalPeak(masked,i)){ best=i; bestVal=v; }
        }
        if (best<0) break;
        cand_poly.push(MIDI_MIN + best);
        maskSeries(best);
        picks++;
      }
    }
    const f0 = yinMono(frame, sampleRate, 40, 5000);
    const cand_mono = []; if (f0){ const m = Math.round(freqToMidi(f0)); if (m>=MIDI_MIN && m<=MIDI_MAX) cand_mono.push(m); }

    const algo = algorithm||'hybrid';
    if (algo === 'mono'){ if (cand_mono.length){ notesOut.push({ time, pitch:cand_mono[0], velocity:100, duration:frameDur }); } }
    else if (algo === 'poly'){ for (const m of cand_poly){ notesOut.push({ time, pitch:m, velocity:100, duration:frameDur }); } }
    else if (algo === 'hybrid'){ const merged = new Set([...cand_poly]); if (cand_mono.length) merged.add(cand_mono[0]); if (maxW>0){ let bi=-1, bv=0; for (let i=0;i<salW.length;i++) if (salW[i]>bv){ bv=salW[i]; bi=i; } if (bi>=0) merged.add(MIDI_MIN+bi); } for (const m of merged) notesOut.push({ time, pitch:m, velocity:100, duration:frameDur }); }
    else if (algo === 'rhythm'){ /* handled after loop with spectral flux */ }
  }
  if (algorithm==='rhythm'){
    const hopSec = (isCQT ? Math.max(128, Math.floor(Math.max(fftSize,16384)/8)) : Math.floor(Math.max(fftSize,1024)/2)) / sampleRate;
    const onsets = spectralFluxOnsets(framesMag, hopSec);
    for (const n of onsets) notesOut.push(n);
  }

  DETECTED_FROM_WORKER.push(...notesOut);
  SAL_HOP_SEC = SAL_HOP_SEC || ( (isCQT ? Math.max(128, Math.floor(Math.max(fftSize,16384)/8)) : Math.floor(Math.max(fftSize,1024)/2)) / sampleRate );
  for (const r of salienceRows) SAL_ROWS.push(r);

  processedChunks++;
  const pct = ((processedChunks/totalChunks)*70+20);
  updateProgress(pct, `Chunk ${processedChunks}/${totalChunks}...`);
}

// ===== Audio playback =====
function playAudio(){
  if (!audioBuffer) return;
  if (!audioContext) audioContext = new (window.AudioContext||window.webkitAudioContext)();
  if (audioSource) try{audioSource.stop()}catch{}
  audioSource=audioContext.createBufferSource();
  audioSource.buffer=audioBuffer;
  audioSource.playbackRate.value=parseInt((document.getElementById('playbackSpeed')||{}).value||'100')/100;
  audioSource.connect(audioContext.destination);
  audioSource.start(0,currentTime);
  isPlaying=true;
  const playBtn=document.getElementById('playBtn'); const pauseBtn=document.getElementById('pauseBtn'); const stopBtn=document.getElementById('stopBtn');
  if (playBtn) playBtn.disabled=true; if (pauseBtn) pauseBtn.disabled=false; if (stopBtn) stopBtn.disabled=false;
}
function pauseAudio(){
  if (audioSource){
    try{ audioSource.stop(); }catch{}
    currentTime=0; isPlaying=false;
    const playBtn=document.getElementById('playBtn'); const pauseBtn=document.getElementById('pauseBtn');
    if (playBtn) playBtn.disabled=false; if (pauseBtn) pauseBtn.disabled=true;
  }
}
function stopAudio(){
  if (audioSource){
    try{ audioSource.stop(); }catch{}
    currentTime=0; isPlaying=false;
    const playBtn=document.getElementById('playBtn'); const pauseBtn=document.getElementById('pauseBtn'); const stopBtn=document.getElementById('stopBtn');
    if (playBtn) playBtn.disabled=false; if (pauseBtn) pauseBtn.disabled=true; if (stopBtn) stopBtn.disabled=true;
  }
}

// ===== MIDI export & playback =====
function exportToMIDI(){
  const notes = applyPostFilters(detectedNotes||[]);
  if (!notes.length) return showStatus('Nessuna nota da esportare','error');
  const data = buildMIDI(notes, 120);
  const blob=new Blob([data],{type:'audio/midi'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='converted.mid'; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  showStatus('MIDI esportato','success');
}
function writeVarLen(arr, v){ let buffer=v & 0x7F; while((v >>= 7)){ buffer <<= 8; buffer |= ((v & 0x7F)|0x80); } while(true){ arr.push(buffer & 0xFF); if (buffer & 0x80) buffer >>= 8; else break; } }
function buildMIDI(notes, bpm){
  const TPQ=480, mpqn=Math.round(60000000/Math.max(30,Math.min(300,bpm)));
  const seq=notes.slice().sort((a,b)=>a.time-b.time);
  const events=[];
  for (const n of seq){
    const on=Math.round(n.time*(TPQ*bpm/60));
    const off=Math.round((n.time+n.duration)*(TPQ*bpm/60));
    const pitch=Math.max(0,Math.min(127,n.pitch|0));
    const vel=Math.max(1,Math.min(127),(n.velocity|0)||80);
    events.push({tick:on,type:'on',pitch,vel});
    events.push({tick:Math.max(on+1,off),type:'off',pitch,vel:0x40});
  }
  events.sort((a,b)=>a.tick-b.tick || (a.type==='off'?-1:1));
  let last=0; const track=[];
  track.push(0x00,0xFF,0x51,0x03,(mpqn>>16)&0xFF,(mpqn>>8)&0xFF,mpqn&0xFF);
  track.push(0x00,0xC0,0x00);
  for(const ev of events){
    const delta=ev.tick-last; last=ev.tick; writeVarLen(track, delta);
    if (ev.type==='on') track.push(0x90, ev.pitch, ev.vel);
    else track.push(0x80, ev.pitch, 0x40);
  }
  track.push(0x00,0xFF,0x2F,0x00);
  const header=[0x4D,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, 0x00,0x00, 0x00,0x01, 0x01,0xE0];
  const trkHdr=[0x4D,0x54,0x72,0x6B];
  const len=track.length; const lenBytes=[(len>>24)&0xFF,(len>>16)&0xFF,(len>>8)&0xFF,len&0xFF];
  return new Uint8Array([...header, ...trkHdr, ...lenBytes, ...track]).buffer;
}

function playMidi(){
  // Simple audition using WebAudio oscillator per note (sine)
  if (!audioContext) audioContext = new (window.AudioContext||window.webkitAudioContext)();
  const now = audioContext.currentTime;
  const notes = applyPostFilters(detectedNotes||[]);
  const gain = audioContext.createGain(); gain.gain.value=0.2; gain.connect(audioContext.destination);
  notes.forEach(n=>{
    const osc=audioContext.createOscillator(); osc.type='sine';
    const f = A4*Math.pow(2,(n.pitch-69)/12);
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(now + n.time);
    osc.stop(now + n.time + Math.max(0.05, n.duration));
  });
}
function stopMidi(){ /* Oscillators auto-stop; could keep handles if needed */ }
