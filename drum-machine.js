/**
 * Love Banana — Secret Drum Machine (Step Sequencer)
 * Web Audio API-based 4×8 step sequencer using LinnDrum samples.
 */
(function () {
    // ── Sample mapping (matches nav panel order) ──
    const SAMPLES = [
        'Sounds/Reverb LinnDrum Sample Pack_Clap.wav',        // Row 0: Merch
        'Sounds/Reverb LinnDrum Sample Pack_Kick Hard.wav',    // Row 1: Shows
        'Sounds/Reverb LinnDrum Sample Pack_Cowbell.wav',      // Row 2: Links
        'Sounds/Reverb LinnDrum Sample Pack_Tambourine Hard.wav' // Row 3: Gallery
    ];

    const ROWS = 4;
    const COLS = 16;

    // ── State ──
    let grid = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    let isPlaying = false;
    let currentBeat = -1;
    let bpm = 120;
    let rowVolumes = [0.8, 0.8, 0.8, 0.8]; // per-row volume (0–1)
    let audioCtx = null;
    let rowGains = []; // per-row GainNodes
    let buffers = []; // decoded AudioBuffers
    let nextNoteTime = 0;
    let schedulerTimer = null;
    const SCHEDULE_AHEAD = 0.1; // seconds to look ahead
    const SCHEDULER_INTERVAL = 25; // ms between scheduler calls
    let loopStartTime = 0; // audioCtx time when current loop started

    // ── Layer Recording ──
    const NUM_LAYERS = 4;
    var layers = [[], [], [], []]; // recorded events per layer
    var layerWaveforms = ['sine', 'sine', 'sine', 'sine']; // waveform used when recording
    var recordingLayer = -1; // which layer is currently recording (-1 = none)
    var recordingLoopCount = 0; // how many beat-0 firings since recording started
    var layerPlaybackNodes = []; // active oscillator nodes for layer playback
    var layerMuted = [false, false, false, false]; // per-layer mute state
    var scheduledLayerNodes = []; // {osc, gain} of currently scheduled layer playback

    // ── Synth state (shared between synth UI and playback) ──
    var synthVolume = 0.6;
    var synthWaveform = 'sine';

    // ── Armed Recording ──
    var isArmed = false; // true = waiting for first synth touch to start
    var armedLayer = -1; // which layer is armed

    // ── Playhead Animation ──
    var playheadRAF = null; // requestAnimationFrame ID

    // ── Initialise AudioContext (must be triggered by user gesture) ──
    function initAudio() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // Create a GainNode per row
        for (var i = 0; i < ROWS; i++) {
            var gain = audioCtx.createGain();
            gain.gain.value = rowVolumes[i];
            gain.connect(audioCtx.destination);
            rowGains.push(gain);
        }
        loadSamples();
    }

    // ── Load all WAV samples ──
    async function loadSamples() {
        buffers = await Promise.all(
            SAMPLES.map(async (url) => {
                const response = await fetch(url);
                const arrayBuf = await response.arrayBuffer();
                return audioCtx.decodeAudioData(arrayBuf);
            })
        );
    }

    // ── Play a single sample ──
    function playSample(rowIndex, time) {
        if (!buffers[rowIndex]) return;
        const source = audioCtx.createBufferSource();
        source.buffer = buffers[rowIndex];
        source.connect(rowGains[rowIndex]);
        source.start(time);
    }

    // ── Scheduler: runs ahead of time to schedule notes precisely ──
    function scheduler() {
        while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
            // Advance beat
            currentBeat = (currentBeat + 1) % COLS;

            // If beat wrapped to 0, a new loop starts
            if (currentBeat === 0) {
                loopStartTime = nextNoteTime;

                // If recording, check if we've completed a full loop
                if (recordingLayer >= 0) {
                    recordingLoopCount++;
                    if (recordingLoopCount > 1) {
                        // We've been through a full loop — stop recording
                        finishRecording();
                    }
                }

                // Schedule playback of all recorded layers
                scheduleLayerPlayback(nextNoteTime);
            }

            // Schedule sounds for this beat
            for (let row = 0; row < ROWS; row++) {
                if (grid[row][currentBeat]) {
                    playSample(row, nextNoteTime);
                }
            }

            // Schedule visual update
            const beatToHighlight = currentBeat;
            const delay = (nextNoteTime - audioCtx.currentTime) * 1000;
            setTimeout(() => highlightBeat(beatToHighlight), Math.max(0, delay));

            // Advance time
            const secondsPerBeat = 60.0 / bpm;
            nextNoteTime += secondsPerBeat;
        }
    }

    // ── Get full loop duration in seconds ──
    function getLoopDuration() {
        return (60.0 / bpm) * COLS;
    }

    // ── Schedule playback of all recorded layers for one loop ──
    function scheduleLayerPlayback(loopStart) {
        // Let previous loop's oscillators finish naturally (they have scheduled stop times).
        // Just reset the tracking array — only track current loop's nodes for cleanup on STOP.
        scheduledLayerNodes = [];

        var loopDur = getLoopDuration();

        for (var L = 0; L < NUM_LAYERS; L++) {
            if (layers[L].length === 0) continue;
            if (layerMuted[L]) continue; // skip muted layers

            var events = layers[L];
            var waveType = layerWaveforms[L];

            // Group events into note segments (start → freq changes → stop)
            var i = 0;
            while (i < events.length) {
                var ev = events[i];
                if (ev.type === 'start' || ev.type === 'change') {
                    // Find the end of this note segment
                    var noteStart = ev.time;
                    var segments = [{ time: ev.time, freq: ev.freq }];
                    var noteEnd = loopDur; // default: sustain to end of loop
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

                    // Schedule this note
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

                        // Schedule frequency changes
                        for (var s = 1; s < segments.length; s++) {
                            osc.frequency.setValueAtTime(
                                segments[s].freq,
                                loopStart + segments[s].time
                            );
                        }

                        osc.start(absStart);
                        osc.stop(absStart + duration);

                        // Track for cleanup on stop
                        scheduledLayerNodes.push({ osc: osc, gain: gain });
                    }

                    i = j;
                } else {
                    i++;
                }
            }
        }
    }

    // ── Stop all scheduled layer oscillators ──
    function stopScheduledLayerNodes() {
        for (var n = 0; n < scheduledLayerNodes.length; n++) {
            try { scheduledLayerNodes[n].osc.stop(); } catch (e) { }
            try { scheduledLayerNodes[n].osc.disconnect(); } catch (e) { }
            try { scheduledLayerNodes[n].gain.disconnect(); } catch (e) { }
        }
        scheduledLayerNodes = [];
    }

    // ── Recording helpers ──
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
    }

    // ── Armed Recording ──
    function armLayer(layerIdx) {
        // Set armed state
        isArmed = true;
        armedLayer = layerIdx;

        // Clear previous data on this layer
        layers[layerIdx] = [];
        layerWaveforms[layerIdx] = synthWaveform;

        // Visual: rec button pulses, slot loses has-data
        var btn = document.querySelector('.layer-rec-btn[data-layer="' + layerIdx + '"]');
        var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
        if (btn) btn.classList.add('recording');
        if (slot) slot.classList.remove('has-data');

        // Visual: play button turns red and says RECORD
        var playBtn = document.getElementById('play-btn');
        playBtn.classList.add('armed');
        playBtn.textContent = '⏺ RECORD';
    }

    function disarm() {
        isArmed = false;
        armedLayer = -1;
        // Reset play button
        var playBtn = document.getElementById('play-btn');
        playBtn.classList.remove('armed');
        playBtn.textContent = '▶ PLAY';
        // Remove any recording highlights from rec buttons
        document.querySelectorAll('.layer-rec-btn.recording').forEach(function (btn) {
            btn.classList.remove('recording');
        });
    }

    function triggerArmedRecording() {
        if (!isArmed || armedLayer < 0) return;

        var layerIdx = armedLayer;
        isArmed = false;
        armedLayer = -1;

        // Reset play button visuals
        var playBtn = document.getElementById('play-btn');
        playBtn.classList.remove('armed');
        playBtn.textContent = '▶ PLAY';

        // Start playback
        recordingLayer = layerIdx;
        recordingLoopCount = 0; // reset loop counter for armed recording
        var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
        if (slot) slot.classList.add('recording');
        startPlayback();
    }

    // ── Playhead Animation Loop ──
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

    // ── Highlight the current beat column in the UI ──
    function highlightBeat(beat) {
        // Remove previous highlights
        document.querySelectorAll('.step-cell.playing').forEach(cell => {
            cell.classList.remove('playing');
        });

        // Add highlight to current beat column
        document.querySelectorAll(`.step-cell[data-col="${beat}"]`).forEach(cell => {
            cell.classList.add('playing');
        });
    }

    // ── Clear all highlights ──
    function clearHighlights() {
        document.querySelectorAll('.step-cell.playing').forEach(cell => {
            cell.classList.remove('playing');
        });
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

        // Stop all scheduled layer oscillators immediately
        stopScheduledLayerNodes();

        // If recording, finish it
        if (recordingLayer >= 0) {
            finishRecording();
        }

        // If armed, disarm
        if (isArmed) {
            disarm();
        }
    }

    // ── DOM Ready ──
    document.addEventListener('DOMContentLoaded', function () {
        const cells = document.querySelectorAll('.step-cell');
        const playBtn = document.getElementById('play-btn');
        const stopBtn = document.getElementById('stop-btn');
        const bpmSlider = document.getElementById('bpm-slider');
        const bpmDisplay = document.getElementById('bpm-display');

        // Toggle cells on click
        cells.forEach(cell => {
            cell.addEventListener('click', function () {
                // Ensure audio context is initialised on first interaction
                initAudio();

                const row = parseInt(this.dataset.row);
                const col = parseInt(this.dataset.col);
                const img = this.dataset.img;
                grid[row][col] = !grid[row][col];

                if (grid[row][col]) {
                    this.classList.add('active');
                    if (img) {
                        this.style.backgroundImage = 'url(' + img + ')';
                    }
                    // Play the sample immediately as feedback
                    if (audioCtx && buffers[row]) {
                        playSample(row, 0);
                    }
                } else {
                    this.classList.remove('active');
                    this.style.backgroundImage = '';
                }
            });
        });

        // Transport controls
        playBtn.addEventListener('click', function () {
            // If armed, clicking play triggers the armed recording
            if (isArmed) {
                triggerArmedRecording();
                return;
            }
            startPlayback();
        });
        stopBtn.addEventListener('click', stopPlayback);

        // BPM slider
        bpmSlider.addEventListener('input', function () {
            bpm = parseInt(this.value);
            bpmDisplay.textContent = bpm;
        });

        // Per-row volume inputs
        document.querySelectorAll('.vol-input').forEach(function (input) {
            input.addEventListener('change', function () {
                var row = parseInt(this.dataset.row);
                var val = Math.max(0, Math.min(100, parseInt(this.value) || 0));
                this.value = val;
                rowVolumes[row] = val / 100;
                if (rowGains[row]) {
                    rowGains[row].gain.value = rowVolumes[row];
                }
            });
        });

        // ═══════════════════════════════════
        // Stylophone Synth
        // ═══════════════════════════════════
        var synthOsc = null;
        var synthGain = null;
        var isSynthDragging = false;
        var activeKey = null;


        var waveSelect = document.getElementById('wave-select');
        var synthVolInput = document.getElementById('synth-vol');
        var pianoKeys = document.querySelectorAll('.piano-key');

        // Waveform selector
        waveSelect.addEventListener('change', function () {
            synthWaveform = this.value;
            if (synthOsc) {
                synthOsc.type = synthWaveform;
            }
        });

        // Synth volume
        synthVolInput.addEventListener('change', function () {
            var val = Math.max(0, Math.min(100, parseInt(this.value) || 0));
            this.value = val;
            synthVolume = val / 100;
            if (synthGain) {
                synthGain.gain.value = synthVolume;
            }
        });

        function startNote(freq) {
            initAudio();

            // If armed, trigger armed recording on first note
            var wasArmed = isArmed;
            if (isArmed) {
                triggerArmedRecording();
            }

            // Stop previous note (but don't record a stop if we just armed — no note was playing yet)
            if (synthOsc) {
                // There was a previous note playing, stop it and record the stop
                stopNote();
            }

            synthGain = audioCtx.createGain();
            synthGain.gain.value = synthVolume;
            synthGain.connect(audioCtx.destination);

            synthOsc = audioCtx.createOscillator();
            synthOsc.type = synthWaveform;
            synthOsc.frequency.value = freq;
            synthOsc.connect(synthGain);
            synthOsc.start();

            // Record
            recordEvent('start', freq);
        }

        function changeNote(freq) {
            if (synthOsc) {
                synthOsc.frequency.value = freq;
            }
            // Record
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
            // Only record stop if a note was actually playing
            if (wasPlaying) {
                recordEvent('stop', 0);
            }
        }

        function activateKey(key) {
            var freq = parseFloat(key.dataset.freq);
            if (activeKey === key) return; // same key, no change

            // Remove highlight from previous
            if (activeKey) activeKey.classList.remove('key-active');

            // Highlight new key
            key.classList.add('key-active');
            activeKey = key;

            if (!synthOsc) {
                startNote(freq);
            } else {
                changeNote(freq);
            }
        }

        // Get key from touch/mouse position
        function getKeyAtPoint(x, y) {
            var el = document.elementFromPoint(x, y);
            if (el && el.classList.contains('piano-key')) return el;
            return null;
        }

        // ── Mouse events ──
        pianoKeys.forEach(function (key) {
            key.addEventListener('mousedown', function (e) {
                e.preventDefault();
                isSynthDragging = true;
                activateKey(this);
            });

            key.addEventListener('mouseenter', function () {
                if (isSynthDragging) {
                    activateKey(this);
                }
            });
        });

        document.addEventListener('mouseup', function () {
            if (isSynthDragging) {
                isSynthDragging = false;
                stopNote();
            }
        });

        // ── Touch events (mobile) ──
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

                // If armed for this layer, disarm
                if (isArmed && armedLayer === layerIdx) {
                    disarm();
                    return;
                }

                // If armed for another layer, disarm first
                if (isArmed) {
                    disarm();
                }

                // If already recording this layer, stop
                if (recordingLayer === layerIdx) {
                    finishRecording();
                    return;
                }

                // If recording another layer, finish that first
                if (recordingLayer >= 0) {
                    finishRecording();
                }

                // If sequencer is already playing, start recording immediately
                if (isPlaying) {
                    recordingLayer = layerIdx;
                    recordingLoopCount = 0; // reset loop counter
                    layers[layerIdx] = []; // clear previous
                    layerWaveforms[layerIdx] = synthWaveform;
                    this.classList.add('recording');
                    var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
                    if (slot) {
                        slot.classList.remove('has-data');
                        slot.classList.add('recording');
                    }
                } else {
                    // Not playing — arm for recording (wait for first synth touch)
                    armLayer(layerIdx);
                }
            });
        });

        document.querySelectorAll('.layer-clear-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var layerIdx = parseInt(this.dataset.layer);

                // If armed for this layer, disarm
                if (isArmed && armedLayer === layerIdx) {
                    disarm();
                }

                // If currently recording this layer, stop recording
                if (recordingLayer === layerIdx) {
                    finishRecording();
                }
                layers[layerIdx] = [];
                var slot = document.querySelector('.layer-slot[data-layer="' + layerIdx + '"]');
                if (slot) {
                    slot.classList.remove('has-data');
                    slot.classList.remove('recording');
                }
            });
        });

        // Mute buttons
        document.querySelectorAll('.layer-mute-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var layerIdx = parseInt(this.dataset.layer);
                layerMuted[layerIdx] = !layerMuted[layerIdx];
                this.classList.toggle('muted', layerMuted[layerIdx]);

                // If we just muted and playback is running, stop that layer's scheduled nodes
                // (they'll be re-evaluated at the next loop start)
            });
        });

        // ── Page dots: update active dot on swipe ──
        var pagesContainer = document.querySelector('.dm-pages-container');
        var pageDots = document.querySelectorAll('.dm-dot');
        if (pagesContainer && pageDots.length > 0) {
            pagesContainer.addEventListener('scroll', function () {
                var scrollLeft = pagesContainer.scrollLeft;
                var pageWidth = pagesContainer.offsetWidth;
                var currentPage = Math.round(scrollLeft / pageWidth);
                pageDots.forEach(function (dot, i) {
                    dot.classList.toggle('active', i === currentPage);
                });
            });
        }
    });
})();
