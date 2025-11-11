// Audio → MIDI — Stable Build (FFT + Hi‑Res CQT + Piano + Freq Axis + Filters + Post‑Filters + MIDI Playback)
let audioContext=null, audioBuffer=null, filteredBuffer=null;
let audioSource=null, isPlaying=false, currentTime=0;

let audioWorker=null, isAnalyzing=false, isCancelled=false;
let analysisStartTime=0, processedChunks=0, totalChunks=0;

let detectedNotes=[];
let DETECTED_RAW=[];   // store raw detections before post-filters
let SAL_ROWS=[];       // Uint8 salience rows for duration rebuild
let SAL_HOP_SEC=null;  // seconds per salience row

let midiPlaying=false, midiMasterGain=null, midiScheduled=[];

// Modes
const ANALYSIS_MODES={ full:{fftSize:8192}, fast:{fftSize:4096}, fallback:{fftSize:2048}, cqt:{fftSize:16384} };
const CHUNK_SIZE=4096*32;
const MAX_FILE_SIZE_MB=200, WARNING_SIZE_MB=50, MAX_PROCESSING_TIME_SECONDS=900;
const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const A4=440;

document.addEventListener('DOMContentLoaded', () => {
  const upload = document.getElementById('uploadSection');
  const fileInput = document.getElementById('fileInput');
  if (upload){
    upload.addEventListener('dragover', e=>{ e.preventDefault(); upload.classList.add('drag'); });
    upload.addEventListener('dragleave', ()=> upload.classList.remove('drag'));
    upload.addEventListener('drop', e=>{ e.preventDefault(); upload.classList.remove('drag'); const f=e.dataTransfer.files; if (f && f.length) handleFile(f[0]); });
  }
  if (fileInput) fileInput.addEventListener('change', e=>{ if (e.target.files && e.target.files.length) handleFile(e.target.files[0]); });

  const playBtn=document.getElementById('playBtn');
  const pauseBtn=document.getElementById('pauseBtn');
  const stopBtn=document.getElementById('stopBtn');
  const playMidiBtn=document.getElementById('playMidiBtn');
  const stopMidiBtn=document.getElementById('stopMidiBtn');

  if (playBtn) playBtn.addEventListener('click', playAudio);
  if (pauseBtn) pauseBtn.addEventListener('click', pauseAudio);
  if (stopBtn) stopBtn.addEventListener('click', stopAudio);
  if (playMidiBtn) playMidiBtn.addEventListener('click', playMidi);
  if (stopMidiBtn) stopMidiBtn.addEventListener('click', stopMidi);

  const speed=document.getElementById('playbackSpeed');
  if (speed) speed.addEventListener('input', e=>{
    const v=e.target.value; const lbl=document.getElementById('playbackSpeedValue'); if (lbl) lbl.textContent=v+'%';
    if (audioSource && audioSource.playbackRate) audioSource.playbackRate.value=v/100;
  });

  const thr=document.getElementById('threshold');
  if (thr) thr.addEventListener('input', e=>{ const lbl=document.getElementById('thresholdValue'); if (lbl) lbl.textContent=e.target.value; });

  const hpf=document.getElementById('hpfInput');
  const lpf=document.getElementById('lpfInput');
  if (hpf) hpf.addEventListener('input', e=>{ const v=e.target.value; const lbl=document.getElementById('hpfValue'); if (lbl) lbl.textContent=v; });
  if (lpf) lpf.addEventListener('input', e=>{ const v=e.target.value; const lbl=document.getElementById('lpfValue'); if (lbl) lbl.textContent=v; });

  const minVelInput=document.getElementById('minVelInput');
  const minDurInput=document.getElementById('minDurInput');
  if (minVelInput) minVelInput.addEventListener('input', e=>{ const v=e.target.value; const lbl=document.getElementById('minVelValue'); if (lbl) lbl.textContent=v; reRenderFiltered(); });
  if (minDurInput) minDurInput.addEventListener('input', e=>{ const v=e.target.value; const lbl=document.getElementById('minDurValue'); if (lbl) lbl.textContent=v; reRenderFiltered(); });

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
  if (modeSel) modeSel.addEventListener('change', ()=>{ if (audioBuffer && !isAnalyzing) (document.getElementById('reanalyzeBtn')||{}).click?.(); });

  initializeWorker();
  updateStatusIndicator('idle','Pronto');
});

function initializeWorker(){
  try{
    audioWorker = new Worker('audio-worker.js');
    audioWorker.onmessage = (e)=>{
      const {type, chunkIndex, totalChunks, notes, salRows, hopSec, error} = e.data || {};
      if (type==='progress'){
        handleWorkerProgress(chunkIndex, totalChunks, notes||[], salRows||[], hopSec);
      } else if (type==='error'){
        showStatus('Worker error: '+error, 'error'); resetAnalysisState();
      } else if (type==='cancelled'){
        handleCancellation();
      }
    };
    audioWorker.onerror = (err)=>{
      console.error('Worker error', err);
      showStatus('Worker error: '+(err.message||err.filename||'unknown'),'error');
      resetAnalysisState();
    };
  }catch(err){
    console.error('Worker init failed', err);
    showStatus('Web Worker non supportato in questo contesto','error');
  }
}

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
      const fDur=document.getElementById('fileDuration');
      const fSR=document.getElementById('sampleRate');
      if (fDur) fDur.textContent = formatTime(audioBuffer.duration);
      if (fSR) fSR.textContent = audioBuffer.sampleRate + ' Hz';

      // Prefilter
      updateProgress(50,'Prefiltri...');
      filteredBuffer = await applyPreFilters(audioBuffer,
        parseFloat((document.getElementById('hpfInput')||{}).value||'20'),
        parseFloat((document.getElementById('lpfInput')||{}).value||'20000'));

      // Draw waveform
      drawWaveform(filteredBuffer);

      // Analysis
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

async function analyzeAudio(buffer, threshold=120){
  if (isAnalyzing) return showStatus('Analisi già in corso','info');
  try{
    isAnalyzing=true; isCancelled=false; detectedNotes=[]; analysisStartTime=Date.now();
    const prog=document.getElementById('progressContainer'); if (prog) prog.style.display='block';
    const cancel=document.getElementById('cancelBtn'); if (cancel) cancel.style.display='inline-block';
    updateStatusIndicator('processing','Analisi');
    updateProgress(10,'Rilevamento...');

    const mode=(document.getElementById('analysisMode')||{}).value||'full';
    const fftSize=(ANALYSIS_MODES[mode]||ANALYSIS_MODES.full).fftSize;

    await processAudioInChunks(buffer, fftSize, threshold, mode);
    if (isCancelled){ handleCancellation(); return; }

    updateProgress(90,'Ricostruzione note...');
    if (SAL_ROWS.length && SAL_HOP_SEC){
      detectedNotes = buildNotesFromSalience(SAL_ROWS, SAL_HOP_SEC);
    }
    DETECTED_RAW = detectedNotes.slice();
    detectedNotes = applyPostFilters(DETECTED_RAW);

    updateProgress(95,'Rendering...');
    drawPianoRoll(detectedNotes, buffer.duration);
    updateNotesTable(detectedNotes);

    updateProgress(100,'Completato!');
    updateStatusIndicator('completed','Completato');
    showStatus(`Note trovate: ${detectedNotes.length}`,'success');
  }catch(err){
    console.error(err);
    showStatus('Errore analisi: '+err.message,'error');
  }finally{
    resetAnalysisState();
  }
}

async function processAudioInChunks(buffer, fftSize, threshold, mode){
  const data=buffer.getChannelData(0), sr=buffer.sampleRate;
  totalChunks=Math.ceil(data.length/CHUNK_SIZE); processedChunks=0;
  for (let i=0;i<totalChunks;i++){
    if (isCancelled) return;
    const s=i*CHUNK_SIZE, e=Math.min(s+CHUNK_SIZE, data.length);
    const chunk=data.slice(s,e);
    await processChunkWithWorker(chunk, sr, i, totalChunks, fftSize, threshold, s/sr, mode);
    const elapsed=(Date.now()-analysisStartTime)/1000;
    if (elapsed>MAX_PROCESSING_TIME_SECONDS) throw new Error('Timeout analisi.');
  }
}

function processChunkWithWorker(audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode){
  return new Promise((resolve,reject)=>{
    const to=setTimeout(()=>{ cleanup(); reject(new Error('Worker timeout')); }, 45000);
    const handler=(e)=>{
      const m=e.data||{};
      if (m.type==='progress' && m.chunkIndex===chunkIndex){
        cleanup(); resolve();
      } else if (m.type==='error'){
        cleanup(); reject(new Error(m.error||'Worker error'));
      } else if (m.type==='cancelled'){
        cleanup(); resolve();
      }
    };
    function cleanup(){ clearTimeout(to); audioWorker.removeEventListener('message', handler); }
    audioWorker.addEventListener('message', handler);
    audioWorker.postMessage({ type:'analyze', data:{ audioData:Array.from(audioData), sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode } });
  });
}

function handleWorkerProgress(chunkIndex,total,notes,salRows,hopSec){
  if (notes && notes.length) detectedNotes.push(...notes);
  if (salRows && salRows.length){
    for (const row of salRows){ try{ SAL_ROWS.push(new Uint8Array(row)); }catch{ SAL_ROWS.push(row); } }
    if (!SAL_HOP_SEC && hopSec) SAL_HOP_SEC = hopSec;
  }
  processedChunks++;
  const pct = ((processedChunks/total)*70+20);
  updateProgress(pct, `Chunk ${processedChunks}/${total}...`);
}

function cancelAnalysis(){ isCancelled=true; if(audioWorker) audioWorker.postMessage({type:'cancel'}); showStatus('Analisi annullata','info'); resetAnalysisState(); }
function resetAnalysisState(){
  isAnalyzing=false; isCancelled=false; processedChunks=0; totalChunks=0;
  const cancel=document.getElementById('cancelBtn'); if (cancel) cancel.style.display='none';
  const prog=document.getElementById('progressContainer'); if (prog) prog.style.display='none';
  updateStatusIndicator('idle','Pronto');
  if (audioWorker) audioWorker.postMessage({type:'reset'});
}

// Prefilters (HPF/LPF cascaded)
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

// Drawing
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

// Piano roll with log frequency (20–20k) + keyboard
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

  // grid + ticks
  const ticks=[20,50,100,200,500,1000,2000,5000,10000,20000];
  ctx.strokeStyle='#2a2f3a'; ctx.fillStyle='#99a1b3'; ctx.font='11px system-ui'; ctx.textAlign='right'; ctx.textBaseline='middle';
  for(const f of ticks){
    const y=toY(f);
    ctx.lineWidth=(f===100||f===1000||f===10000)?1.2:0.6;
    ctx.beginPath(); ctx.moveTo(axis, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.fillText((f>=1000? (f/1000)+'k' : f)+' Hz', axis-8, y);
  }

  // keyboard strip (MIDI 21..108)
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

// Post filters
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
  if (!DETECTED_RAW.length || !audioBuffer) return;
  detectedNotes = applyPostFilters(DETECTED_RAW);
  drawPianoRoll(detectedNotes, audioBuffer.duration);
  updateNotesTable(detectedNotes);
}

// Build notes from salience rows: adaptive threshold + bridging
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

// Audio playback
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
  if (audioSource && isPlaying){
    try{ audioSource.stop(); }catch{}
    currentTime = 0;
    isPlaying=false;
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

// MIDI export & playback
function exportToMIDI(){ detectedNotes = applyPostFilters(DETECTED_RAW.length?DETECTED_RAW:detectedNotes);
  if (!detectedNotes.length) return showStatus('Nessuna nota da esportare','error');
  const data = buildMIDI(detectedNotes, 120);
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
    const vel=Math.max(1,Math.min(127,(n.velocity|0)||80));
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
  const header=[0x4D,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, 0x00,0x00, 0x00,0x01, 0x01,0xE0]; // TPQ=480
  const trkHdr=[0x4D,0x54,0x72,0x6B];
  const len=track.length; const lenBytes=[(len>>24)&0xFF,(len>>16)&0xFF,(len>>8)&0xFF,len&0xFF];
  return new Uint8Array([...header, ...trkHdr, ...lenBytes, ...track]).buffer;
}

// Simple MIDI synth
function playMidi(){
  if (!detectedNotes.length) return showStatus('Non ci sono note MIDI','error');
  if (!audioContext) audioContext = new (window.AudioContext||window.webkitAudioContext)();
  stopMidi();
  midiMasterGain=audioContext.createGain(); midiMasterGain.gain.value=0.08; midiMasterGain.connect(audioContext.destination);
  const rate=parseInt((document.getElementById('playbackSpeed')||{}).value||'100')/100;
  const now=audioContext.currentTime;
  for (const n of detectedNotes){
    const start=now + (n.time / rate);
    const dur=Math.max(0.03, n.duration / rate);
    const g=audioContext.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(Math.min(1,(n.velocity||80)/127), start+0.005);
    g.gain.setTargetAtTime(0, start+dur-0.01, 0.01);
    const osc=audioContext.createOscillator();
    osc.type='sine'; osc.frequency.value=A4*Math.pow(2,(n.pitch-69)/12);
    osc.connect(g).connect(midiMasterGain);
    osc.start(start); osc.stop(start+dur+0.05);
    midiScheduled.push({osc,g});
  }
  const playMidiBtn=document.getElementById('playMidiBtn'); const stopMidiBtn=document.getElementById('stopMidiBtn');
  if (playMidiBtn) playMidiBtn.disabled=true; if (stopMidiBtn) stopMidiBtn.disabled=false;
}
function stopMidi(){
  for(const o of midiScheduled){ try{o.osc.stop()}catch{} try{o.g.disconnect()}catch{} }
  midiScheduled=[];
  if (midiMasterGain){ try{midiMasterGain.disconnect()}catch{} midiMasterGain=null; }
  const playMidiBtn=document.getElementById('playMidiBtn'); const stopMidiBtn=document.getElementById('stopMidiBtn');
  if (playMidiBtn) playMidiBtn.disabled=false; if (stopMidiBtn) stopMidiBtn.disabled=true;
}

// Helpers
function midiToNote(m){ return A4*Math.pow(2,(m-69)/12); }
function noteName(m){ const i=m%12, o=Math.floor(m/12)-1; return NOTE_NAMES[i]+o; }
function formatFileSize(bytes){ const s=['B','KB','MB','GB']; if(!bytes) return '0 B'; const i=Math.floor(Math.log(bytes)/Math.log(1024)); return (bytes/Math.pow(1024,i)).toFixed(1)+' '+s[i]; }
function formatTime(sec){ const m=Math.floor(sec/60), s=Math.floor(sec%60); return `${m}:${String(s).padStart(2,'0')}`; }

function updateStatusIndicator(state,text){ const d=document.getElementById('statusDot'); if (d) d.className='dot '+state; const s=document.getElementById('statusText'); if (s) s.textContent=text; }
function updateProgress(pct,label){ const bar=document.getElementById('progressFill'); const cont=document.getElementById('progressContainer'); if (cont) cont.style.display='block'; if (bar) bar.style.width=Math.max(0,Math.min(100,pct))+'%'; const pr=document.getElementById('progressPercent'); if (pr) pr.textContent=Math.round(pct)+'%'; }
function showStatus(msg, level='info'){ const w=document.getElementById('warningMessage'); if (!w) return; w.textContent=msg; w.style.display='block'; w.style.color=(level==='success')?'#40c057':(level==='error'?'#fa5252':'#fab005'); setTimeout(()=>{w.style.display='none'}, 6000); }
function showWarn(m){ const w=document.getElementById('warningMessage'); if (!w) return; w.textContent='⚠️ '+m; w.style.color='#fab005'; w.style.display='block'; setTimeout(()=>{w.style.display='none'}, 6000); }
