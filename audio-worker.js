// Web Worker for Audio Analysis (ROBUST MULTI-F0 + CQT Mode + Salience Rows)
let isProcessing=false, isCancelled=false;

self.onmessage = (e)=>{
  const {type, data} = e.data || {};
  if (type === 'analyze') analyzeChunkRobust(data);
  else if (type === 'cancel') isCancelled = true;
  else if (type === 'reset') { isCancelled = false; isProcessing = false; }
};

function hannWindow(len){ const w=new Float32Array(len); const d=len-1; for(let i=0;i<len;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/d); return w; }
function applyWindow(x,w){ const y=new Float32Array(x.length); for(let i=0;i<x.length;i++) y[i]=x[i]*w[i]; return y; }
function rms(x){ let s=0; for(let i=0;i<x.length;i++) s+=x[i]*x[i]; return Math.sqrt(s/x.length); }
function goertzelPower(frame, coeff){
  let s0=0, s1=0, s2=0;
  for (let i=0;i<frame.length;i++){ s0 = frame[i] + coeff*s1 - s2; s2 = s1; s1 = s0; }
  const power = s1*s1 + s2*s2 - coeff*s1*s2;
  return power / frame.length;
}

const MIDI_MIN=21, MIDI_MAX=108, A4=440;
function midiToFreq(m){ return A4 * Math.pow(2, (m-69)/12); }

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

function analyzeChunkRobust(payload){
  const { audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode } = payload;
  if (isCancelled){ self.postMessage({type:'cancelled'}); return; }
  isProcessing = true;
  try{
    const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);

    const isCQT = (mode === 'cqt');
    const frameSize = Math.max(1024, isCQT ? Math.max(fftSize, 16384) : (fftSize|0));
    const hopSize   = isCQT ? Math.max(128, Math.floor(frameSize/8)) : Math.floor(frameSize/2);
    const maxHarm   = isCQT ? 8 : 6;

    const { tables, window } = buildHarmonicTables(sampleRate, maxHarm, frameSize);

    const t = Math.min(Math.max(threshold || 30, 10), 1000);
    const alpha = Math.min(0.98, 0.15 + ((t-10)/990)*0.83);
    const maxPolyphony = 16;

    const notesOut = [];
    const salienceRows = [];

    const numFrames = Math.max(0, Math.floor((audioArray.length - frameSize)/hopSize));

    for (let f=0; f<numFrames; f++){
      if (isCancelled){ self.postMessage({type:'cancelled'}); return; }
      const start = f*hopSize;
      const frame = applyWindow(audioArray.subarray(start, start+frameSize), window);
      const frameRMS = rms(frame);
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
      if (maxSal <= 0){ salienceRows.push(new Uint8Array(MIDI_MAX-MIDI_MIN+1)); continue; }

      // Whitening (median subtraction over ±2 semitones)
      const salW = new Float32Array(sal.length);
      for (let i=0;i<sal.length;i++){
        let v0=sal[i], v1=sal[i-1]||sal[i], v2=sal[i+1]||sal[i];
        let v3=sal[i-2]||sal[i], v4=sal[i+2]||sal[i];
        const vals = [v0,v1,v2,v3,v4].sort((a,b)=>a-b);
        const med = vals[2];
        salW[i] = Math.max(0, sal[i] - 0.8*med);
      }
      let maxW = 0; for (let i=0;i<salW.length;i++) if (salW[i]>maxW) maxW = salW[i];
      if (maxW <= 0){ salienceRows.push(new Uint8Array(MIDI_MAX-MIDI_MIN+1)); continue; }
      const relThresh = 0.5 * maxW; // local threshold for polyphonic picking

      // Save normalized salience row (0..255)
      const row = new Uint8Array(salW.length);
      for (let i=0;i<salW.length;i++){ row[i] = Math.max(0, Math.min(255, Math.round(255 * salW[i]/maxW))); }
      salienceRows.push(row);

      // Iterative harmonic masking for polyphony
      const masked = salW.slice();
      const chosenIdx = [];
      function isLocalPeak(arr,i){
        const L=i>0?arr[i-1]:-Infinity, R=i<arr.length-1?arr[i+1]:-Infinity;
        return arr[i]>=L && arr[i]>=R;
      }
      function maskSeries(idxBase){
        const m0 = MIDI_MIN + idxBase;
        for (let h=1; h<=maxHarm; h++){
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
        chosenIdx.push(best);
        maskSeries(best);
        picks++;
      }

      // Parabolic interpolation (sub-semitone)
      function refineFrac(arr,i){
        const c=arr[i], l=i>0?arr[i-1]:c, r=i<arr.length-1?arr[i+1]:c;
        const den=(l-2*c+r); if (den===0) return 0;
        const delta=0.5*(l-r)/den; if (delta>1||delta<-1) return 0; return delta;
      }

      const time = timeOffset + start / sampleRate;
      const frameDur = hopSize / sampleRate;
      for (const idx of chosenIdx){
        const midiBase = MIDI_MIN + idx;
        const frac = refineFrac(salW, idx);
        const midiRef = midiBase + frac;
        const freq = midiToFreq(midiRef);
        const velocity = 100;
        notesOut.push({ time, pitch: Math.round(midiRef), frequency: freq, velocity, duration: frameDur });
      }
    }

    self.postMessage({ 
      type: 'progress', 
      chunkIndex, 
      totalChunks, 
      notes: notesOut, 
      salRows: salienceRows, 
      hopSec: hopSize / sampleRate,
      mode
    });

  }catch(err){
    self.postMessage({ type:'error', error: err?.message || String(err) });
  } finally {
    isProcessing = false;
  }
}
