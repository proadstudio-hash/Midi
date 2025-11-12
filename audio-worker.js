// Web Worker — add harmonic rejection & pass through to main thread
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
  const centsTol = 20 + (1-strength)*80;
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
      const n = Math.min(6, Math.max(2, Math.round(r)));
      const targetSemis = 12*Math.log2(n);
      const dCents = Math.abs(dSemis - targetSemis)*100;
      if (dCents <= centsTol){ harmonic=true; break; }
    }
    if (!harmonic) out.push(hi);
  }
  return out;
}

function analyzeChunkMulti(payload){
  const { audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset, mode, algorithm, harmonicRejection=0.7 } = payload;
  if (isCancelled){ self.postMessage({type:'cancelled'}); return; }
  isProcessing = true;
  try{
    const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
    const isCQT = (mode === 'cqt');
    const frameSize = Math.max(1024, isCQT ? Math.max(fftSize, 16384) : (fftSize|0));
    const hopSize   = isCQT ? Math.max(128, Math.floor(frameSize/8)) : Math.floor(frameSize/2);
    const maxHarm   = isCQT ? 8 : 6;
    const { tables, window } = buildHarmonicTables(sampleRate, maxHarm, frameSize);
    const nBins = frameSize/2;

    const framesMag = [];
    const framesTime = [];
    const salRows = [];

    const numFrames = Math.max(0, Math.floor((audioArray.length - frameSize)/hopSize));

    const re = new Float32Array(frameSize);
    const im = new Float32Array(frameSize);

    for (let f=0; f<numFrames; f++){
      const start = f*hopSize;
      const frame = applyWindow(audioArray.subarray(start, start+frameSize), window);
      framesTime.push(frame);
      re.set(frame); im.fill(0); fftRadix2(re, im);
      const mags = new Float32Array(nBins);
      for (let k=0;k<nBins;k++){ const rr=re[k], ii=im[k]; mags[k]=Math.hypot(rr,ii); }
      framesMag.push(mags);

      const sal = new Float32Array(MIDI_MAX-MIDI_MIN+1);
      let maxSal=0;
      for (let idx=0; idx<tables.length; idx++){
        const hs=tables[idx].harmonics; let s=0;
        for (let h=0; h<hs.length; h++){ const {k,coeff}=hs[h]; s += (1/k) * goertzelPower(frame, coeff); }
        sal[idx]=s; if (s>maxSal) maxSal=s;
      }
      const row = new Uint8Array(sal.length);
      if (maxSal>0){ for (let i=0;i<sal.length;i++){ row[i]=Math.max(0,Math.min(255, Math.round(255*sal[i]/maxSal))); } }
      salRows.push(row);
    }

    const hopSec = hopSize / sampleRate;
    const notesOut = [];

    for (let f=0; f<numFrames; f++){
      const time = timeOffset + f*hopSec;
      const frame = framesTime[f];
      const mags  = framesMag[f];
      const salRow = salRows[f];
      const frameDur = hopSec;

      if (algorithm==='rhythm') continue;

      if (algorithm==='mono'){
      if (algorithm==='poly2'){
        const harm = medianFilterFreq(mags, 9);
        const perc_med = new Float32Array(mags.length);
        for (let k=0;k<mags.length;k++) perc_med[k] = localTimeMedian(framesMag, k, f);
        const harmMask = new Float32Array(mags.length);
        for (let k=0;k<mags.length;k++) harmMask[k] = harm[k] / (harm[k] + perc_med[k] + 1e-9);

        const logSpec = new Float32Array(mags.length);
        for (let k=0;k<mags.length;k++) logSpec[k] = Math.log10(1e-9 + mags[k]);
        const smooth = new Float32Array(mags.length);
        const wlen = 25, half = (wlen|0)>>1;
        for (let k=0;k<mags.length;k++){
          let s=0, c=0;
          for (let j=k-half;j<=k+half;j++){
            if (j>=0 && j<logSpec.length){ s += logSpec[j]; c++; }
          }
          smooth[k] = s/(c||1);
        }
        const white = new Float32Array(mags.length);
        for (let k=0;k<mags.length;k++) white[k] = Math.max(0, logSpec[k] - smooth[k]);

        const freqPerBin = sampleRate/(2*nBins);
        function sampleWhite(bin){
          const i0 = Math.floor(bin);
          const frac = bin - i0;
          if (i0<0 || i0>=white.length-1) return 0;
          return white[i0]*(1-frac) + white[i0+1]*frac;
        }

        const salLen = MIDI_MAX-MIDI_MIN+1;
        const salComb = new Float32Array(salLen);
        let maxSal = 0;
        const maxH = 8;
        const centsTol = 15;
        const detunes = [-centsTol, 0, +centsTol];
        for (let m=MIDI_MIN; m<=MIDI_MAX; m++){
          const idx = m - MIDI_MIN;
          const f0 = A4*Math.pow(2,(m-69)/12);
          let s = 0;
          for (let h=1; h<=maxH; h++){
            const base = f0*h;
            if (base >= sampleRate*0.5) break;
            let best = 0;
            for (let d=0; d<detunes.length; d++){
              const det = detunes[d];
              const factor = Math.pow(2, det/1200);
              const f = base*factor;
              const bin = f / freqPerBin;
              const v = sampleWhite(bin);
              if (v>best) best = v;
            }
            const weight = 1.0/h;
            const b0 = base/freqPerBin;
            const maskVal = harmMask[Math.min(harmMask.length-1, Math.max(0, Math.round(b0)))];
            s += weight * best * (0.6 + 0.4*maskVal);
          }
          salComb[idx] = s;
          if (s>maxSal) maxSal = s;
        }
        const salRow2 = new Uint8Array(salLen);
        if (maxSal>0){
          for (let i=0;i<salLen;i++){
            salRow2[i] = Math.max(0, Math.min(255, Math.round(255*salComb[i]/maxSal)));
          }
        }

        const arr = Array.from(salRow2);
        const sorted = arr.slice().sort((a,b)=>a-b);
        const med = sorted[Math.floor(arr.length*0.5)];
        const p90 = sorted[Math.floor(arr.length*0.9)];
        let thrLoc = Math.max(30, Math.min(220, Math.floor(med*0.7 + p90*0.3)));
        const thrParam = Math.max(0, Math.min(1000, threshold|0));
        const add = Math.floor(thrParam/6);
        thrLoc = Math.min(240, thrLoc + add);

        const cand = [];
        function isPeak2(i){ const L=i>0?arr[i-1]:-1, R=i<arr.length-1?arr[i+1]:-1; return arr[i]>=L && arr[i]>=R; }
        const masked = arr.slice();
        let found = 0;
        while (found < 20){
          let bi=-1, bv=thrLoc;
          for (let i=0;i<masked.length;i++){ const v=masked[i]; if (v>bv && isPeak2(i)){ bi=i; bv=v; } }
          if (bi<0) break;
          const m = MIDI_MIN + bi;
          const oct = bi-12;
          if (oct>=0 && masked[oct] > bv*0.85) cand.push(MIDI_MIN + oct);
          else cand.push(m);
          for (let h=1; h<=6; h++){
            const mh = Math.round(m + 12*Math.log2(h));
            const j = mh - MIDI_MIN;
            for (let d=-1; d<=1; d++){ const idx=j+d; if (idx>=0 && idx<masked.length) masked[idx]*=0.2; }
          }
          for (let d=-1; d<=1; d++){ const idx=bi+d; if (idx>=0 && idx<masked.length) masked[idx]*=0.0; }
          found++;
        }

        const uniq = Array.from(new Set(cand));
        const outList=[];
        for (const m of uniq){
          const idx = m - MIDI_MIN;
          const s = salComb[idx] || 0;
          const vel = Math.max(10, Math.min(127, Math.round(18 + 109 * (maxSal>0 ? (s/maxSal) : 0))));
          outList.push({ pitch:m, velocity:vel });
        }
        let frameList2 = pruneHarmonics(outList, harmonicRejection);
        frameList2.sort((a,b)=>b.velocity-a.velocity);
        const frameList = frameList2.slice(0, 20);
        for (const c of frameList){
          notesOut.push({ time, pitch:c.pitch, velocity:c.velocity, duration:hopSec });
        }
        continue;
      }

        const f0 = yinMono(frame, sampleRate, 40, 5000);
        if (f0){ const m = Math.round(freqToMidi(f0)); if (m>=MIDI_MIN && m<=MIDI_MAX){
          const vel = Math.max(10, Math.min(127, Math.round(20 + 0.42*(salRow[m-MIDI_MIN]||0))));
          notesOut.push({ time, pitch:m, velocity:vel, duration:frameDur });
        }}
        continue;
      }

      let frameList=[];

      if (algorithm==='poly'){
        const arr = Array.from(salRow);
        const masked = arr.map(v=>v);
        function isPeak(i){ const L=i>0?masked[i-1]:-1, R=i<masked.length-1?masked[i+1]:-1; return masked[i]>=L && masked[i]>=R; }
        let count=0, thr= Math.max(30, 0.5*Math.max(...masked));
        while (count<16){
          let bi=-1,bv=thr;
          for (let i=0;i<masked.length;i++){ const v=masked[i]; if (v>bv && isPeak(i)){ bi=i; bv=v; } }
          if (bi<0) break;
          const m = MIDI_MIN + bi;
          const vel = Math.max(10, Math.min(127, Math.round(20 + 0.42*bv)));
          frameList.push({ pitch:m, velocity:vel });
          for (let h=1; h<=8; h++){
            const mh = Math.round(m + 12*Math.log2(h));
            const j = mh - MIDI_MIN;
            for (let d=-1; d<=1; d++){ const idx=j+d; if (idx>=0 && idx<masked.length) masked[idx]*=0.1; }
          }
          count++;
        }
      } else { // poly_new or hybrid
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
        const candidates=[];
        for (let i=2;i<hps.length-2;i++){
          if (hps[i]>hpsThr && hps[i]>=hps[i-1] && hps[i]>=hps[i+1]){
            const m = specBinToMidi(i, sampleRate, nBins);
            if (m>=MIDI_MIN && m<=MIDI_MAX) candidates.push(m);
          }
        }
        const arr = Array.from(salRow);
        const topS=[]; const tmp=arr.slice();
        for (let k=0;k<10;k++){
          let bi=-1,bv=0;
          for (let i=0;i<tmp.length;i++){ if (tmp[i]>bv){ bv=tmp[i]; bi=i; } }
          if (bi<0) break;
          topS.push(MIDI_MIN+bi);
          tmp[bi]=0;
        }
        const merged = new Set([...candidates, ...topS]);
        const finalCand = new Set();
        merged.forEach(m=>{ if (merged.has(m-12)) finalCand.add(m-12); else finalCand.add(m); });
        const outList=[];
        finalCand.forEach(m=>{
          const idx=m-MIDI_MIN;
          const s = arr[idx]||0; if (s<20) return;
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
      frameList = pruneHarmonics(frameList, harmonicRejection);

      for (const c of frameList){
        notesOut.push({ time, pitch:c.pitch, velocity:c.velocity, duration:frameDur });
      }
    }

    if (algorithm==='rhythm'){
      const N=framesMag.length; if (N>0){
        let prev=null; const flux=new Float32Array(N);
        for (let i=0;i<N;i++){ const cur=framesMag[i]; if (!prev){ flux[i]=0; prev=cur; continue; } let s=0; for (let k=0;k<cur.length;k++){ const d=cur[k]-prev[k]; if (d>0) s+=d; } flux[i]=s; prev=cur; }
        const win=16; const thr=new Float32Array(N);
        for (let i=0;i<N;i++){ const a=[]; for (let j=Math.max(0,i-win); j<Math.min(N,i+win); j++) a.push(flux[j]); a.sort((x,y)=>x-y); thr[i]=a.length? a[Math.floor(a.length*0.6)]*1.2:0; }
        for (let i=1;i<N-1;i++){ if (flux[i]>thr[i] && flux[i]>=flux[i-1] && flux[i]>=flux[i+1]){
          const t=timeOffset + i*(hopSec); const vel=Math.max(10, Math.min(127, Math.round(20 + 100*(flux[i]/(thr[i]+1e-9))))); notesOut.push({ time:t, pitch:36, velocity:vel, duration:0.1 });
        }}
      }
    }

    self.postMessage({ 
      type: 'progress', 
      chunkIndex, 
      totalChunks, 
      notes: notesOut, 
      salRows: salRows, 
      hopSec: hopSec
    });

  }catch(err){
    self.postMessage({ type:'error', error: err?.message || String(err) });
  } finally {
    isProcessing = false;
  }
}
