// Audio to MIDI Converter - Main Application (FIXED VERSION)

let audioContext = null;
let audioBuffer = null;
let audioSource = null;
let analyser = null;
let detectedNotes = [];
let detectedBPM = 0;
let isPlaying = false;
let currentTime = 0;
let animationFrame = null;

// Worker and processing state
let audioWorker = null;
let isAnalyzing = false;
let isCancelled = false;
let analysisStartTime = 0;
let processedChunks = 0;
let totalChunks = 0;

// Performance monitoring
let memoryCheckInterval = null;

// Analysis parameters
const ANALYSIS_MODES = {
  full: { fftSize: 2048, resolution: 'high' },
  fast: { fftSize: 1024, resolution: 'medium' },
  fallback: { fftSize: 512, resolution: 'low' }
};

const MAX_FILE_SIZE_MB = 200;
const WARNING_SIZE_MB = 50;
const MAX_PROCESSING_TIME_SECONDS = 900;
const CHUNK_SIZE = 4096 * 32; // 128KB chunks

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4_FREQUENCY = 440;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
});

function setupEventListeners() {
  const uploadSection = document.getElementById('uploadSection');
  const fileInput = document.getElementById('fileInput');

  // Drag and drop
  uploadSection.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadSection.classList.add('dragover');
  });

  uploadSection.addEventListener('dragleave', () => {
    uploadSection.classList.remove('dragover');
  });

  uploadSection.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadSection.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  });

  // File input
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  });

  // Playback controls
  document.getElementById('playBtn').addEventListener('click', playAudio);
  document.getElementById('pauseBtn').addEventListener('click', pauseAudio);
  document.getElementById('stopBtn').addEventListener('click', stopAudio);

  // Playback speed
  document.getElementById('playbackSpeed').addEventListener('input', (e) => {
    const value = e.target.value;
    document.getElementById('playbackSpeedValue').textContent = value + '%';
    if (audioSource && audioSource.playbackRate) {
      audioSource.playbackRate.value = value / 100;
    }
  });

  // Threshold
  document.getElementById('threshold').addEventListener('input', (e) => {
    const value = e.target.value;
    document.getElementById('thresholdValue').textContent = value;
    // Update current note count display
    if (detectedNotes.length > 0) {
      document.getElementById('currentNoteCount').textContent = detectedNotes.length + ' (cambia soglia e ri-analizza per aggiornare)';
    }
  });

  // Reanalyze
  document.getElementById('reanalyzeBtn').addEventListener('click', () => {
    if (audioBuffer) {
      const threshold = parseInt(document.getElementById('threshold').value);
      analyzeAudio(audioBuffer, threshold);
    }
  });

  // Export
  document.getElementById('exportBtn').addEventListener('click', exportToMIDI);
  
  // Cancel button
  document.getElementById('cancelBtn').addEventListener('click', cancelAnalysis);
  
  // Analysis mode
  document.getElementById('analysisMode').addEventListener('change', (e) => {
    if (audioBuffer && !isAnalyzing) {
      const threshold = parseInt(document.getElementById('threshold').value);
      analyzeAudio(audioBuffer, threshold);
    }
  });
  
  // Initialize Web Worker
  initializeWorker();
}

function initializeWorker() {
  try {
    audioWorker = new Worker('audio-worker.js');
    
    audioWorker.onmessage = (e) => {
      const { type, chunkIndex, totalChunks, notes, spectrumData, error } = e.data;
      
      switch(type) {
        case 'progress':
          handleWorkerProgress(chunkIndex, totalChunks, notes, spectrumData);
          break;
        case 'cancelled':
          handleCancellation();
          break;
        case 'error':
          showStatus('Error during analysis: ' + error, 'error');
          resetAnalysisState();
          break;
      }
    };
    
    audioWorker.onerror = (error) => {
      console.error('Worker error:', error);
      showStatus('Worker error: ' + error.message, 'error');
      resetAnalysisState();
    };
    
  } catch (error) {
    console.error('Failed to initialize worker:', error);
    showStatus('Web Worker not supported. Analysis may be slower.', 'info');
  }
}

function cancelAnalysis() {
  isCancelled = true;
  
  if (audioWorker) {
    audioWorker.postMessage({ type: 'cancel' });
  }
  
  showStatus('Analysis cancelled by user.', 'info');
  resetAnalysisState();
}

function resetAnalysisState() {
  isAnalyzing = false;
  isCancelled = false;
  processedChunks = 0;
  totalChunks = 0;
  
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('progressContainer').style.display = 'none';
  
  if (memoryCheckInterval) {
    clearInterval(memoryCheckInterval);
    memoryCheckInterval = null;
  }
  
  updateStatusIndicator('idle', 'Ready');
  
  if (audioWorker) {
    audioWorker.postMessage({ type: 'reset' });
  }
}

function handleFileSelect(file) {
  // Check file size
  const fileSizeMB = file.size / (1024 * 1024);
  
  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    showWarning(`File size (${fileSizeMB.toFixed(1)} MB) exceeds maximum limit of ${MAX_FILE_SIZE_MB} MB. Please use a smaller file.`);
    return;
  }
  
  if (fileSizeMB > WARNING_SIZE_MB) {
    showWarning(`Large file detected (${fileSizeMB.toFixed(1)} MB). Processing may take several minutes. Consider using Fast or Low Memory mode.`);
  }
  
  // Validate file type
  const validTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3'];
  const validExtensions = ['.wav', '.mp3'];
  const fileName = file.name.toLowerCase();
  const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));

  if (!validTypes.includes(file.type) && !hasValidExtension) {
    showStatus('Formato file non valido. Seleziona un file WAV o MP3.', 'error');
    return;
  }

  // Show file info
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatFileSize(file.size);
  document.getElementById('fileInfo').style.display = 'block';

  // Show progress
  document.getElementById('progressContainer').style.display = 'block';
  updateProgress(0, 'Caricamento file...');

  // Read file
  const reader = new FileReader();
  reader.onload = (e) => {
    updateProgress(30, 'Decodifica audio...');
    loadAudioData(e.target.result);
  };
  reader.onerror = () => {
    showStatus('Errore durante la lettura del file.', 'error');
    document.getElementById('progressContainer').style.display = 'none';
  };
  reader.readAsArrayBuffer(file);
}

function showWarning(message) {
  const warningDiv = document.getElementById('warningMessage');
  warningDiv.textContent = '⚠️ ' + message;
  warningDiv.style.display = 'block';
  
  setTimeout(() => {
    warningDiv.style.display = 'none';
  }, 10000);
}

async function loadAudioData(arrayBuffer) {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    updateProgress(50, 'Elaborazione audio...');
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Update file info
    const duration = audioBuffer.duration;
    document.getElementById('fileDuration').textContent = formatDuration(duration);
    document.getElementById('sampleRate').textContent = audioBuffer.sampleRate + ' Hz';

    updateProgress(70, 'Starting analysis...');
    
    // Start analysis
    const threshold = parseInt(document.getElementById('threshold').value);
    await analyzeAudio(audioBuffer, threshold);

    updateProgress(100, 'Completed!');
    updateStatusIndicator('completed', 'Complete');
    
    setTimeout(() => {
      document.getElementById('progressContainer').style.display = 'none';
      document.getElementById('cancelBtn').style.display = 'none';
    }, 2000);

    // Show analysis section
    document.getElementById('analysisSection').style.display = 'block';

  } catch (error) {
    console.error('Error loading audio:', error);
    showStatus('Errore durante la decodifica del file audio: ' + error.message, 'error');
    document.getElementById('progressContainer').style.display = 'none';
  }
}

async function analyzeAudio(buffer, threshold = 30) {
  if (isAnalyzing) {
    showStatus('Analysis already in progress', 'info');
    return;
  }
  
  console.log('Starting analysis with buffer:', buffer, 'threshold:', threshold);
  
  try {
    isAnalyzing = true;
    isCancelled = false;
    detectedNotes = [];
    analysisStartTime = Date.now();
    
    // Show progress and cancel button
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('cancelBtn').style.display = 'block';
    updateProgress(0, 'Initializing analysis...');
    updateStatusIndicator('processing', 'Analyzing');
    
    // Start memory monitoring
    startMemoryMonitoring();
    
    // Detect BPM first (fast operation)
    updateProgress(10, 'Detecting BPM...');
    try {
      detectedBPM = await detectBPMOptimized(buffer);
      console.log('Detected BPM:', detectedBPM);
      document.getElementById('bpmValue').textContent = Math.round(detectedBPM);
    } catch (error) {
      console.error('BPM detection error:', error);
      detectedBPM = 120; // Default fallback
      document.getElementById('bpmValue').textContent = '120 (default)';
    }
    
    if (isCancelled) {
      handleCancellation();
      return;
    }
    
    // Get analysis mode
    const mode = document.getElementById('analysisMode').value;
    const fftSize = ANALYSIS_MODES[mode].fftSize;
    
    // Process audio in chunks using Web Worker
    updateProgress(20, 'Processing audio chunks...');
    await processAudioInChunks(buffer, fftSize, threshold);
    
    if (isCancelled) {
      handleCancellation();
      return;
    }
    
    // Post-process detected notes
    updateProgress(90, 'Post-processing notes...');
    detectedNotes = postProcessNotes(detectedNotes);
    document.getElementById('notesCount').textContent = detectedNotes.length;
    document.getElementById('currentNoteCount').textContent = detectedNotes.length;
    document.getElementById('thresholdUsed').textContent = threshold;

    // Update duration
    document.getElementById('trackDuration').textContent = buffer.duration.toFixed(2);

    // Calculate frequency range
    if (detectedNotes.length > 0) {
      const frequencies = detectedNotes.map(n => n.frequency);
      const minFreq = Math.min(...frequencies);
      const maxFreq = Math.max(...frequencies);
      document.getElementById('freqRange').textContent = `${minFreq.toFixed(0)}-${maxFreq.toFixed(0)}`;
    }

    // Log final results
    console.log('Analysis complete. Detected', detectedNotes.length, 'notes with threshold', threshold);
    
    // Update results
    document.getElementById('trackDuration').textContent = buffer.duration.toFixed(2);
    
    if (detectedNotes.length > 0) {
      const frequencies = detectedNotes.map(n => n.frequency);
      const minFreq = Math.min(...frequencies);
      const maxFreq = Math.max(...frequencies);
      document.getElementById('freqRange').textContent = `${minFreq.toFixed(0)}-${maxFreq.toFixed(0)}`;
    }
    
    // Draw visualizations
    updateProgress(95, 'Rendering visualizations...');
    drawWaveform(buffer);
    drawPianoRoll(detectedNotes, buffer.duration);
    
    // Update notes table
    updateNotesTable(detectedNotes);
    
    console.log('Final note count:', detectedNotes.length, 'with threshold:', threshold);
    
    // Complete
    updateProgress(100, 'Analysis complete!');
    updateStatusIndicator('completed', 'Complete');
    
    const elapsedTime = ((Date.now() - analysisStartTime) / 1000).toFixed(1);
    showStatus(`Analysis completed in ${elapsedTime}s. Found ${detectedNotes.length} notes.`, 'success');
    
    resetAnalysisState();

  } catch (error) {
    console.error('Error analyzing audio:', error);
    showStatus('Errore durante l\'analisi: ' + error.message, 'error');
  }
}

async function processAudioInChunks(buffer, fftSize, threshold) {
  console.log('Processing audio in chunks. FFT size:', fftSize, 'Threshold:', threshold);
  
  const channelData = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  
  // Calculate number of chunks
  totalChunks = Math.ceil(channelData.length / CHUNK_SIZE);
  processedChunks = 0;
  
  console.log('Total chunks to process:', totalChunks);
  
  // Process each chunk
  for (let i = 0; i < totalChunks; i++) {
    if (isCancelled) {
      console.log('Processing cancelled at chunk', i);
      return;
    }
    
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, channelData.length);
    const chunkData = channelData.slice(start, end);
    
    // Send to worker for processing
    if (audioWorker) {
      try {
        await processChunkWithWorker(chunkData, sampleRate, i, totalChunks, fftSize, threshold, start / sampleRate);
      } catch (error) {
        console.error('Worker processing error:', error);
        // Fallback to main thread
        await processChunkMainThread(chunkData, sampleRate, i, totalChunks, fftSize, threshold, start / sampleRate);
      }
    } else {
      // Fallback to main thread (slower but works)
      await processChunkMainThread(chunkData, sampleRate, i, totalChunks, fftSize, threshold, start / sampleRate);
    }
    
    // Check timeout
    const elapsed = (Date.now() - analysisStartTime) / 1000;
    if (elapsed > MAX_PROCESSING_TIME_SECONDS) {
      throw new Error('Analysis timeout. File may be too large or complex.');
    }
  }
  
  console.log('Finished processing all chunks. Total notes found:', detectedNotes.length);
}

function processChunkWithWorker(audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      audioWorker.removeEventListener('message', listener);
      reject(new Error('Worker timeout'));
    }, 30000); // 30 second timeout per chunk
    
    const listener = (e) => {
      if (e.data.type === 'progress' && e.data.chunkIndex === chunkIndex) {
        clearTimeout(timeout);
        audioWorker.removeEventListener('message', listener);
        resolve();
      } else if (e.data.type === 'error') {
        clearTimeout(timeout);
        audioWorker.removeEventListener('message', listener);
        reject(new Error(e.data.error || 'Worker error'));
      } else if (e.data.type === 'cancelled') {
        clearTimeout(timeout);
        audioWorker.removeEventListener('message', listener);
        resolve();
      }
    };
    
    audioWorker.addEventListener('message', listener);
    audioWorker.postMessage({
      type: 'analyze',
      data: {
        audioData: Array.from(audioData),
        sampleRate: sampleRate,
        chunkIndex: chunkIndex,
        totalChunks: totalChunks,
        fftSize: fftSize,
        threshold: threshold,
        timeOffset: timeOffset
      }
    });
  });
}

async function processChunkMainThread(audioData, sampleRate, chunkIndex, totalChunks, fftSize, threshold, timeOffset) {
  // Simplified main thread processing (less accurate but won't freeze)
  await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI
  
  console.log('Processing chunk', chunkIndex, 'on main thread with threshold:', threshold);
  
  // Perform basic pitch detection
  const hopSize = Math.floor(fftSize / 2);
  const numFrames = Math.floor((audioData.length - fftSize) / hopSize);
  
  for (let frame = 0; frame < numFrames; frame += 4) { // Process every 4th frame for speed
    const startSample = frame * hopSize;
    if (startSample + fftSize > audioData.length) break;
    
    const frameData = audioData.slice(startSample, startSample + fftSize);
    const frequency = detectPitchAutocorrelation(frameData, sampleRate, threshold);
    
    if (frequency > 0 && frequency >= 27.5 && frequency <= 4200) {
      const midiNote = frequencyToMIDI(frequency);
      if (midiNote >= 21 && midiNote <= 108) {
        const time = timeOffset + (startSample / sampleRate);
        const rms = calculateRMS(frameData);
        const velocity = Math.min(127, Math.max(10, Math.floor(rms * 300)));
        
        detectedNotes.push({
          time: time,
          pitch: midiNote,
          frequency: frequency,
          velocity: velocity,
          duration: 0.1
        });
      }
    }
  }
  
  const progress = ((chunkIndex + 1) / totalChunks) * 70 + 20;
  updateProgress(progress, `Processing chunk ${chunkIndex + 1}/${totalChunks}...`);
  
  processedChunks++;
}

function detectPitchAutocorrelation(buffer, sampleRate, threshold = 30) {
  const SIZE = buffer.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);
  let best_offset = -1;
  let best_correlation = 0;
  let rms = 0;
  
  // Calculate RMS
  for (let i = 0; i < SIZE; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);
  
  // Threshold affects minimum signal level
  const minSignal = 0.01 * (threshold / 30); // Scale with threshold
  if (rms < minSignal) return -1;
  
  // Autocorrelation
  let lastCorrelation = 1;
  for (let offset = 1; offset < MAX_SAMPLES; offset++) {
    let correlation = 0;
    
    for (let i = 0; i < MAX_SAMPLES; i++) {
      correlation += Math.abs(buffer[i] - buffer[i + offset]);
    }
    
    correlation = 1 - (correlation / MAX_SAMPLES);
    
    if (correlation > 0.9 && correlation > lastCorrelation) {
      const foundGoodCorrelation = correlation > best_correlation;
      if (foundGoodCorrelation) {
        best_correlation = correlation;
        best_offset = offset;
      }
    }
    
    lastCorrelation = correlation;
  }
  
  // Threshold affects minimum correlation required
  const minCorrelation = 0.01 * (threshold / 30);
  if (best_offset === -1 || best_correlation < minCorrelation) return -1;
  
  const frequency = sampleRate / best_offset;
  return frequency;
}

function calculateRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function handleWorkerProgress(chunkIndex, totalChunks, notes, spectrumData) {
  // Add notes from this chunk
  detectedNotes.push(...notes);
  
  // Update note count in real-time
  document.getElementById('currentNoteCount').textContent = detectedNotes.length;
  
  processedChunks++;
  
  // Update progress
  const progress = (processedChunks / totalChunks) * 70 + 20;
  const elapsed = (Date.now() - analysisStartTime) / 1000;
  const rate = processedChunks / elapsed;
  const remaining = (totalChunks - processedChunks) / rate;
  
  updateProgress(
    progress,
    `Processing chunk ${processedChunks}/${totalChunks}...`,
    elapsed,
    remaining
  );
}

function handleCancellation() {
  showStatus('Analysis cancelled.', 'info');
  resetAnalysisState();
}

function postProcessNotes(notes) {
  if (notes.length === 0) return [];
  
  // Sort by time
  notes.sort((a, b) => a.time - b.time);
  
  // Remove duplicates and merge close notes
  const filtered = [];
  const minDuration = 0.05;
  const mergeWindow = 0.1;
  
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    
    if (note.duration < minDuration) continue;
    
    // Check if we should merge with previous note
    const lastNote = filtered[filtered.length - 1];
    if (lastNote &&
        Math.abs(lastNote.pitch - note.pitch) <= 1 &&
        (note.time - (lastNote.time + lastNote.duration)) < mergeWindow) {
      // Extend previous note
      lastNote.duration = note.time + note.duration - lastNote.time;
      lastNote.velocity = Math.max(lastNote.velocity, note.velocity);
    } else {
      // Add as new note
      filtered.push({ ...note });
    }
  }
  
  return filtered;
}

async function detectBPMOptimized(buffer) {
  // Downsample for faster BPM detection
  const targetSampleRate = 8000;
  const downsampled = downsampleAudio(buffer.getChannelData(0), buffer.sampleRate, targetSampleRate);
  
  return detectBPM(downsampled, targetSampleRate);
}

function downsampleAudio(data, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const length = Math.floor(data.length / ratio);
  const result = new Float32Array(length);
  
  for (let i = 0; i < length; i++) {
    result[i] = data[Math.floor(i * ratio)];
  }
  
  return result;
}

function detectBPM(data, sampleRate) {
  // Ensure we have the right data format
  if (data instanceof AudioBuffer) {
    const buffer = data;
    data = buffer.getChannelData(0);
    sampleRate = buffer.sampleRate;
  }
  
  // Low-pass filter for beat detection
  const filteredData = lowPassFilter(data, sampleRate, 150);
  
  // Find peaks in the filtered signal
  const peaks = findPeaks(filteredData, sampleRate);
  
  // Calculate intervals between peaks
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }
  
  if (intervals.length === 0) return 120; // Default BPM
  
  // Calculate average interval
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  
  // Convert to BPM
  const bpm = 60 / avgInterval;
  
  // Clamp to reasonable range
  return Math.max(60, Math.min(200, bpm));
}

function lowPassFilter(data, sampleRate, cutoffFreq) {
  const RC = 1.0 / (cutoffFreq * 2 * Math.PI);
  const dt = 1.0 / sampleRate;
  const alpha = dt / (RC + dt);
  
  const filtered = new Float32Array(data.length);
  filtered[0] = data[0];
  
  for (let i = 1; i < data.length; i++) {
    filtered[i] = filtered[i - 1] + alpha * (data[i] - filtered[i - 1]);
  }
  
  return filtered;
}

function findPeaks(data, sampleRate, minDistance = 0.3) {
  const peaks = [];
  const minSamples = Math.floor(minDistance * sampleRate);
  const threshold = calculateThreshold(data);
  
  for (let i = 1; i < data.length - 1; i++) {
    if (Math.abs(data[i]) > threshold &&
        Math.abs(data[i]) > Math.abs(data[i - 1]) &&
        Math.abs(data[i]) > Math.abs(data[i + 1])) {
      
      if (peaks.length === 0 || i - peaks[peaks.length - 1] * sampleRate > minSamples) {
        peaks.push(i / sampleRate);
      }
    }
  }
  
  return peaks;
}

function calculateThreshold(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += Math.abs(data[i]);
  }
  return (sum / data.length) * 1.5;
}

function startMemoryMonitoring() {
  if (performance.memory) {
    document.getElementById('memoryIndicator').style.display = 'block';
    
    memoryCheckInterval = setInterval(() => {
      const usedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
      const limitMB = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0);
      document.getElementById('memoryUsage').textContent = `${usedMB} / ${limitMB} MB`;
    }, 1000);
  }
}

function updateStatusIndicator(status, text) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  
  dot.className = 'status-dot ' + status;
  statusText.textContent = text;
}

// Note: FFT functions moved to worker

function frequencyToMIDI(frequency) {
  return Math.round(69 + 12 * Math.log2(frequency / A4_FREQUENCY));
}

function midiToNoteName(midi) {
  const noteIndex = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[noteIndex] + octave;
}

function midiToFrequency(midi) {
  return A4_FREQUENCY * Math.pow(2, (midi - 69) / 12);
}

function drawWaveform(buffer) {
  const canvas = document.getElementById('waveformCanvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-background');
  ctx.fillRect(0, 0, width, height);
  
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / width);
  const amp = height / 2;
  
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-primary');
  ctx.lineWidth = 1;
  ctx.beginPath();
  
  for (let i = 0; i < width; i++) {
    const min = Math.min(...Array.from(data.slice(i * step, (i + 1) * step)));
    const max = Math.max(...Array.from(data.slice(i * step, (i + 1) * step)));
    
    if (i === 0) {
      ctx.moveTo(i, (1 + min) * amp);
    }
    ctx.lineTo(i, (1 + min) * amp);
    ctx.lineTo(i, (1 + max) * amp);
  }
  
  ctx.stroke();
}

// Spectrogram removed for performance (was causing freezing)

function drawPianoRoll(notes, duration) {
  const canvas = document.getElementById('pianoRollCanvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-background');
  ctx.fillRect(0, 0, width, height);
  
  if (notes.length === 0) return;
  
  // Find MIDI range
  const midiNotes = notes.map(n => n.pitch);
  const minMidi = Math.min(...midiNotes);
  const maxMidi = Math.max(...midiNotes);
  const midiRange = maxMidi - minMidi + 1;
  
  // Draw piano keys background
  const noteHeight = height / midiRange;
  
  for (let i = 0; i < midiRange; i++) {
    const midi = minMidi + i;
    const noteIndex = midi % 12;
    const isBlackKey = [1, 3, 6, 8, 10].includes(noteIndex);
    
    ctx.fillStyle = isBlackKey ? 
      'rgba(100, 100, 100, 0.1)' : 
      'rgba(200, 200, 200, 0.05)';
    
    const y = height - (i + 1) * noteHeight;
    ctx.fillRect(0, y, width, noteHeight);
    
    // Draw grid lines
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-border');
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  
  // Draw notes
  const timeScale = width / duration;
  
  for (const note of notes) {
    const x = note.time * timeScale;
    const noteWidth = Math.max(2, note.duration * timeScale);
    const y = height - ((note.pitch - minMidi + 1) * noteHeight);
    
    // Color based on velocity
    const velocityRatio = note.velocity / 127;
    const hue = 180 - (velocityRatio * 60); // Cyan to blue
    const saturation = 70 + (velocityRatio * 30);
    const lightness = 50 + (velocityRatio * 20);
    
    ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    ctx.fillRect(x, y, noteWidth, noteHeight - 1);
    
    // Border
    ctx.strokeStyle = `hsl(${hue}, ${saturation}%, ${lightness - 20}%)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, noteWidth, noteHeight - 1);
  }
}

function updateNotesTable(notes) {
  const tbody = document.getElementById('notesTableBody');
  tbody.innerHTML = '';
  
  notes.forEach((note, index) => {
    const row = document.createElement('tr');
    
    const noteName = midiToNoteName(note.pitch);
    const octave = Math.floor(note.pitch / 12) - 1;
    
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${note.time.toFixed(3)}</td>
      <td><strong>${noteName.replace(/[0-9]/g, '')}</strong></td>
      <td>${octave}</td>
      <td>${note.frequency.toFixed(2)}</td>
      <td>${note.duration.toFixed(3)}</td>
      <td>${note.velocity}</td>
      <td>
        <div class="velocity-bar">
          <div class="velocity-bar-bg" style="width: 100px;">
            <div class="velocity-bar-inner" style="width: ${(note.velocity / 127) * 100}%;"></div>
          </div>
        </div>
      </td>
    `;
    
    tbody.appendChild(row);
  });
}

function sortNotes(sortBy) {
  if (detectedNotes.length === 0) return;
  
  switch (sortBy) {
    case 'time':
      detectedNotes.sort((a, b) => a.time - b.time);
      break;
    case 'pitch':
      detectedNotes.sort((a, b) => a.pitch - b.pitch);
      break;
    case 'velocity':
      detectedNotes.sort((a, b) => b.velocity - a.velocity);
      break;
  }
  
  updateNotesTable(detectedNotes);
}

function playAudio() {
  if (!audioBuffer) return;
  
  if (audioSource) {
    audioSource.stop();
  }
  
  audioSource = audioContext.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.playbackRate.value = parseInt(document.getElementById('playbackSpeed').value) / 100;
  audioSource.connect(audioContext.destination);
  
  audioSource.start(0, currentTime);
  isPlaying = true;
  
  document.getElementById('playBtn').disabled = true;
  document.getElementById('pauseBtn').disabled = false;
  document.getElementById('stopBtn').disabled = false;
  
  audioSource.onended = () => {
    isPlaying = false;
    currentTime = 0;
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
  };
}

function pauseAudio() {
  if (audioSource && isPlaying) {
    audioSource.stop();
    currentTime = audioContext.currentTime;
    isPlaying = false;
    
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
  }
}

function stopAudio() {
  if (audioSource) {
    audioSource.stop();
    currentTime = 0;
    isPlaying = false;
    
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
  }
}

function exportToMIDI() {
  if (detectedNotes.length === 0) {
    showStatus('Nessuna nota rilevata da esportare.', 'error');
    return;
  }
  
  try {
    const midiData = generateMIDIFile(detectedNotes, detectedBPM);
    const blob = new Blob([midiData], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'converted-audio.mid';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showStatus('File MIDI esportato con successo!', 'success');
  } catch (error) {
    console.error('Error exporting MIDI:', error);
    showStatus('Errore durante l\'esportazione: ' + error.message, 'error');
  }
}

function generateMIDIFile(notes, bpm) {
  console.log('Generating MIDI with', notes.length, 'notes at', bpm, 'BPM');
  
  // MIDI file format constants
  const TICKS_PER_BEAT = 480;
  
  // Calculate microseconds per quarter note
  const microsecondsPerBeat = Math.round(60000000 / bpm);
  
  // Header chunk
  const header = [
    0x4D, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // Header length (6 bytes)
    0x00, 0x00, // Format 0 (single track)
    0x00, 0x01, // Number of tracks (1)
    (TICKS_PER_BEAT >> 8) & 0xFF, TICKS_PER_BEAT & 0xFF // Ticks per quarter note
  ];
  
  // Build track events
  const trackEvents = [];
  
  // Add tempo meta event at start
  trackEvents.push(0x00); // Delta time
  trackEvents.push(0xFF, 0x51, 0x03); // Tempo meta event
  trackEvents.push(
    (microsecondsPerBeat >> 16) & 0xFF,
    (microsecondsPerBeat >> 8) & 0xFF,
    microsecondsPerBeat & 0xFF
  );
  
  // Sort notes by time and create note events
  const sortedNotes = [...notes].sort((a, b) => a.time - b.time);
  
  // Create parallel arrays for note on and note off events
  const events = [];
  
  for (const note of sortedNotes) {
    const startTick = Math.round((note.time * bpm * TICKS_PER_BEAT) / 60);
    const durationTicks = Math.max(10, Math.round((note.duration * bpm * TICKS_PER_BEAT) / 60));
    const endTick = startTick + durationTicks;
    
    events.push({
      tick: startTick,
      type: 'on',
      pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
      velocity: Math.max(1, Math.min(127, Math.round(note.velocity)))
    });
    
    events.push({
      tick: endTick,
      type: 'off',
      pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
      velocity: 64
    });
  }
  
  // Sort all events by tick
  events.sort((a, b) => a.tick - b.tick);
  
  // Write events with delta times
  let lastTick = 0;
  for (const event of events) {
    const deltaTime = event.tick - lastTick;
    trackEvents.push(...writeVariableLength(deltaTime));
    
    if (event.type === 'on') {
      trackEvents.push(0x90, event.pitch, event.velocity); // Note On
    } else {
      trackEvents.push(0x80, event.pitch, event.velocity); // Note Off
    }
    
    lastTick = event.tick;
  }
  
  // End of track
  trackEvents.push(0x00, 0xFF, 0x2F, 0x00);
  
  // Build track chunk
  const track = [
    0x4D, 0x54, 0x72, 0x6B, // "MTrk"
    (trackEvents.length >> 24) & 0xFF,
    (trackEvents.length >> 16) & 0xFF,
    (trackEvents.length >> 8) & 0xFF,
    trackEvents.length & 0xFF,
    ...trackEvents
  ];
  
  // Combine all chunks
  const midiData = new Uint8Array([...header, ...track]);
  console.log('Generated MIDI file:', midiData.length, 'bytes');
  return midiData;
}

function writeVariableLength(value) {
  const bytes = [];
  bytes.push(value & 0x7F);
  
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7F) | 0x80);
    value >>= 7;
  }
  
  return bytes;
}

function updateProgress(percent, text, elapsed, remaining) {
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressText').textContent = text;
  document.getElementById('progressPercent').textContent = Math.round(percent) + '%';
  
  if (elapsed !== undefined) {
    document.getElementById('progressTime').textContent = elapsed.toFixed(1) + 's';
  }
  
  if (remaining !== undefined) {
    if (remaining > 60) {
      document.getElementById('progressETA').textContent = (remaining / 60).toFixed(1) + 'm';
    } else {
      document.getElementById('progressETA').textContent = remaining.toFixed(0) + 's';
    }
  }
}

function showStatus(message, type) {
  const statusDiv = document.getElementById('statusMessage');
  statusDiv.className = 'status-message status-' + type;
  statusDiv.textContent = message;
  statusDiv.style.display = 'block';
  
  setTimeout(() => {
    statusDiv.style.display = 'none';
  }, 5000);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
function getFilterParams(){
  const minVel = Math.max(1, Math.min(127, parseInt(document.getElementById('minVelInput').value||'25')));
  const minDur = Math.max(0.001, parseFloat(document.getElementById('minDurInput').value||'0.06'));
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
