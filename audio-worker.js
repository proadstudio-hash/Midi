// Web Worker — Multi‑Algorithm (mono/poly/rhythm/hybrid)
let isProcessing=false, isCancelled=false;

self.onmessage = (e)=>{
  const {type, data} = e.data || {};
  if (type === 'analyze') analyzeChunkMulti(data);
  else if (type === 'cancel') isCancelled = true;
  else if (type === 'reset') { isCancelled = false; isProcessing = false; }
};

function hannWindow(len){ const w=new Float32Array(len); const d=len-1; for(let i=0;i<len;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/d); return w; }
function applyWindow(x,w){ const y=new Float32Array(x.length); for(let i=0;i<x.length;i++) y[i]=x[i]*w[i]; return y; }
function rms(x){ let s=0; for(let i=0;i<x.length;i++) s+=x[i]*x[i]; return Math.sqrt(s/x.length); }

function fftRadix2(re, im){
  const n=re.length;
  let i=0, j=0;
  for (i=1; i<n-1; i++){
    let bit = n>>1;
    for ( ; j>=bit; bit>>=1) j -= bit;
    j += bit;
    if (i<j){ let tr=re[i]; re[i]=re[j]; re[j]=tr; tr=im[i]; im[i]=im[j]; im[j]=tr; }
  }
  for (let len=2; len<=n; len<<=1){
    const ang = -2*Math.PI/len;
    const wlen_r = Math.cos(ang);
    const wlen_i = Math.sin(ang);
    for (i=0; i<n; i+=len){
      let wr=1, wi=0;
      for (j=0; j<len/2; j++){
        const u_r = re[i+j], u_i = im[i+j];
        const v_r = re[i+j+len/2]*wr - im[i+j+len/2]*wi;
        const v_i = re[i+j+len/2]*wi + im[i+j+len/2]*wr;
        re[i+j] = u_r + v_r;
        im[i+j] = u_i + v_i;
        re[i+j+len/2] = u_r - v_r;
        im[i+j+len/2] = u_i - v_i;
        const next_wr = wr*wlen_r - wi*wlen_i;
        wi = wr*wlen_i + wi*wlen_r;
        wr = next_wr;
      }
    }
  }
}

function goertzelPower(frame, coeff){
  let s0=0, s1=0, s2=0;
  for (let i=0;i<frame.length;i++){ s0 = frame[i] + coeff*s1 - s2; s2 = s1; s1 = s0; }
  const power = s1*s1 + s2*s2 - coeff*s1*s2;
  return power / frame.length;
}

const MIDI_MIN=21, MIDI_MAX=108, A4=440;
function midiToFreq(m){ return A4 * Math.pow(2, (m-69)/12); }
function freqToMidi(f){ return 69 + 12*Math.log2(f/A4); }

function buildHarmonicTables(sampleRate, maxHarm, frameSize){
  const nyq = sampleRate / 2;
  const window = hannWindow(frameSize);
  const tables = [];
  for (let m=MIDI_MIN; m<=MIDI_MAX; m++){
    const f0 = midiToFreq(m);
    const hs = [];
    for (let k=1; k<=maxHarm; k++){
      const fk = f0*k; if (fk >= nyq) break;
      const omega = 2*Math.PI*fk/sampleRate;
      const coeff = 2*Math.cos(omega);
      hs.push({k, coeff});
    }
    tables.push({m, f0, harmonics: hs});
  }
  return { tables, window };
}

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

function spectralFluxOnsets(framesMag, hopSec){
  const onsets=[];
  let prev=null;
  const N = framesMag.length;
  const flux = new Float32Array(N);
  for (let i=0;i<N;i++){
    const cur=framesMag[i];
    if (!prev){ flux[i]=0; prev=cur; continue; }
    let s=0;
    for (let k=0;k<cur.length;k++){
      const d = cur[k]-prev[k];
      if (d>0) s += d;
    }
    flux[i]=s; prev=cur;
  }
  const win=16;
  const thr=new Float32Array(N);
  for (let i=0;i<N;i++){
    let a=[];
    for (let j=Math.max(0,i-win); j<Math.min(N,i+win); j++) a.push(flux[j]);
    a.sort((x,y)=>x-y);
    thr[i]=a.length? a[Math.floor(a.length*0.6)]*1.2 : 0;
  }
  for (let i=1;i<N-1;i++){
    if (flux[i]>thr[i] && flux[i]>=flux[i-1] && flux[i]>=flux[i+1]){
      const t=i*hopSec;
      const vel = Math.max(10, Math.min(127, Math.round(20 + 100*(flux[i]/(thr[i]+1e-9)))));
      onsets.push({ time:t, pitch:36, velocity:vel, duration:0.1 });
    }
  }
  return onsets;
}

function analyzeChunkMulti(payload){
  const { audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm } = payload;
  if (isCancelled){ self.postMessage({type:'cancelled'}); return; }
  isProcessing = true;
  try{
    const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);

    const isCQT = (mode === 'cqt');
    const frameSize = Math.max(1024, isCQT ? Math.max(fftSize, 16384) : (fftSize|0));
    const hopSize   = isCQT ? Math.max(128, Math.floor(frameSize/8)) : Math.floor(frameSize/2);
    const maxHarm   = isCQT ? 8 : 6;

    const { tables, window } = buildHarmonicTables(sampleRate, maxHarm, frameSize);

    const maxPolyphony = 16;

    const notesOut = [];
    const salienceRows = [];
    const framesMag = [];

    const numFrames = Math.max(0, Math.floor((audioArray.length - frameSize)/hopSize));

    const re = new Float32Array(frameSize);
    const im = new Float32Array(frameSize);

    for (let f=0; f<numFrames; f++){
      if (isCancelled){ self.postMessage({type:'cancelled'}); return; }
      const start = f*hopSize;
      const frame = applyWindow(audioArray.subarray(start, start+frameSize), window);
      const frameRMS = rms(frame);
      const time = timeOffset + start / sampleRate;
      const frameDur = hopSize / sampleRate;

      re.set(frame); im.fill(0); fftRadix2(re, im);
      const mags = new Float32Array(frameSize/2);
      for (let k=0;k<mags.length;k++){ const rr=re[k], ii=im[k]; mags[k]=Math.hypot(rr,ii); }
      framesMag.push(mags);

      if (frameRMS < 1e-4){
        salienceRows.push(new Uint8Array(MIDI_MAX-MIDI_MIN+1));
        continue;
      }

      const sal = new Float32Array(MIDI_MAX-MIDI_MIN+1);
      let maxSal = 0;
      for (let idx=0; idx<tables.length; idx++){
        const hs = tables[idx].harmonics;
        let s = 0;
        for (let h=0; h<hs.length; h++){
          const {k, coeff} = hs[h];
          s += (1/k) * goertzelPower(frame, coeff);
        }
        sal[idx] = s; if (s > maxSal) maxSal = s;
      }
      const salW = new Float32Array(sal.length);
      if (maxSal>0){
        for (let i=0;i<sal.length;i++){
          let v0=sal[i], v1=sal[i-1]||sal[i], v2=sal[i+1]||sal[i];
          let v3=sal[i-2]||sal[i], v4=sal[i+2]||sal[i];
          const vals = [v0,v1,v2,v3,v4].sort((a,b)=>a-b);
          const med = vals[2];
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
        function isLocalPeak(arr,i){
          const L=i>0?arr[i-1]:-Infinity, R=i<arr.length-1?arr[i+1]:-Infinity;
          return arr[i]>=L && arr[i]>=R;
        }
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
        while (picks < 16){
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
      const cand_mono = [];
      if (f0){ const m = Math.round(freqToMidi(f0)); if (m>=MIDI_MIN && m<=MIDI_MAX) cand_mono.push(m); }

      if (algorithm === 'mono'){
        if (cand_mono.length){ notesOut.push({ time, pitch:cand_mono[0], velocity:100, duration:frameDur }); }
      } else if (algorithm === 'poly'){
        for (const m of cand_poly){ notesOut.push({ time, pitch:m, velocity:100, duration:frameDur }); }
      } else if (algorithm === 'hybrid'){
        const merged = new Set();
        for (const m of cand_poly) merged.add(m);
        if (cand_mono.length) merged.add(cand_mono[0]);
        if (maxW>0){ let bi=-1, bv=0; for (let i=0;i<salW.length;i++) if (salW[i]>bv){ bv=salW[i]; bi=i; } if (bi>=0) merged.add(MIDI_MIN+bi); }
        for (const m of merged) notesOut.push({ time, pitch:m, velocity:100, duration:frameDur });
      } else if (algorithm === 'rhythm'){
        // handle after loop
      } else {
        for (const m of cand_poly){ notesOut.push({ time, pitch:m, velocity:100, duration:frameDur }); }
      }
    }

    if (algorithm === 'rhythm'){
      const hopSec = hopSize / sampleRate;
      const onsetNotes = spectralFluxOnsets(framesMag, hopSec);
      for (const n of onsetNotes) notesOut.push(n);
    }

    self.postMessage({ 
      type: 'progress', 
      chunkIndex, 
      totalChunks, 
      notes: notesOut, 
      salRows: salienceRows, 
      hopSec: hopSize / sampleRate
    });

  }catch(err){
    self.postMessage({ type:'error', error: err?.message || String(err) });
  } finally {
    isProcessing = false;
  }
}
