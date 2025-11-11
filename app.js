// Audio → MIDI — robust analysis + spectrogram + fixes
let audioContext=null, audioBuffer=null, filteredBuffer=null;
let audioSource=null, isPlaying=false;
let audioWorker=null, USE_WORKER=true;
let isAnalyzing=false, isCancelled=false;
let analysisStartTime=0, processedChunks=0, totalChunks=0;

let detectedNotes=[];
let DETECTED_FROM_WORKER=[];
let SAL_ROWS=[];
let SAL_HOP_SEC=null;
let FRAMES_MAG=null; // for spectrogram if worker falls back

let ESTIMATED_BPM=120;
let midiOscs=[]; // for stopping MIDI playback

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
function updateProgress(pct,label){ const bar=document.getElementById('progressFill'); const cont=document.getElementById('progressContainer'); if (cont) cont.style.display='block'; if (bar) bar.style.width=Math.max(0,Math.min(100,pct))+'%'; const pr=document.getElementById('progressPercent'); if (pr) pr.textContent=Math.round(pct)+'%'; if(label) { const st=document.getElementById('statusText'); if(st) st.textContent=label; } }
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

  const harm=document.getElementById('harmFilter');
  if (harm) harm.addEventListener('input', e=>{ const lbl=document.getElementById('harmFilterValue'); if (lbl) lbl.textContent=e.target.value+'%'; });

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
    audioWorker.onmessage = workerOnMessage;
    audioWorker.onerror = (err)=>{ console.error('Worker error', err); showStatus('Worker error: '+(err.message||err.filename||'unknown'),'error'); };
    USE_WORKER = true;
  }catch(err1){
    console.warn('Standard Worker failed. Trying Blob URL...', err1);
    try{
      const txt = await fetch('audio-worker.js').then(r=>r.text());
      const blob = new Blob([txt], {type:'application/javascript'});
      const url  = URL.createObjectURL(blob);
      audioWorker = new Worker(url);
      audioWorker.onmessage = workerOnMessage;
      audioWorker.onerror = (err)=>{ console.error('Worker error', err); showStatus('Worker error: '+(err.message||err.filename||'unknown'),'error'); };
      USE_WORKER = true;
    }catch(err2){
      console.warn('Blob Worker failed. Falling back to inline processing.', err2);
      USE_WORKER = false; audioWorker = null;
    }
  }
}
function workerOnMessage(e){
  const {type, chunkIndex, totalChunks, notes, salRows, hopSec, error} = e.data || {};
  if (type==='progress'){
    if (notes && notes.length){ DETECTED_FROM_WORKER.push(...notes); }
    if (salRows && salRows.length){
      for (const row of salRows){ SAL_ROWS.push(Uint8Array.from(row)); }
      if (!SAL_HOP_SEC && hopSec) SAL_HOP_SEC = hopSec;
    }
    processedChunks++;
    const pct = ((processedChunks/totalChunks)*70+20);
    updateProgress(pct, `Chunk ${processedChunks}/${totalChunks}...`);
  }
  else if (type==='error'){ showStatus('Worker error: '+error, 'error'); }
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
      const arrayBuf = e.target.result;
      audioContext.decodeAudioData(arrayBuf).then(async (buf)=>{
        audioBuffer = buf;
        document.getElementById('fileDuration').textContent = formatTime(audioBuffer.duration);
        document.getElementById('sampleRate').textContent = audioBuffer.sampleRate + ' Hz';

        updateProgress(50,'Prefiltri...');
        filteredBuffer = await applyPreFilters(audioBuffer,
          parseFloat((document.getElementById('hpfInput')||{}).value||'20'),
          parseFloat((document.getElementById('lpfInput')||{}).value||'20000'));

        drawWaveform(filteredBuffer);

        // enable transport
        const pb=document.getElementById('playBtn'); if (pb) pb.disabled=false;
        const pa=document.getElementById('pauseBtn'); if (pa) pa.disabled=false;
        const st=document.getElementById('stopBtn'); if (st) st.disabled=false;

        updateProgress(70,'Avvio analisi...');
        const thrV=parseInt((document.getElementById('threshold')||{}).value||'120');
        resetSalience();
        await analyzeAudio(filteredBuffer, thrV);
      }).catch(err=>{
        console.error(err);
        showStatus('Errore decodifica: '+err.message, 'error');
      });
    }catch(err){
      console.error(err);
      showStatus('Errore caricamento: '+err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function resetSalience(){ SAL_ROWS=[]; SAL_HOP_SEC=null; FRAMES_MAG=null; }
function getAlgo(){ return (document.getElementById('algorithmSelect')||{}).value || 'hybrid'; }
function getHarmReject(){ const v=parseInt((document.getElementById('harmFilter')||{}).value||'70'); return Math.max(0,Math.min(100,v))/100; }

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
    const harmRej = getHarmReject();

    await processAudioInChunks(buffer, fftSize, threshold, mode, algo, harmRej);
    if (isCancelled){ handleCancellation(); return; }

    updateProgress(90,'Ricostruzione note...');
    let built = buildFromWorkerEvents(DETECTED_FROM_WORKER, SAL_HOP_SEC || 0.01);
    if (!built.length && SAL_ROWS.length && SAL_HOP_SEC){
      built = buildNotesFromSalience(SAL_ROWS, SAL_HOP_SEC);
    }

    // Velocity refinement from salience energy area
    built = refineVelocitiesFromSalience(built);

    detectedNotes = built;
    const DETECTED_RAW = detectedNotes.slice();
    detectedNotes = applyPostFilters(DETECTED_RAW);

    // Tempo estimate (for MIDI export & playback)
    ESTIMATED_BPM = estimateBPMFromNotes(detectedNotes) || 120;
    const bpmLbl = document.getElementById('estBPM'); if (bpmLbl) bpmLbl.textContent = Math.round(ESTIMATED_BPM);

    updateProgress(95,'Rendering...');
    drawPianoRoll(detectedNotes, buffer.duration);
    drawSpectrogram(); // new visual
    updateNotesTable(detectedNotes);

    updateProgress(100,'Completato!');
    updateStatusIndicator('completed','Completato');
    showStatus(`Note trovate: ${detectedNotes.length}`,'success');
    const pm=document.getElementById('playMidiBtn'); if (pm) pm.disabled=false;
    const sm=document.getElementById('stopMidiBtn'); if (sm) sm.disabled=false;
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

async function processAudioInChunks(buffer, fftSize, threshold, mode, algorithm, harmRej){
  const data=buffer.getChannelData(0), sr=buffer.sampleRate;
  totalChunks=Math.ceil(data.length/CHUNK_SIZE); processedChunks=0;
  for (let i=0;i<totalChunks;i++){
    if (isCancelled) return;
    const s=i*CHUNK_SIZE, e=Math.min(s+CHUNK_SIZE, data.length);
    const chunk=data.slice(s,e);
    if (USE_WORKER && audioWorker){
      await processChunkWithWorker(chunk, sr, i, totalChunks, fftSize, threshold, s/sr, mode, algorithm, harmRej);
    } else {
      await processChunkInline(chunk, sr, i, totalChunks, fftSize, threshold, s/sr, mode, algorithm, harmRej);
    }
    const elapsed=(Date.now()-analysisStartTime)/1000;
    if (elapsed>MAX_PROCESSING_TIME_SECONDS) throw new Error('Timeout analisi.');
  }
}

function processChunkWithWorker(audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm, harmRej){
  return new Promise((resolve,reject)=>{
    if (!audioWorker){ USE_WORKER=false; resolve(); return; }
    const to=setTimeout(()=>{ cleanup(); USE_WORKER=false; resolve(); }, 30000);
    const handler=(e)=>{
      const m=e.data||{};
      if (m.type==='progress' && m.chunkIndex===chunkIndex){ cleanup(); resolve(); }
      else if (m.type==='error'){ cleanup(); reject(new Error(m.error||'Worker error')); }
      else if (m.type==='cancelled'){ cleanup(); resolve(); }
    };
    function cleanup(){ clearTimeout(to); audioWorker && audioWorker.removeEventListener('message', handler); }
    audioWorker.addEventListener('message', handler);
    audioWorker.postMessage({ type:'analyze', data:{ audioData:Array.from(audioData), sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm, harmonicRejection:harmRej } });
  });
}

// ===== Prefilters (HPF/LPF cascaded) =====
async function applyPreFilters(buffer, hpfHz=20, lpfHz=20000){
  try{
    const sr=buffer.sampleRate, length=buffer.length;
    const offline = new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(1, length, sr);
    const src = offline.createBufferSource();
    const mono = offline.createBuffer(1, length, sr);
    const left = buffer.getChannelData(0);
    mono.copyToChannel(left,0);
    src.buffer=mono;

    let HP = Math.max(10, Math.min(20000, hpfHz|0));
    let LP = Math.max(100, Math.min(Math.floor(sr/2)-10, lpfHz|0));
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
  const step=Math.max(1, Math.floor(data.length/w)); const mid=h/2;
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

// Spectrogram from SAL_ROWS (log‑freq MIDI bins 21..108)
function drawSpectrogram(){
  const c=document.getElementById('spectrogramCanvas'); if (!c) return;
  const ctx=c.getContext('2d'); const w=c.width; const h=c.height;
  ctx.clearRect(0,0,w,h);
  // axes padding
  const axis=90;
  ctx.fillStyle='#0a0d12'; ctx.fillRect(0,0,w,h);
  // frequency ticks
  const fMin=20, fMax=20000;
  const logMin=Math.log10(fMin), logMax=Math.log10(fMax);
  const toY=(f)=>{ const lf=Math.log10(Math.max(fMin, Math.min(fMax, f))); return h*(1 - (lf-logMin)/(logMax-logMin)); };
  const ticks=[20,50,100,200,500,1000,2000,5000,10000,20000];
  ctx.strokeStyle='#2a2f3a'; ctx.fillStyle='#99a1b3'; ctx.font='11px system-ui'; ctx.textAlign='right'; ctx.textBaseline='middle';
  for(const f of ticks){
    const y=toY(f);
    ctx.beginPath(); ctx.moveTo(axis, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText((f>=1000? (f/1000)+'k' : f)+' Hz', axis-8, y);
  }
  // no data?
  if (!SAL_ROWS.length){ return; }
  const T = SAL_ROWS.length;
  const P = SAL_ROWS[0].length; // 88 midi bins
  const plotW = w-axis;
  const timePerCol = plotW / T;
  const img = ctx.createImageData(Math.max(1, Math.floor(plotW)), h);
  // paint column by column
  for (let t=0; t<T; t++){
    const col = SAL_ROWS[t];
    for (let p=0; p<P; p++){
      const midi = 21 + p;
      const f = 440 * Math.pow(2, (midi-69)/12);
      const y = Math.floor(toY(f));
      const nextMidi = midi+1;
      const f2 = 440 * Math.pow(2, (nextMidi-69)/12);
      const y2 = Math.floor(toY(f2));
      const yTop = Math.min(y, y2), yBot = Math.max(y, y2);
      const v = col[p]; // 0..255
      const hue = 260 - (v/255)*160; // blue -> red
      const sat = 80;
      const light = 20 + (v/255)*50;
      // convert hsl to rgb (simple approximate)
      const color = hslToRgb(hue/360, sat/100, light/100);
      const xPix = axis + Math.floor(t*timePerCol);
      for (let yy=yTop; yy<=yBot; yy++){
        const idx = ((yy*w) + xPix) * 4;
        img.data[idx+0] = color[0];
        img.data[idx+1] = color[1];
        img.data[idx+2] = color[2];
        img.data[idx+3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
function hslToRgb(h, s, l){
  if (s===0){ const v=Math.round(l*255); return [v,v,v]; }
  const hue2rgb=(p,q,t)=>{ if(t<0) t+=1; if(t>1) t-=1; if(t<1/6) return p+(q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p+(q-p)*(2/3-t)*6; return p; }
  const q = l < 0.5 ? l*(1+s) : l + s - l*s;
  const p = 2*l - q;
  const r = hue2rgb(p,q,h+1/3), g=hue2rgb(p,q,h), b=hue2rgb(p,q,h-1/3);
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
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

// ===== Velocity refinement from salience area =====
function refineVelocitiesFromSalience(notes){
  if (!notes?.length || !SAL_ROWS.length || !SAL_HOP_SEC) return notes;
  const T = SAL_ROWS.length;
  const P_MIN = 21;
  const vals = [];
  const out = notes.map(n => ({...n}));
  for (const n of out){
    const pIdx = n.pitch - P_MIN;
    if (pIdx < 0 || pIdx >= SAL_ROWS[0].length) continue;
    const on = Math.max(0, Math.floor(n.time / SAL_HOP_SEC));
    const off = Math.min(T-1, Math.ceil((n.time + n.duration) / SAL_HOP_SEC));
    let acc = 0, cnt = 0;
    for (let t=on; t<=off; t++){
      const row = SAL_ROWS[t];
      // include +/- 1 semitone neighborhood
      for (let d=-1; d<=1; d++){
        const j = pIdx + d;
        if (j>=0 && j<row.length){ acc += row[j]; cnt++; }
      }
    }
    const mean = cnt ? acc / cnt : 0;
    vals.push(mean);
    n._salMean = mean;
  }
  if (!vals.length) return notes;
  vals.sort((a,b)=>a-b);
  const vmin = vals[0], vmax = vals[vals.length-1] || 1;
  for (const n of out){
    const norm = (n._salMean - vmin) / (vmax - vmin + 1e-9);
    const vel = Math.max(1, Math.min(127, Math.round(12 + Math.pow(norm,0.7)*115)));
    n.velocity = vel;
    delete n._salMean;
  }
  return out;
}

// ===== Duration builders =====
function buildFromWorkerEvents(events, hopSec){
  if (!events || !events.length) return [];
  const byPitch = new Map();
  for (const ev of events){
    const p = ev.pitch|0;
    if (!byPitch.has(p)) byPitch.set(p, []);
    byPitch.get(p).push({t:ev.time, vel: Math.max(1, Math.min(127, ev.velocity||80)), dur: ev.duration||hopSec});
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

// ===== Simple BPM estimator from note onsets =====
function estimateBPMFromNotes(notes){
  if (!notes || notes.length<4) return 120;
  const onsets = [];
  const tol = 0.03; // 30 ms
  notes.slice().sort((a,b)=>a.time-b.time).forEach(n=>{
    if (!onsets.length || (n.time - onsets[onsets.length-1]) > tol) onsets.push(n.time);
  });
  const intervals = [];
  for (let i=1;i<onsets.length;i++){
    const d = onsets[i]-onsets[i-1];
    if (d>0.15 && d<2.5) intervals.push(d);
  }
  if (!intervals.length) return 120;
  const bins = new Map();
  intervals.forEach(d=>{
    const bpm = 60/d;
    const adj = bpm>200? bpm/2 : (bpm<60? bpm*2 : bpm);
    const k = Math.round(adj);
    bins.set(k, (bins.get(k)||0)+1);
  });
  let best=120, bestC=0;
  bins.forEach((c,k)=>{ if (c>bestC){ bestC=c; best=k; } });
  return Math.max(60, Math.min(200, best));
}

// ===== DSP helpers for inline fallback =====
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
function medianFilterFreq(vec, win=7){
  const out=new Float32Array(vec.length); const half=(win|0)>>1;
  for (let k=0;k<vec.length;k++){
    const a=[]; for (let j=Math.max(0,k-half); j<=Math.min(vec.length-1,k+half); j++) a.push(vec[j]);
    a.sort((x,y)=>x-y); out[k]=a[Math.floor(a.length/2)]||0;
  }
  return out;
}
function localTimeMedian(frames, bin, fi){
  let acc=[];
  for (let t=Math.max(0,fi-2); t<=Math.min(frames.length-1, fi+2); t++) acc.push(frames[t][bin]);
  acc.sort((a,b)=>a-b);
  return acc[Math.floor(acc.length/2)]||0;
}
function hpsOnSpectrum(spec, maxFactor=4){
  const n=spec.length; const out=new Float32Array(n);
  for (let i=1;i<n;i++){
    let prod=spec[i];
    for (let f=2; f<=maxFactor; f++){
      const idx=Math.floor(i/f); if (idx>0) prod *= spec[idx];
    }
    out[i]=prod;
  }
  return out;
}
function specBinToMidi(bin, sr, nBins){ const freq = bin*sr/(2*nBins); return Math.round(69+12*Math.log2(freq/440)); }
function pruneHarmonics(list, strength){
  if (!list || !list.length || strength<=0) return list;
  const centsTol = 20 + (1-strength)*80; // 20c at 100% rejection → 100c at 0%
  const out=[];
  list.sort((a,b)=> (a.pitch||a) - (b.pitch||b));
  for (let i=0;i<list.length;i++){
    const hi = list[i]; const mH = hi.pitch||hi;
    let harmonic=false;
    for (let j=0;j<i;j++){
      const lo = list[j]; const mL = lo.pitch||lo;
      const dSemis = mH - mL;
      if (dSemis <= 0) continue;
      const r = Math.pow(2, dSemis/12);
      // nearest integer ratio up to 6th harmonic
      const n = Math.min(6, Math.max(2, Math.round(r)));
      const targetSemis = 12*Math.log2(n);
      const dCents = Math.abs(dSemis - targetSemis)*100;
      if (dCents <= centsTol){ harmonic=true; break; }
    }
    if (!harmonic) out.push(hi);
  }
  return out;
}

// Monophonic YIN (added inline to avoid 'yinMono is not defined')
function yinMono(frame, sr, fmin=40, fmax=5000){
  const N=frame.length;
  const maxLag = Math.min(N-2, Math.floor(sr/fmin));
  const minLag = Math.max(2, Math.floor(sr/fmax));
  const diff = new Float32Array(maxLag+1);
  diff[0]=0;
  for (let tau=1; tau<=maxLag; tau++){
    let sum=0;
    for (let i=0; i<N-tau; i++){
      const d = frame[i]-frame[i+tau];
      sum += d*d;
    }
    diff[tau]=sum;
  }
  const cmnd = new Float32Array(maxLag+1);
  cmnd[0]=1;
  let running=0;
  for (let tau=1; tau<=maxLag; tau++){
    running += diff[tau];
    cmnd[tau] = diff[tau] * tau / (running||1e-12);
  }
  let tauBest=-1, valBest=1e9;
  const thresh=0.15;
  for (let tau=minLag+1; tau<=maxLag; tau++){
    const v=cmnd[tau];
    if (v<thresh && v<valBest){
      valBest=v; tauBest=tau;
    }
  }
  if (tauBest<0){
    for (let tau=minLag+1; tau<=maxLag; tau++){
      const v=cmnd[tau]; if (v<valBest){ valBest=v; tauBest=tau; }
    }
  }
  if (tauBest>0){
    const c=cmnd[tauBest], l=cmnd[tauBest-1], r=cmnd[tauBest+1]||c;
    const den=(l-2*c+r);
    const delta = den!==0 ? 0.5*(l-r)/den : 0;
    const tauR = Math.max(minLag, Math.min(maxLag, tauBest+delta));
    const f0 = sr / tauR;
    return f0;
  }
  return null;
}

async function processChunkInline(audioData, sampleRate, chunkIndex, total, fftSize, threshold, timeOffset, mode, algorithm, harmRej){
  const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
  const isCQT = (mode === 'cqt');
  const frameSize = Math.max(1024, isCQT ? Math.max(fftSize, 16384) : (fftSize|0));
  const hopSize   = isCQT ? Math.max(128, Math.floor(frameSize/8)) : Math.floor(frameSize/2);
  const maxHarm   = isCQT ? 8 : 6;
  const { tables, window } = buildHarmonicTables(sampleRate, maxHarm, frameSize);
  const nBins = frameSize/2;

  const numFrames = Math.max(0, Math.floor((audioArray.length - frameSize)/hopSize));
  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);
  const framesMag = [];
  const notesOut=[];
  const salRows=[];
  const allFrames=[];

  // First pass
  for (let f=0; f<numFrames; f++){
    const start=f*hopSize;
    const frame=applyWindow(audioArray.subarray(start,start+frameSize), window);
    allFrames.push(frame);
    re.set(frame); im.fill(0); fftRadix2(re, im);
    const mags=new Float32Array(nBins);
    for (let k=0;k<nBins;k++){ const rr=re[k], ii=im[k]; mags[k]=Math.hypot(rr,ii); }
    framesMag.push(mags);

    const sal=new Float32Array(MIDI_MAX-MIDI_MIN+1); let maxSal=0;
    for (let idx=0; idx<tables.length; idx++){
      const hs=tables[idx].harmonics; let s=0;
      for (let h=0; h<hs.length; h++){ const {k,coeff}=hs[h]; s += (1/k) * goertzelPower(frame, coeff); }
      sal[idx]=s; if (s>maxSal) maxSal=s;
    }
    const row=new Uint8Array(sal.length);
    if (maxSal>0){ for (let i=0;i<sal.length;i++) row[i]=Math.max(0,Math.min(255, Math.round(255*sal[i]/maxSal))); }
    salRows.push(row);
  }
  const hopSec = hopSize / sampleRate;

  // Per-frame detection
  for (let f=0; f<numFrames; f++){
    const time = timeOffset + f*hopSec;
    const salRow = salRows[f];
    const mags = framesMag[f];

    if (algorithm==='rhythm') continue;

    if (algorithm==='mono'){
      const f0 = yinMono(allFrames[f], sampleRate, 40, 5000);
      if (f0){
        const m=Math.round(freqToMidi(f0));
        if (m>=MIDI_MIN && m<=MIDI_MAX){
          const vel = Math.max(10, Math.min(127, Math.round(20 + 0.42*(salRow[m-MIDI_MIN]||0))));
          notesOut.push({ time, pitch:m, velocity:vel, duration:hopSec });
        }
      }
      continue;
    }

    // Build candidate list for poly / poly_new / hybrid
    let frameList=[];

    if (algorithm==='poly'){
      const arr=Array.from(salRow);
      const masked=arr.map(v=>v);
      function isPeak(i){ const L=i>0?masked[i-1]:-1, R=i<masked.length-1?masked[i+1]:-1; return masked[i]>=L && masked[i]>=R; }
      let count=0, thr=Math.max(30, 0.5*Math.max(...masked));
      while (count<16){
        let bi=-1, bv=thr;
        for (let i=0;i<masked.length;i++){ const v=masked[i]; if (v>bv && isPeak(i)){ bi=i; bv=v; } }
        if (bi<0) break;
        const m = MIDI_MIN + bi;
        const vel = Math.max(10, Math.min(127, Math.round(20 + 0.42*bv)));
        frameList.push({pitch:m, velocity:vel});
        for (let h=1; h<=8; h++){
          const mh=Math.round(m + 12*Math.log2(h));
          const j=mh - MIDI_MIN;
          for (let d=-1; d<=1; d++){ const idx=j+d; if (idx>=0 && idx<masked.length) masked[idx]*=0.1; }
        }
        count++;
      }
    } else {
      // Poly New / Hybrid
      const harm = medianFilterFreq(mags, 9);
      const perc_med = new Float32Array(mags.length);
      for (let k=0;k<mags.length;k++) perc_med[k] = localTimeMedian(framesMag, k, f);
      const harmMask = new Float32Array(mags.length);
      for (let k=0;k<mags.length;k++) harmMask[k] = harm[k] / (harm[k] + perc_med[k] + 1e-9);
      const harmSpec = new Float32Array(mags.length);
      for (let k=0;k<mags.length;k++) harmSpec[k] = mags[k]*harmMask[k];

      const hps = hpsOnSpectrum(harmSpec, 4);
      let maxHps=0; for (let i=1;i<hps.length;i++) if (hps[i]>maxHps) maxHps=hps[i];
      const hpsThr = maxHps*0.35;
      const candidates=[]
      for (let i=2;i<hps.length-2;i++){
        if (hps[i]>hpsThr && hps[i]>=hps[i-1] && hps[i]>=hps[i+1]){
          const m = specBinToMidi(i, sampleRate, nBins);
          if (m>=MIDI_MIN && m<=MIDI_MAX) candidates.push(m);
        }
      }
      const arr = Array.from(salRow);
      const topS=[]; const tmp=arr.slice();
      for (let k=0;k<10;k++){
        let bi=-1,bv=0; for (let i=0;i<tmp.length;i++){ if (tmp[i]>bv){ bv=tmp[i]; bi=i; } }
        if (bi<0) break; topS.push(MIDI_MIN+bi); tmp[bi]=0;
      }
      const merged = new Set([...candidates, ...topS]);
      const finalCand = new Set();
      merged.forEach(m=>{ if (merged.has(m-12)) finalCand.add(m-12); else finalCand.add(m); });
      const outList=[];
      finalCand.forEach(m=>{
        const idx=m-MIDI_MIN; const s = arr[idx]||0; if (s<20) return;
        const freq = A4*Math.pow(2,(m-69)/12);
        const bin = Math.round(freq * (2*nBins) / sampleRate);
        const hpsVal = (hps[bin]|0);
        const hpsNorm = maxHps>0 ? (hpsVal/maxHps) : 0;
        const sNorm = Math.min(1, s/255);
        const fused = 0.6*sNorm + 0.4*hpsNorm;
        const vel = Math.max(10, Math.min(127, Math.round(15 + fused*112)));
        outList.push({pitch:m, velocity:vel});
      });
      outList.sort((a,b)=>b.velocity-a.velocity);
      frameList = outList.slice(0,16);
    }

    // Harmonic rejection
    frameList = pruneHarmonics(frameList, harmRej);

    // Push to notesOut
    for (const c of frameList){
      notesOut.push({ time, pitch:c.pitch, velocity:c.velocity, duration:hopSec });
    }
  }

  DETECTED_FROM_WORKER.push(...notesOut);
  if (!SAL_HOP_SEC) SAL_HOP_SEC = hopSec;
  if (!FRAMES_MAG) FRAMES_MAG = framesMag; // keep first chunk frames for debug

  processedChunks++;
  const pct = ((processedChunks/total)*70+20);
  updateProgress(pct, `Chunk ${processedChunks}/${total}...`);
}

function cancelAnalysis(){ isCancelled=true; if(audioWorker) audioWorker.postMessage({type:'cancel'}); showStatus('Analisi annullata','info'); }
function handleCancellation(){ isAnalyzing=false; isCancelled=false; updateStatusIndicator('idle','Annullata'); }

// ===== Transport (audio) =====
function playAudio(){
  if (!audioBuffer) return;
  stopAudio();
  audioSource = audioContext.createBufferSource();
  audioSource.buffer = filteredBuffer || audioBuffer;
  const gain = audioContext.createGain(); gain.gain.value = 1.0;
  audioSource.connect(gain).connect(audioContext.destination);
  const speed = parseInt((document.getElementById('playbackSpeed')||{}).value||'100')/100;
  audioSource.playbackRate.value = speed;
  audioSource.start();
  isPlaying=true;
}
function pauseAudio(){
  if (audioSource){ try{ audioSource.stop(); }catch{} audioSource.disconnect(); audioSource=null; isPlaying=false; }
}
function stopAudio(){ pauseAudio(); }

// ===== MIDI playback (oscillator) =====
function playMidi(){
  if (!audioContext) audioContext = new (window.AudioContext||window.webkitAudioContext)();
  stopMidi();
  const now = audioContext.currentTime;
  const t0 = now + 0.05;
  const secPerBeat = 60 / (ESTIMATED_BPM||120);
  const endTime = (audioBuffer?.duration)||0;
  const notes = applyPostFilters(detectedNotes);
  for (const n of notes){
    const start = t0 + n.time;
    const end = start + n.duration;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    const freq = A4*Math.pow(2,(n.pitch-69)/12);
    osc.frequency.setValueAtTime(freq, start);
    const amp = Math.max(0.001, (n.velocity||80)/127);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(amp*0.5, start+0.01);
    gain.gain.setValueAtTime(amp*0.5, end-0.02);
    gain.gain.linearRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(start); osc.stop(end+0.005);
    midiOscs.push({osc, gain});
  }
}
function stopMidi(){
  midiOscs.forEach(({osc,gain})=>{ try{ osc.stop(); }catch{} try{ osc.disconnect(); }catch{} try{ gain.disconnect(); }catch{} });
  midiOscs.length=0;
}

// ===== MIDI export (single track SMF) =====
function exportToMIDI(){
  const notes = applyPostFilters(detectedNotes);
  if (!notes.length){ showStatus('Nessuna nota da esportare','error'); return; }
  const bpm = ESTIMATED_BPM||120;
  const tpq = 480;
  const tempo = Math.round(60000000 / bpm); // microsec/quarter
  // events
  const ev=[];
  ev.push([0, 0xFF, 0x51, 0x03, (tempo>>16)&0xFF, (tempo>>8)&0xFF, tempo&0xFF]); // tempo
  ev.push([0, 0xC0, 0x00]); // program change
  notes.sort((a,b)=> a.time-b.time || a.pitch-b.pitch);
  function secToTicks(s){ return Math.round(s * (tpq * bpm / 60)); }
  for (const n of notes){
    const on = secToTicks(n.time);
    const off = secToTicks(n.time + n.duration);
    ev.push([on, 0x90, n.pitch, Math.max(1,Math.min(127,n.velocity||80))]);
    ev.push([off, 0x80, n.pitch, 0x40]);
  }
  // delta times
  ev.sort((a,b)=> a[0]-b[0]);
  let last=0; const bytes=[];
  function vlq(n){ const stack=[]; stack.push(n&0x7F); while(n>>=7){ stack.push(0x80 | (n&0x7F)); } return stack.reverse(); }
  for (const e of ev){
    const dt = e[0]-last; last=e[0];
    vlq(dt).forEach(b=>bytes.push(b));
    for (let i=1;i<e.length;i++) bytes.push(e[i]);
  }
  // end of track
  bytes.push(0x00, 0xFF, 0x2F, 0x00);
  // build header + track chunk
  function str4(s){ return [s.charCodeAt(0),s.charCodeAt(1),s.charCodeAt(2),s.charCodeAt(3)]; }
  function u32(n){ return [(n>>24)&0xFF,(n>>16)&0xFF,(n>>8)&0xFF,n&0xFF]; }
  const header = [...str4('MThd'), ...u32(6), 0x00,0x01, 0x00,0x01, (tpq>>8)&0xFF, tpq&0xFF];
  const track  = [...str4('MTrk'), ...u32(bytes.length), ...bytes];
  const all = new Uint8Array([...header, ...track]);
  const blob = new Blob([all], {type:'audio/midi'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'extracted.mid'; a.click();
  URL.revokeObjectURL(url);
}
