/**
 * Love Banana — Drum Machine + Synth + Sample Pads + Sample Sequencer
 * Web Audio API-based music creation suite.
 */
(function () {
    // ── Sample mapping (matches nav panel order) ──
    const SAMPLES = [
        'Sounds/Reverb LinnDrum Sample Pack_Clap.wav',
        'Sounds/Reverb LinnDrum Sample Pack_Kick Hard.wav',
        'Sounds/Reverb LinnDrum Sample Pack_Cowbell.wav',
        'Sounds/Reverb LinnDrum Sample Pack_Tambourine Hard.wav'
    ];

    const ROWS = 4;
    const COLS = 16;
    const NUM_PADS = 16;

    // ── State ──
    let grid = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    let isPlaying = false;
    let currentBeat = -1;
    let bpm = 120;
    let rowVolumes = [0.8, 0.8, 0.8, 0.8];
    let audioCtx = null;
    let rowGains = [];
    let buffers = [];
    let nextNoteTime = 0;
    let schedulerTimer = null;
    const SCHEDULE_AHEAD = 0.1;
    const SCHEDULER_INTERVAL = 25;
    let loopStartTime = 0;

    // ── Layer Recording (synth) ──
    const NUM_LAYERS = 4;
    var layers = [[], [], [], []];
    var layerWaveforms = ['sine', 'sine', 'sine', 'sine'];
    var recordingLayer = -1;
    var recordingLoopCount = 0;
    var layerMuted = [false, false, false, false];
    var scheduledLayerNodes = [];

    // ── Synth state ──
    var synthVolume = 0.6;
    var synthWaveform = 'sine';

    // ── Armed Recording ──
    var isArmed = false;
    var armedLayer = -1;

    // ── Playhead Animation ──
    var playheadRAF = null;

    // ── Sampler State ──
    var sampleBuffer = null; // full loaded AudioBuffer
    var chopBuffers = []; // 16 sliced AudioBuffer objects
    var chopBuffersReversed = []; // reversed versions
    var isReversed = false;
    var padPitch = 0; // semitones (-12 to +12)
    var padVolume = 0.8;
    var padGain = null; // GainNode for pads
    var activePadSources = []; // track playing sources for cleanup
    var sampleFileName = '';

    // ── Sample Sequencer State ──
    var sampleSeqPattern = Array(COLS).fill(-1); // -1 = empty, 0-15 = chop index

    // ── Pad Recording State ──
    var padRecording = []; // { time, padIndex } events
    var isPadRecording = false;

    // ── Mic Recording State ──
    var micStream = null;
    var micRecorder = null;
    var micChunks = [];
    var isMicRecording = false;

    // ── Initialise AudioContext ──
    function initAudio() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        for (var i = 0; i < ROWS; i++) {
            var gain = audioCtx.createGain();
            gain.gain.value = rowVolumes[i];
            gain.connect(audioCtx.destination);
            rowGains.push(gain);
        }
        // Pad gain node
        padGain = audioCtx.createGain();
        padGain.gain.value = padVolume;
        padGain.connect(audioCtx.destination);
    }

    // ── Load drum samples (Audio elements for file:// compatibility) ──
    function loadSamples() {
        SAMPLES.forEach(function (url, index) {
            var audio = new Audio(url);
            audio.preload = 'auto';
            audio.load();
            buffers[index] = audio;
        });
    }

    // Load samples immediately (Audio elements don't need AudioContext)
    loadSamples();

    // ── Play a drum sample ──
    function playSample(rowIndex, time) {
        if (!buffers[rowIndex]) return;
        // Clone the audio element for overlapping playback
        var clone = buffers[rowIndex].cloneNode();
        clone.volume = rowVolumes[rowIndex];
        if (time && audioCtx && time > audioCtx.currentTime) {
            var delay = (time - audioCtx.currentTime) * 1000;
            setTimeout(function () { clone.play(); }, delay);
        } else {
            clone.play();
        }
    }

    // ── Play a sample pad chop ──
    function playChop(padIndex, time) {
        if (padIndex < 0 || padIndex >= NUM_PADS) return;
        var bufs = isReversed ? chopBuffersReversed : chopBuffers;
        if (!bufs[padIndex]) return;
        initAudio();
        var source = audioCtx.createBufferSource();
        source.buffer = bufs[padIndex];
        source.playbackRate.value = Math.pow(2, padPitch / 12);
        source.connect(padGain);
        source.start(time || 0);
        activePadSources.push(source);
        source.onended = function () {
            var idx = activePadSources.indexOf(source);
            if (idx > -1) activePadSources.splice(idx, 1);
        };
        return source;
    }

    // ── Scheduler ──
    function scheduler() {
        while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
            currentBeat = (currentBeat + 1) % COLS;

            if (currentBeat === 0) {
                loopStartTime = nextNoteTime;

                if (recordingLayer >= 0) {
                    recordingLoopCount++;
                    if (recordingLoopCount > 1) {
                        finishRecording();
                    }
                }

                if (isPadRecording) {
                    // Pad recording also lasts one loop
                    recordingLoopCount++;
                    if (recordingLoopCount > 1) {
                        finishPadRecording();
                    }
                }

                scheduleLayerPlayback(nextNoteTime);
                schedulePadRecordingPlayback(nextNoteTime);
            }

            // Drum grid
            for (let row = 0; row < ROWS; row++) {
                if (grid[row][currentBeat]) {
                    playSample(row, nextNoteTime);
                }
            }

            // Sample sequencer
            if (sampleSeqPattern[currentBeat] >= 0) {
                playChop(sampleSeqPattern[currentBeat], nextNoteTime);
            }

            // Visual updates
            const beatToHighlight = currentBeat;
            const delay = (nextNoteTime - audioCtx.currentTime) * 1000;
            setTimeout(() => {
                highlightBeat(beatToHighlight);
                highlightSeqStep(beatToHighlight);
            }, Math.max(0, delay));

            const secondsPerBeat = 60.0 / bpm;
            nextNoteTime += secondsPerBeat;
        }
    }

    // ── Loop duration ──
    function getLoopDuration() {
        return (60.0 / bpm) * COLS;
    }

    // ── Schedule synth layer playback ──
    function scheduleLayerPlayback(loopStart) {
        scheduledLayerNodes = [];
        var loopDur = getLoopDuration();

        for (var L = 0; L < NUM_LAYERS; L++) {
            if (layers[L].length === 0) continue;
            if (layerMuted[L]) continue;

            var events = layers[L];
            var waveType = layerWaveforms[L];
            var i = 0;
            while (i < events.length) {
                var ev = events[i];
                if (ev.type === 'start' || ev.type === 'change') {
                    var noteStart = ev.time;
                    var segments = [{ time: ev.time, freq: ev.freq }];
                    var noteEnd = loopDur;
                    var j = i + 1;
                    while (j < events.length) {
                        if (events[j].type === 'stop') {
                            noteEnd = events[j].time;
                            j++;
                            break;
                        } else if (events[j].type === 'change') {
                            segments.push({ time: events[j].time, freq: events[j].freq });
                            j++;
                        } else {
                            break;
                        }
                    }

                    var absStart = loopStart + noteStart;
                    var duration = noteEnd - noteStart;
                    if (duration > 0 && absStart >= audioCtx.currentTime - 0.01) {
                        var osc = audioCtx.createOscillator();
                        var gain = audioCtx.createGain();
                        osc.type = waveType;
                        osc.frequency.value = segments[0].freq;
                        gain.gain.value = synthVolume;
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);

                        for (var s = 1; s < segments.length; s++) {
                            osc.frequency.setValueAtTime(segments[s].freq, loopStart + segments[s].time);
                        }

                        osc.start(absStart);
                        osc.stop(absStart + duration);
                        scheduledLayerNodes.push({ osc: osc, gain: gain });
                    }
                    i = j;
                } else {
                    i++;
                }
            }
        }
    }

    // ── Schedule pad recording playback ──
    function schedulePadRecordingPlayback(loopStart) {
        if (padRecording.length === 0) return;
        for (var i = 0; i < padRecording.length; i++) {
            var ev = padRecording[i];
            var absTime = loopStart + ev.time;
            if (absTime >= audioCtx.currentTime - 0.01) {
                playChop(ev.padIndex, absTime);
                // Schedule visual flash
                var delay = (absTime - audioCtx.currentTime) * 1000;
                (function (idx) {
                    setTimeout(function () { flashPad(idx); }, Math.max(0, delay));
                })(ev.padIndex);
            }
        }
    }

    function stopScheduledLayerNodes() {
        for (var n = 0; n < scheduledLayerNodes.length; n++) {
            try { scheduledLayerNodes[n].osc.stop(); } catch (e) { }
            try { scheduledLayerNodes[n].osc.disconnect(); } catch (e) { }
            try { scheduledLayerNodes[n].gain.disconnect(); } catch (e) { }
        }
        scheduledLayerNodes = [];
    }

    // ── Recording helpers (synth) ──
    function getLoopPosition() {
        if (!audioCtx || !isPlaying) return 0;
        return audioCtx.currentTime - loopStartTime;
    }

    function recordEvent(type, freq) {
        if (recordingLayer < 0) return;
        var pos = getLoopPosition();
        layers[recordingLayer].push({ time: pos, type: type, freq: freq || 0 });
    }

    function finishRecording() {
        if (recordingLayer < 0) return;
        var btn = document.querySelector('.layer-rec-btn[data-layer="' + recordingLayer + '"]');
        var slot = document.querySelector('.layer-slot[data-layer="' + recordingLayer + '"]');
        if (btn) btn.classList.remove('recording');
        if (slot) {
            slot.classList.remove('recording');
            if (layers[recordingLayer].length > 0) slot.classList.add('has-data');
        }
        recordingLayer = -1;
        updateRecBtnState();
    }

    // ── Pad recording helpers ──
    function recordPadHit(padIndex) {
        if (!isPadRecording) return;
        var pos = getLoopPosition();
        padRecording.push({ time: pos, padIndex: padIndex });
    }

    function finishPadRecording() {
        isPadRecording = false;
        updateRecBtnState();
    }

    // ── Armed Recording ──
    function armLayer(layerIdx) {
        isArmed = true;
        armedLayer = layerIdx;
        layers[layerIdx] = [];
        layerWaveforms[layerIdx] = synthWaveform;

        var btn = document.querySelector('.layer-rec-btn[data-layer="' + layerIdx + '"]');
        var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
        if (btn) btn.classList.add('recording');
        if (slot) slot.classList.remove('has-data');

        var playBtn = document.getElementById('play-btn');
        playBtn.classList.add('armed');
        playBtn.textContent = '⏺';
    }

    function disarm() {
        isArmed = false;
        armedLayer = -1;
        var playBtn = document.getElementById('play-btn');
        playBtn.classList.remove('armed');
        playBtn.textContent = '▶';
        document.querySelectorAll('.layer-rec-btn.recording').forEach(function (btn) {
            btn.classList.remove('recording');
        });
    }

    function triggerArmedRecording() {
        if (!isArmed || armedLayer < 0) return;

        var layerIdx = armedLayer;
        isArmed = false;
        armedLayer = -1;

        var playBtn = document.getElementById('play-btn');
        playBtn.classList.remove('armed');
        playBtn.textContent = '▶';

        recordingLayer = layerIdx;
        recordingLoopCount = 0;
        var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
        if (slot) slot.classList.add('recording');
        startPlayback();
    }

    // ── Playhead Animation ──
    function updatePlayheads() {
        if (!isPlaying || !audioCtx) {
            resetPlayheads();
            return;
        }

        var loopDur = getLoopDuration();
        var elapsed = audioCtx.currentTime - loopStartTime;
        var progress = Math.max(0, Math.min(1, elapsed / loopDur));
        var pct = progress * 100;

        for (var L = 0; L < NUM_LAYERS; L++) {
            var progressEl = document.querySelector('.layer-progress[data-layer="' + L + '"]');
            var playheadEl = document.querySelector('.layer-playhead[data-layer="' + L + '"]');
            if (progressEl) progressEl.style.width = pct + '%';
            if (playheadEl) playheadEl.style.left = pct + '%';
        }

        playheadRAF = requestAnimationFrame(updatePlayheads);
    }

    function startPlayheadAnimation() {
        if (playheadRAF) cancelAnimationFrame(playheadRAF);
        playheadRAF = requestAnimationFrame(updatePlayheads);
    }

    function stopPlayheadAnimation() {
        if (playheadRAF) {
            cancelAnimationFrame(playheadRAF);
            playheadRAF = null;
        }
        resetPlayheads();
    }

    function resetPlayheads() {
        for (var L = 0; L < NUM_LAYERS; L++) {
            var progressEl = document.querySelector('.layer-progress[data-layer="' + L + '"]');
            var playheadEl = document.querySelector('.layer-playhead[data-layer="' + L + '"]');
            if (progressEl) progressEl.style.width = '0%';
            if (playheadEl) playheadEl.style.left = '0';
        }
    }

    // ── Beat highlighting ──
    function highlightBeat(beat) {
        document.querySelectorAll('.step-cell.playing').forEach(cell => {
            cell.classList.remove('playing');
        });
        document.querySelectorAll(`.step-cell[data-col="${beat}"]`).forEach(cell => {
            cell.classList.add('playing');
        });
    }

    function highlightSeqStep(beat) {
        document.querySelectorAll('.seq-step.seq-playing').forEach(el => {
            el.classList.remove('seq-playing');
        });
        var step = document.querySelector('.seq-step[data-step="' + beat + '"]');
        if (step) step.classList.add('seq-playing');
    }

    function clearHighlights() {
        document.querySelectorAll('.step-cell.playing').forEach(cell => {
            cell.classList.remove('playing');
        });
        document.querySelectorAll('.seq-step.seq-playing').forEach(el => {
            el.classList.remove('seq-playing');
        });
    }

    // ── Flash pad visually ──
    function flashPad(padIndex) {
        var pad = document.querySelector('.sample-pad[data-pad="' + padIndex + '"]');
        if (!pad) return;
        pad.classList.add('pad-active');
        setTimeout(function () {
            pad.classList.remove('pad-active');
        }, 100);
    }

    // ── Start playback ──
    function startPlayback() {
        if (isPlaying) return;
        initAudio();
        isPlaying = true;
        currentBeat = -1;
        nextNoteTime = audioCtx.currentTime;
        loopStartTime = audioCtx.currentTime;
        schedulerTimer = setInterval(scheduler, SCHEDULER_INTERVAL);
        document.getElementById('play-btn').classList.add('active');
        startPlayheadAnimation();
    }

    // ── Stop playback ──
    function stopPlayback() {
        if (!isPlaying) return;
        isPlaying = false;
        clearInterval(schedulerTimer);
        schedulerTimer = null;
        currentBeat = -1;
        clearHighlights();
        document.getElementById('play-btn').classList.remove('active');
        stopPlayheadAnimation();
        stopScheduledLayerNodes();

        // Stop active pad sources
        for (var i = 0; i < activePadSources.length; i++) {
            try { activePadSources[i].stop(); } catch (e) { }
        }
        activePadSources = [];

        if (recordingLayer >= 0) finishRecording();
        if (isPadRecording) finishPadRecording();
        if (isArmed) disarm();
    }

    // ── Update rec button state ──
    function updateRecBtnState() {
        var recBtn = document.getElementById('rec-btn');
        if (!recBtn) return;
        if (recordingLayer >= 0 || isPadRecording) {
            recBtn.classList.add('recording');
            recBtn.classList.remove('armed');
        } else if (isArmed) {
            recBtn.classList.add('armed');
            recBtn.classList.remove('recording');
        } else {
            recBtn.classList.remove('recording');
            recBtn.classList.remove('armed');
        }
    }

    // ═══════════════════════════════════
    // Sample Loading + Auto-Chop
    // ═══════════════════════════════════

    function loadSampleFromBuffer(audioBuffer, name) {
        sampleBuffer = audioBuffer;
        sampleFileName = name || 'SAMPLE';
        chopSample();
        drawAllWaveforms();
        document.getElementById('sample-name').textContent = sampleFileName;

        // Mark pads as having samples
        document.querySelectorAll('.sample-pad').forEach(function (pad) {
            pad.classList.add('has-sample');
        });
    }

    function chopSample() {
        if (!sampleBuffer) return;
        chopBuffers = [];
        chopBuffersReversed = [];

        var totalSamples = sampleBuffer.length;
        var channels = sampleBuffer.numberOfChannels;
        var sampleRate = sampleBuffer.sampleRate;
        var chopLength = Math.floor(totalSamples / NUM_PADS);

        for (var i = 0; i < NUM_PADS; i++) {
            var start = i * chopLength;
            var end = Math.min(start + chopLength, totalSamples);
            var len = end - start;

            // Normal chop
            var chopBuf = audioCtx.createBuffer(channels, len, sampleRate);
            for (var ch = 0; ch < channels; ch++) {
                var srcData = sampleBuffer.getChannelData(ch);
                var destData = chopBuf.getChannelData(ch);
                for (var s = 0; s < len; s++) {
                    destData[s] = srcData[start + s];
                }
            }
            chopBuffers.push(chopBuf);

            // Reversed chop
            var revBuf = audioCtx.createBuffer(channels, len, sampleRate);
            for (var ch = 0; ch < channels; ch++) {
                var srcData = sampleBuffer.getChannelData(ch);
                var destData = revBuf.getChannelData(ch);
                for (var s = 0; s < len; s++) {
                    destData[s] = srcData[end - 1 - s];
                }
            }
            chopBuffersReversed.push(revBuf);
        }
    }

    function drawAllWaveforms() {
        var pads = document.querySelectorAll('.sample-pad');
        pads.forEach(function (pad) {
            var idx = parseInt(pad.dataset.pad);
            var canvas = pad.querySelector('.pad-waveform');
            if (canvas && chopBuffers[idx]) {
                drawWaveform(canvas, chopBuffers[idx]);
            }
        });
    }

    function drawWaveform(canvas, buffer) {
        var ctx = canvas.getContext('2d');
        var w = canvas.width;
        var h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        var data = buffer.getChannelData(0);
        var step = Math.ceil(data.length / w);

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (var x = 0; x < w; x++) {
            var min = 1, max = -1;
            var start = x * step;
            for (var j = 0; j < step && start + j < data.length; j++) {
                var val = data[start + j];
                if (val < min) min = val;
                if (val > max) max = val;
            }
            var yLow = ((1 + min) / 2) * h;
            var yHigh = ((1 + max) / 2) * h;
            ctx.moveTo(x, yLow);
            ctx.lineTo(x, yHigh);
        }
        ctx.stroke();
    }

    function clearSample() {
        sampleBuffer = null;
        chopBuffers = [];
        chopBuffersReversed = [];
        sampleFileName = '';
        padRecording = [];
        sampleSeqPattern = Array(COLS).fill(-1);

        document.getElementById('sample-name').textContent = 'NO SAMPLE LOADED';

        // Clear pad visuals
        document.querySelectorAll('.sample-pad').forEach(function (pad) {
            pad.classList.remove('has-sample');
            var canvas = pad.querySelector('.pad-waveform');
            if (canvas) {
                var ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        });

        // Clear sequencer visuals
        updateSeqUI();
    }

    // ═══════════════════════════════════
    // Mic Recording
    // ═══════════════════════════════════

    async function startMicRecording() {
        try {
            initAudio();
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micRecorder = new MediaRecorder(micStream);
            micChunks = [];

            micRecorder.ondataavailable = function (e) {
                if (e.data.size > 0) micChunks.push(e.data);
            };

            micRecorder.onstop = async function () {
                var blob = new Blob(micChunks, { type: 'audio/webm' });
                var arrayBuf = await blob.arrayBuffer();
                var audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
                loadSampleFromBuffer(audioBuffer, 'MIC REC');

                // Clean up mic stream
                if (micStream) {
                    micStream.getTracks().forEach(t => t.stop());
                    micStream = null;
                }
            };

            micRecorder.start();
            isMicRecording = true;

            var micBtn = document.getElementById('mic-sample-btn');
            if (micBtn) {
                micBtn.textContent = '■ STOP';
                micBtn.classList.add('armed');
            }
        } catch (err) {
            console.warn('Mic access denied:', err);
        }
    }

    function stopMicRecording() {
        if (micRecorder && micRecorder.state !== 'inactive') {
            micRecorder.stop();
        }
        isMicRecording = false;

        var micBtn = document.getElementById('mic-sample-btn');
        if (micBtn) {
            micBtn.textContent = '🎤 REC';
            micBtn.classList.remove('armed');
        }
    }

    // ═══════════════════════════════════
    // Sample Sequencer UI
    // ═══════════════════════════════════

    function updateSeqUI() {
        document.querySelectorAll('.seq-step').forEach(function (step) {
            var idx = parseInt(step.dataset.step);
            var label = step.querySelector('.seq-chop-label');
            if (sampleSeqPattern[idx] >= 0) {
                label.textContent = (sampleSeqPattern[idx] + 1).toString();
                step.classList.add('has-chop');
            } else {
                label.textContent = '—';
                step.classList.remove('has-chop');
            }
        });
    }

    // ═══════════════════════════════════
    // WAV Export (Save Loop)
    // ═══════════════════════════════════

    async function exportWAV() {
        if (!audioCtx) {
            initAudio();
            await new Promise(r => setTimeout(r, 500)); // let samples load
        }

        var loopDur = getLoopDuration();
        // Calculate how many loops fit in ~30 seconds
        var numLoops = Math.max(1, Math.round(30 / loopDur));
        var totalDuration = loopDur * numLoops;
        var sampleRate = audioCtx.sampleRate;
        var totalFrames = Math.ceil(totalDuration * sampleRate);

        var offlineCtx = new OfflineAudioContext(2, totalFrames, sampleRate);

        // Note: Drums use Audio elements (for file:// compat) so they
        // cannot be rendered into OfflineAudioContext. Synth/pads/seq still export.
        for (var loop = 0; loop < numLoops; loop++) {
            var loopOffset = loop * loopDur;
            for (var beat = 0; beat < COLS; beat++) {
                var beatTime = loopOffset + beat * (60.0 / bpm);
                // Sample sequencer
                if (sampleSeqPattern[beat] >= 0) {
                    var bufs = isReversed ? chopBuffersReversed : chopBuffers;
                    var chopIdx = sampleSeqPattern[beat];
                    if (bufs[chopIdx]) {
                        var src = offlineCtx.createBufferSource();
                        src.buffer = bufs[chopIdx];
                        src.playbackRate.value = Math.pow(2, padPitch / 12);
                        var g = offlineCtx.createGain();
                        g.gain.value = padVolume;
                        src.connect(g);
                        g.connect(offlineCtx.destination);
                        src.start(beatTime);
                    }
                }
            }
        }

        // Render synth layers
        for (var L = 0; L < NUM_LAYERS; L++) {
            if (layers[L].length === 0 || layerMuted[L]) continue;
            for (var loop = 0; loop < numLoops; loop++) {
                var loopOffset = loop * loopDur;
                var events = layers[L];
                var waveType = layerWaveforms[L];
                var i = 0;
                while (i < events.length) {
                    var ev = events[i];
                    if (ev.type === 'start' || ev.type === 'change') {
                        var noteStart = ev.time;
                        var segments = [{ time: ev.time, freq: ev.freq }];
                        var noteEnd = loopDur;
                        var j = i + 1;
                        while (j < events.length) {
                            if (events[j].type === 'stop') { noteEnd = events[j].time; j++; break; }
                            else if (events[j].type === 'change') { segments.push({ time: events[j].time, freq: events[j].freq }); j++; }
                            else break;
                        }
                        var absStart = loopOffset + noteStart;
                        var duration = noteEnd - noteStart;
                        if (duration > 0) {
                            var osc = offlineCtx.createOscillator();
                            var gain = offlineCtx.createGain();
                            osc.type = waveType;
                            osc.frequency.value = segments[0].freq;
                            gain.gain.value = synthVolume;
                            osc.connect(gain);
                            gain.connect(offlineCtx.destination);
                            for (var s = 1; s < segments.length; s++) {
                                osc.frequency.setValueAtTime(segments[s].freq, loopOffset + segments[s].time);
                            }
                            osc.start(absStart);
                            osc.stop(absStart + duration);
                        }
                        i = j;
                    } else { i++; }
                }
            }
        }

        // Render pad recording
        if (padRecording.length > 0) {
            for (var loop = 0; loop < numLoops; loop++) {
                var loopOffset = loop * loopDur;
                for (var p = 0; p < padRecording.length; p++) {
                    var ev = padRecording[p];
                    var bufs = isReversed ? chopBuffersReversed : chopBuffers;
                    if (bufs[ev.padIndex]) {
                        var src = offlineCtx.createBufferSource();
                        src.buffer = bufs[ev.padIndex];
                        src.playbackRate.value = Math.pow(2, padPitch / 12);
                        var g = offlineCtx.createGain();
                        g.gain.value = padVolume;
                        src.connect(g);
                        g.connect(offlineCtx.destination);
                        src.start(loopOffset + ev.time);
                    }
                }
            }
        }

        // Render
        var renderedBuffer = await offlineCtx.startRendering();

        // Encode to WAV
        var wavBlob = encodeWAV(renderedBuffer);
        var url = URL.createObjectURL(wavBlob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'love-banana-loop.wav';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function encodeWAV(buffer) {
        var numChannels = buffer.numberOfChannels;
        var sampleRate = buffer.sampleRate;
        var format = 1; // PCM
        var bitsPerSample = 16;
        var bytesPerSample = bitsPerSample / 8;
        var blockAlign = numChannels * bytesPerSample;
        var byteRate = sampleRate * blockAlign;
        var dataLength = buffer.length * blockAlign;
        var headerLength = 44;
        var totalLength = headerLength + dataLength;

        var arrayBuffer = new ArrayBuffer(totalLength);
        var view = new DataView(arrayBuffer);

        // WAV Header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, totalLength - 8, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        // Interleave channels
        var channels = [];
        for (var ch = 0; ch < numChannels; ch++) {
            channels.push(buffer.getChannelData(ch));
        }

        var offset = 44;
        for (var i = 0; i < buffer.length; i++) {
            for (var ch = 0; ch < numChannels; ch++) {
                var sample = Math.max(-1, Math.min(1, channels[ch][i]));
                sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(offset, sample, true);
                offset += 2;
            }
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    function writeString(view, offset, string) {
        for (var i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    // ═══════════════════════════════════
    // DOM Ready
    // ═══════════════════════════════════
    document.addEventListener('DOMContentLoaded', function () {
        const cells = document.querySelectorAll('.step-cell');
        const playBtn = document.getElementById('play-btn');
        const stopBtn = document.getElementById('stop-btn');
        const recBtn = document.getElementById('rec-btn');
        const saveBtn = document.getElementById('save-btn');
        const bpmSlider = document.getElementById('bpm-slider');
        const bpmDisplay = document.getElementById('bpm-display');

        // ── Drum Grid — Drag to fill ──
        var dragActive = false;
        var dragRow = -1;
        var dragState = false; // true = turning on, false = turning off
        var dragVisited = {};  // track which cells we've already toggled

        function applyDragToCell(cell) {
            var row = parseInt(cell.dataset.row);
            var col = parseInt(cell.dataset.col);
            var img = cell.dataset.img;
            var key = row + '_' + col;

            // Only affect cells in the same row and not already visited
            if (row !== dragRow || dragVisited[key]) return;
            dragVisited[key] = true;

            grid[row][col] = dragState;
            if (dragState) {
                cell.classList.add('active');
                if (img) cell.style.backgroundImage = 'url(' + img + ')';
                if (audioCtx && buffers[row]) playSample(row, 0);
            } else {
                cell.classList.remove('active');
                cell.style.backgroundImage = '';
            }
        }

        function getCellFromPoint(x, y) {
            var el = document.elementFromPoint(x, y);
            if (el && el.classList.contains('step-cell')) return el;
            return null;
        }

        cells.forEach(function (cell) {
            // Prevent default touch scrolling on cells
            cell.style.touchAction = 'none';

            cell.addEventListener('mousedown', function (e) {
                e.preventDefault();
                initAudio();
                var row = parseInt(this.dataset.row);
                var col = parseInt(this.dataset.col);
                dragActive = true;
                dragRow = row;
                dragState = !grid[row][col]; // toggle: if off turn on, if on turn off
                dragVisited = {};
                applyDragToCell(this);
            });

            cell.addEventListener('touchstart', function (e) {
                e.preventDefault();
                initAudio();
                var row = parseInt(this.dataset.row);
                var col = parseInt(this.dataset.col);
                dragActive = true;
                dragRow = row;
                dragState = !grid[row][col];
                dragVisited = {};
                applyDragToCell(this);
            }, { passive: false });
        });

        // Mouse drag across cells
        document.addEventListener('mousemove', function (e) {
            if (!dragActive) return;
            var cell = getCellFromPoint(e.clientX, e.clientY);
            if (cell) applyDragToCell(cell);
        });

        // Touch drag across cells
        document.addEventListener('touchmove', function (e) {
            if (!dragActive) return;
            e.preventDefault();
            var touch = e.touches[0];
            var cell = getCellFromPoint(touch.clientX, touch.clientY);
            if (cell) applyDragToCell(cell);
        }, { passive: false });

        // End drag
        document.addEventListener('mouseup', function () { dragActive = false; });
        document.addEventListener('touchend', function () { dragActive = false; });

        // ── Global Transport ──
        playBtn.addEventListener('click', function () {
            if (isArmed) {
                triggerArmedRecording();
                return;
            }
            startPlayback();
        });
        stopBtn.addEventListener('click', stopPlayback);

        // Global rec button
        recBtn.addEventListener('click', function () {
            initAudio();
            // If already recording, stop
            if (recordingLayer >= 0) {
                finishRecording();
                return;
            }
            if (isPadRecording) {
                finishPadRecording();
                return;
            }

            // Determine current page to decide what to record
            var currentPage = getCurrentPage();

            if (currentPage === 0 || currentPage === 1) {
                // Synth recording — find first empty layer or layer 0
                var targetLayer = 0;
                for (var i = 0; i < NUM_LAYERS; i++) {
                    if (layers[i].length === 0) { targetLayer = i; break; }
                }

                if (isPlaying) {
                    recordingLayer = targetLayer;
                    recordingLoopCount = 0;
                    layers[targetLayer] = [];
                    layerWaveforms[targetLayer] = synthWaveform;
                    var btn = document.querySelector('.layer-rec-btn[data-layer="' + targetLayer + '"]');
                    var slot = document.querySelector('.layer-slot[data-layer="' + targetLayer + '"]');
                    if (btn) btn.classList.add('recording');
                    if (slot) {
                        slot.classList.remove('has-data');
                        slot.classList.add('recording');
                    }
                } else {
                    armLayer(targetLayer);
                }
            } else if (currentPage === 2) {
                // Pad recording
                if (!isPlaying) startPlayback();
                isPadRecording = true;
                padRecording = [];
                recordingLoopCount = 0;
            }

            updateRecBtnState();
        });

        // Save button
        saveBtn.addEventListener('click', function () {
            exportWAV();
        });

        // BPM slider
        bpmSlider.addEventListener('input', function () {
            bpm = parseInt(this.value);
            bpmDisplay.textContent = bpm;
        });

        // Per-row volume
        document.querySelectorAll('.vol-input[data-row]').forEach(function (input) {
            input.addEventListener('change', function () {
                var row = parseInt(this.dataset.row);
                if (isNaN(row)) return;
                var val = Math.max(0, Math.min(100, parseInt(this.value) || 0));
                this.value = val;
                rowVolumes[row] = val / 100;
                if (rowGains[row]) rowGains[row].gain.value = rowVolumes[row];
            });
        });

        // ═══════════════════════════════════
        // Synth (Stylophone)
        // ═══════════════════════════════════
        var synthOsc = null;
        var synthGain = null;
        var isSynthDragging = false;
        var activeKey = null;

        var waveSelect = document.getElementById('wave-select');
        var synthVolInput = document.getElementById('synth-vol');
        var pianoKeys = document.querySelectorAll('.piano-key');

        waveSelect.addEventListener('change', function () {
            synthWaveform = this.value;
            if (synthOsc) synthOsc.type = synthWaveform;
        });

        synthVolInput.addEventListener('change', function () {
            var val = Math.max(0, Math.min(100, parseInt(this.value) || 0));
            this.value = val;
            synthVolume = val / 100;
            if (synthGain) synthGain.gain.value = synthVolume;
        });

        function startNote(freq) {
            initAudio();
            if (isArmed) triggerArmedRecording();
            if (synthOsc) stopNote();

            synthGain = audioCtx.createGain();
            synthGain.gain.value = synthVolume;
            synthGain.connect(audioCtx.destination);

            synthOsc = audioCtx.createOscillator();
            synthOsc.type = synthWaveform;
            synthOsc.frequency.value = freq;
            synthOsc.connect(synthGain);
            synthOsc.start();

            recordEvent('start', freq);
        }

        function changeNote(freq) {
            if (synthOsc) synthOsc.frequency.value = freq;
            recordEvent('change', freq);
        }

        function stopNote() {
            var wasPlaying = !!synthOsc;
            if (synthOsc) {
                try { synthOsc.stop(); } catch (e) { }
                synthOsc.disconnect();
                synthOsc = null;
            }
            if (synthGain) {
                synthGain.disconnect();
                synthGain = null;
            }
            if (activeKey) {
                activeKey.classList.remove('key-active');
                activeKey = null;
            }
            if (wasPlaying) recordEvent('stop', 0);
        }

        function activateKey(key) {
            var freq = parseFloat(key.dataset.freq);
            if (activeKey === key) return;
            if (activeKey) activeKey.classList.remove('key-active');
            key.classList.add('key-active');
            activeKey = key;

            if (!synthOsc) { startNote(freq); }
            else { changeNote(freq); }
        }

        function getKeyAtPoint(x, y) {
            var el = document.elementFromPoint(x, y);
            if (el && el.classList.contains('piano-key')) return el;
            return null;
        }

        // Mouse events
        pianoKeys.forEach(function (key) {
            key.addEventListener('mousedown', function (e) {
                e.preventDefault();
                isSynthDragging = true;
                activateKey(this);
            });
            key.addEventListener('mouseenter', function () {
                if (isSynthDragging) activateKey(this);
            });
        });

        document.addEventListener('mouseup', function () {
            if (isSynthDragging) {
                isSynthDragging = false;
                stopNote();
            }
        });

        // Touch events (mobile)
        var pianoContainer = document.getElementById('piano-keys');
        if (pianoContainer) {
            pianoContainer.addEventListener('touchstart', function (e) {
                e.preventDefault();
                isSynthDragging = true;
                var touch = e.touches[0];
                var key = getKeyAtPoint(touch.clientX, touch.clientY);
                if (key) activateKey(key);
            }, { passive: false });

            pianoContainer.addEventListener('touchmove', function (e) {
                e.preventDefault();
                if (!isSynthDragging) return;
                var touch = e.touches[0];
                var key = getKeyAtPoint(touch.clientX, touch.clientY);
                if (key) activateKey(key);
            }, { passive: false });

            pianoContainer.addEventListener('touchend', function () {
                isSynthDragging = false;
                stopNote();
            });

            pianoContainer.addEventListener('touchcancel', function () {
                isSynthDragging = false;
                stopNote();
            });
        }

        // ═══════════════════════════════════
        // Layer Controls
        // ═══════════════════════════════════
        document.querySelectorAll('.layer-rec-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var layerIdx = parseInt(this.dataset.layer);

                if (isArmed && armedLayer === layerIdx) { disarm(); return; }
                if (isArmed) disarm();
                if (recordingLayer === layerIdx) { finishRecording(); return; }
                if (recordingLayer >= 0) finishRecording();

                if (isPlaying) {
                    recordingLayer = layerIdx;
                    recordingLoopCount = 0;
                    layers[layerIdx] = [];
                    layerWaveforms[layerIdx] = synthWaveform;
                    this.classList.add('recording');
                    var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
                    if (slot) {
                        slot.classList.remove('has-data');
                        slot.classList.add('recording');
                    }
                } else {
                    armLayer(layerIdx);
                }
                updateRecBtnState();
            });
        });

        document.querySelectorAll('.layer-clear-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var layerIdx = parseInt(this.dataset.layer);
                if (isArmed && armedLayer === layerIdx) disarm();
                if (recordingLayer === layerIdx) finishRecording();
                layers[layerIdx] = [];
                var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
                if (slot) {
                    slot.classList.remove('has-data');
                    slot.classList.remove('recording');
                }
            });
        });

        document.querySelectorAll('.layer-mute-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var layerIdx = parseInt(this.dataset.layer);
                layerMuted[layerIdx] = !layerMuted[layerIdx];
                this.classList.toggle('muted', layerMuted[layerIdx]);
            });
        });

        // ═══════════════════════════════════
        // Sample Pads
        // ═══════════════════════════════════

        // Load sample button
        document.getElementById('load-sample-btn').addEventListener('click', function () {
            document.getElementById('sample-file-input').click();
        });

        document.getElementById('sample-file-input').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) return;
            initAudio();

            var reader = new FileReader();
            reader.onload = function (ev) {
                audioCtx.decodeAudioData(ev.target.result, function (buffer) {
                    loadSampleFromBuffer(buffer, file.name.replace(/\.[^.]+$/, '').toUpperCase());
                });
            };
            reader.readAsArrayBuffer(file);
            this.value = ''; // reset so same file can be re-selected
        });

        // Mic recording button
        document.getElementById('mic-sample-btn').addEventListener('click', function () {
            if (isMicRecording) {
                stopMicRecording();
            } else {
                startMicRecording();
            }
        });

        // Clear sample button
        document.getElementById('clear-sample-btn').addEventListener('click', clearSample);

        // Reverse toggle
        document.getElementById('reverse-toggle').addEventListener('click', function () {
            isReversed = !isReversed;
            this.classList.toggle('active', isReversed);
        });

        // Pitch slider
        var pitchSlider = document.getElementById('pad-pitch');
        var pitchDisplay = document.getElementById('pad-pitch-display');
        pitchSlider.addEventListener('input', function () {
            padPitch = parseInt(this.value);
            pitchDisplay.textContent = (padPitch > 0 ? '+' : '') + padPitch;
        });

        // Pad volume
        document.getElementById('pad-vol').addEventListener('change', function () {
            var val = Math.max(0, Math.min(100, parseInt(this.value) || 0));
            this.value = val;
            padVolume = val / 100;
            if (padGain) padGain.gain.value = padVolume;
        });

        // Pad touch/click events
        var padGrid = document.getElementById('pad-grid');

        padGrid.addEventListener('mousedown', function (e) {
            var pad = e.target.closest('.sample-pad');
            if (!pad) return;
            e.preventDefault();
            triggerPad(parseInt(pad.dataset.pad));
        });

        padGrid.addEventListener('touchstart', function (e) {
            var pad = e.target.closest('.sample-pad');
            if (!pad) return;
            e.preventDefault();
            triggerPad(parseInt(pad.dataset.pad));
        }, { passive: false });

        function triggerPad(padIndex) {
            if (chopBuffers.length === 0) return;
            playChop(padIndex, 0);
            flashPad(padIndex);

            // Record pad hit if recording
            if (isPadRecording && isPlaying) {
                recordPadHit(padIndex);
            }
        }

        // ═══════════════════════════════════
        // Sample Sequencer — Swipe-to-select
        // ═══════════════════════════════════

        var lastChosenChop = 1;   // remember last selection (1-indexed, 1-16)
        var swipeActive = false;
        var swipeStepIndex = -1;
        var swipeStartY = 0;
        var swipeCurrentChop = 1;
        var swipeMoved = false;
        var SWIPE_SENSITIVITY = 20; // pixels per chop increment

        document.querySelectorAll('.seq-step').forEach(function (step) {
            step.addEventListener('mousedown', function (e) {
                e.preventDefault();
                beginSwipe(parseInt(this.dataset.step), e.clientY);
            });

            step.addEventListener('touchstart', function (e) {
                e.preventDefault();
                var touch = e.touches[0];
                beginSwipe(parseInt(this.dataset.step), touch.clientY);
            }, { passive: false });
        });

        function beginSwipe(stepIndex, startY) {
            swipeActive = true;
            swipeStepIndex = stepIndex;
            swipeStartY = startY;
            swipeMoved = false;

            // Start from last chosen chop (or current chop if step already has one)
            if (sampleSeqPattern[stepIndex] >= 0) {
                swipeCurrentChop = sampleSeqPattern[stepIndex] + 1;
            } else {
                swipeCurrentChop = lastChosenChop;
            }

            // Show current chop on the step immediately
            var stepEl = document.querySelector('.seq-step[data-step="' + stepIndex + '"]');
            if (stepEl) {
                var label = stepEl.querySelector('.seq-chop-label');
                label.textContent = swipeCurrentChop.toString();
                stepEl.classList.add('has-chop', 'seq-swiping');
            }

            // Preview the chop sound
            if (chopBuffers[swipeCurrentChop - 1]) {
                playChop(swipeCurrentChop - 1, 0);
            }

            // Add move and end listeners
            document.addEventListener('mousemove', onSwipeMove);
            document.addEventListener('mouseup', onSwipeEnd);
            document.addEventListener('touchmove', onSwipeMove, { passive: false });
            document.addEventListener('touchend', onSwipeEnd);
        }

        function onSwipeMove(e) {
            if (!swipeActive) return;
            e.preventDefault();
            swipeMoved = true;

            var clientY;
            if (e.touches) {
                clientY = e.touches[0].clientY;
            } else {
                clientY = e.clientY;
            }

            // Calculate how many chops to shift (up = higher number)
            var deltaY = swipeStartY - clientY;
            var chopDelta = Math.round(deltaY / SWIPE_SENSITIVITY);
            var startChop = (sampleSeqPattern[swipeStepIndex] >= 0)
                ? sampleSeqPattern[swipeStepIndex] + 1
                : lastChosenChop;
            var newChop = startChop + chopDelta;

            // Clamp 1-16
            newChop = Math.max(1, Math.min(16, newChop));

            if (newChop !== swipeCurrentChop) {
                swipeCurrentChop = newChop;

                // Update label
                var stepEl = document.querySelector('.seq-step[data-step="' + swipeStepIndex + '"]');
                if (stepEl) {
                    stepEl.querySelector('.seq-chop-label').textContent = swipeCurrentChop.toString();
                }

                // Preview the chop sound
                if (chopBuffers[swipeCurrentChop - 1]) {
                    playChop(swipeCurrentChop - 1, 0);
                }
            }
        }

        function onSwipeEnd(e) {
            if (!swipeActive) return;
            swipeActive = false;

            var stepEl = document.querySelector('.seq-step[data-step="' + swipeStepIndex + '"]');
            if (stepEl) stepEl.classList.remove('seq-swiping');

            if (!swipeMoved) {
                // Quick tap: if step already has a chop, remove it; otherwise assign current
                if (sampleSeqPattern[swipeStepIndex] >= 0) {
                    sampleSeqPattern[swipeStepIndex] = -1;
                } else {
                    sampleSeqPattern[swipeStepIndex] = swipeCurrentChop - 1;
                    lastChosenChop = swipeCurrentChop;
                }
            } else {
                // Swipe completed: assign the chosen chop
                sampleSeqPattern[swipeStepIndex] = swipeCurrentChop - 1;
                lastChosenChop = swipeCurrentChop;
            }

            updateSeqUI();

            // Cleanup listeners
            document.removeEventListener('mousemove', onSwipeMove);
            document.removeEventListener('mouseup', onSwipeEnd);
            document.removeEventListener('touchmove', onSwipeMove);
            document.removeEventListener('touchend', onSwipeEnd);
        }

        // Clear drums button
        document.getElementById('clear-drums-btn').addEventListener('click', function () {
            grid = Array.from({ length: ROWS }, function () { return Array(COLS).fill(false); });
            document.querySelectorAll('.step-cell').forEach(function (cell) {
                cell.classList.remove('active');
                cell.style.backgroundImage = '';
            });
        });

        // Clear sequencer button
        document.getElementById('clear-seq-btn').addEventListener('click', function () {
            sampleSeqPattern = Array(COLS).fill(-1);
            updateSeqUI();
        });

        // ═══════════════════════════════════
        // Tab Navigation & Page Switching
        // ═══════════════════════════════════

        var pagesContainer = document.querySelector('.dm-pages-container');
        var pageDots = document.querySelectorAll('.dm-dot');
        var tabs = document.querySelectorAll('.dm-tab');
        var pages = document.querySelectorAll('.dm-page');

        function isLandscapeMode() {
            if (!pagesContainer) return false;
            var style = getComputedStyle(pagesContainer);
            return style.flexDirection === 'row';
        }

        function switchToPage(pageIndex) {
            // Update tabs
            tabs.forEach(function (tab, i) {
                tab.classList.toggle('active', i === pageIndex);
            });

            // Update dots
            pageDots.forEach(function (dot, i) {
                dot.classList.toggle('active', i === pageIndex);
            });

            if (isLandscapeMode()) {
                // Landscape: scroll to page
                if (pagesContainer.scrollTo) {
                    pagesContainer.scrollTo({
                        left: pageIndex * pagesContainer.offsetWidth,
                        behavior: 'smooth'
                    });
                }
            } else {
                // Desktop/portrait: toggle active class
                pages.forEach(function (page, i) {
                    page.classList.toggle('active', i === pageIndex);
                });
            }
        }

        function getCurrentPage() {
            if (isLandscapeMode()) {
                var scrollLeft = pagesContainer.scrollLeft;
                var pageWidth = pagesContainer.offsetWidth;
                return Math.round(scrollLeft / pageWidth);
            }
            // Desktop: check which tab is active
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].classList.contains('active')) return i;
            }
            return 0;
        }

        // Tab clicks
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var pageIndex = parseInt(this.dataset.page);
                switchToPage(pageIndex);
            });
        });

        // Dot clicks
        pageDots.forEach(function (dot) {
            dot.addEventListener('click', function () {
                var pageIndex = parseInt(this.dataset.page);
                switchToPage(pageIndex);
            });
        });

        // Sync tabs with swipe scroll in landscape
        if (pagesContainer) {
            pagesContainer.addEventListener('scroll', function () {
                if (!isLandscapeMode()) return;
                var currentPage = getCurrentPage();
                tabs.forEach(function (tab, i) {
                    tab.classList.toggle('active', i === currentPage);
                });
                pageDots.forEach(function (dot, i) {
                    dot.classList.toggle('active', i === currentPage);
                });
            });
        }
    });
})();
