// Web Worker for Audio Analysis
// Handles heavy FFT computations off the main thread

let isProcessing = false;
let isCancelled = false;

self.onmessage = function(e) {
  const { type, data } = e.data;
  
  switch(type) {
    case 'analyze':
      analyzeChunk(data);
      break;
    case 'cancel':
      isCancelled = true;
      break;
    case 'reset':
      isCancelled = false;
      isProcessing = false;
      break;
  }
};

function analyzeChunk(data) {
  const { audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset } = data;
  
  // Convert array back to Float32Array if needed
  const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
  
  if (isCancelled) {
    self.postMessage({ type: 'cancelled' });
    return;
  }
  
  isProcessing = true;
  
  try {
    // Perform FFT analysis on this chunk
    const hopSize = Math.floor(fftSize / 2);
    const notes = [];
    const spectrumData = [];
    
    const numFrames = Math.floor((audioArray.length - fftSize) / hopSize);
    
    for (let frame = 0; frame < numFrames; frame++) {
      if (isCancelled) {
        self.postMessage({ type: 'cancelled' });
        return;
      }
      
      const startSample = frame * hopSize;
      const frameData = audioArray.slice(startSample, startSample + fftSize);
      
      // Apply Hanning window
      const windowedData = applyHannWindow(frameData);
      
      // Perform FFT using optimized algorithm
      const spectrum = fastFFT(windowedData);
      
      // Store spectrum data for visualization (downsample for efficiency)
      if (frame % 4 === 0) {
        spectrumData.push(spectrum.slice(0, Math.floor(spectrum.length / 4)));
      }
      
      // Find peaks in spectrum
      const peaks = findSpectralPeaks(spectrum, sampleRate, fftSize, threshold);
      
      // Convert peaks to notes
      const time = timeOffset + (startSample / sampleRate);
      
      for (const peak of peaks) {
        const frequency = peak.frequency;
        const amplitude = peak.amplitude;
        
        // Convert frequency to MIDI note
        const midiNote = frequencyToMIDI(frequency);
        
        if (midiNote >= 21 && midiNote <= 108) { // Piano range
          const velocity = Math.min(127, Math.max(10, Math.floor(amplitude * 200)));
          
          notes.push({
            time: time,
            pitch: midiNote,
            frequency: frequency,
            velocity: velocity,
            duration: 0.1
          });
        }
      }
    }
    
    // Send results back to main thread
    self.postMessage({
      type: 'progress',
      chunkIndex: chunkIndex,
      totalChunks: totalChunks,
      notes: notes,
      spectrumData: spectrumData
    });
    
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error.message
    });
  }
  
  isProcessing = false;
}

function applyHannWindow(data) {
  const windowed = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    windowed[i] = data[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (data.length - 1)));
  }
  return windowed;
}

// Optimized FFT using Cooley-Tukey algorithm
function fastFFT(data) {
  const n = data.length;
  
  // For non-power-of-2, use DFT
  if (!isPowerOfTwo(n)) {
    return dft(data);
  }
  
  // Base case
  if (n <= 1) {
    return new Float32Array([Math.abs(data[0] || 0)]);
  }
  
  // Divide
  const even = new Float32Array(n / 2);
  const odd = new Float32Array(n / 2);
  
  for (let i = 0; i < n / 2; i++) {
    even[i] = data[2 * i];
    odd[i] = data[2 * i + 1];
  }
  
  // Conquer
  const evenFFT = fastFFT(even);
  const oddFFT = fastFFT(odd);
  
  // Combine
  const spectrum = new Float32Array(n / 2);
  
  for (let k = 0; k < n / 2; k++) {
    const angle = -2 * Math.PI * k / n;
    const real = Math.cos(angle) * oddFFT[k];
    const imag = Math.sin(angle) * oddFFT[k];
    
    const magnitude = Math.sqrt(
      Math.pow(evenFFT[k] + real, 2) + Math.pow(imag, 2)
    );
    
    spectrum[k] = magnitude / n;
  }
  
  return spectrum;
}

// Fallback DFT for non-power-of-2 sizes (optimized version)
function dft(data) {
  const n = data.length;
  const spectrum = new Float32Array(Math.floor(n / 2));
  
  for (let k = 0; k < spectrum.length; k++) {
    let real = 0;
    let imag = 0;
    
    // Only compute up to Nyquist frequency
    const step = Math.max(1, Math.floor(n / 2048)); // Downsample for speed
    
    for (let i = 0; i < n; i += step) {
      const angle = -2 * Math.PI * k * i / n;
      real += data[i] * Math.cos(angle);
      imag += data[i] * Math.sin(angle);
    }
    
    spectrum[k] = Math.sqrt(real * real + imag * imag) / n;
  }
  
  return spectrum;
}

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

function findSpectralPeaks(spectrum, sampleRate, fftSize, threshold = 30) {
  const peaks = [];
  // Convert threshold (10-100) to amplitude threshold (0.01-0.5)
  // Lower threshold = more sensitive = lower amplitude required
  const thresholdValue = 0.01 + ((100 - threshold) / 100) * 0.49;
  
  console.log('Finding peaks with threshold:', threshold, 'amplitude threshold:', thresholdValue);
  
  // Find local maxima with improved peak detection
  for (let i = 3; i < spectrum.length - 3; i++) {
    const current = spectrum[i];
    
    if (current > thresholdValue &&
        current > spectrum[i - 1] &&
        current > spectrum[i - 2] &&
        current > spectrum[i - 3] &&
        current > spectrum[i + 1] &&
        current > spectrum[i + 2] &&
        current > spectrum[i + 3]) {
      
      const frequency = i * sampleRate / fftSize;
      
      // Filter to musical range (27.5 Hz to 4200 Hz)
      if (frequency >= 27.5 && frequency <= 4200) {
        // Parabolic interpolation for better frequency accuracy
        const alpha = spectrum[i - 1];
        const beta = spectrum[i];
        const gamma = spectrum[i + 1];
        const offset = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);
        const refinedFreq = (i + offset) * sampleRate / fftSize;
        
        peaks.push({
          frequency: refinedFreq,
          amplitude: current
        });
      }
    }
  }
  
  // Sort by amplitude and take top peaks
  peaks.sort((a, b) => b.amplitude - a.amplitude);
  // Adjust max peaks based on threshold - lower threshold = more peaks allowed
  const maxPeaks = Math.floor(4 + (100 - threshold) / 10);
  return peaks.slice(0, maxPeaks);
}

function frequencyToMIDI(frequency) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
}
