const MAX_VOICES = 2;
const MASTER_GAIN = 0.3;
const CUE_INTERVAL_MIN = 24;
const CUE_INTERVAL_MAX = 52;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positionOf(value) {
  if (!value) return null;
  const point = value.position || value.worldPosition || value.pos || value;
  if (Array.isArray(point)) {
    const x = Number(point[0]);
    const z = Number(point.length > 2 ? point[2] : point[1]);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }
  if (typeof point !== "object") return null;
  const x = Number(point.x);
  const z = Number(point.z);
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}

function speciesOf(value) {
  if (!value || typeof value !== "object") return null;
  const labels = [value.species, value.kind, value.type, value.name, value.id]
    .filter((label) => typeof label === "string")
    .join(" ")
    .toLowerCase();
  if (/dolphin|porpoise/.test(labels)) return "dolphin";
  if (/whale|cetacean/.test(labels)) return "whale";
  if (/gull|seagull|shorebird|\bbird\b/.test(labels)) return "gull";
  return null;
}

function wildlifeItems(wildlife) {
  const result = [];
  const visited = new Set();
  const collect = (value, depth) => {
    if (!value || depth > 2 || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (speciesOf(value)) result.push(value);
    for (const key of ["animals", "creatures", "entities", "wildlife", "birds", "gulls", "whales", "dolphins"]) {
      if (value[key] && value[key] !== value) collect(value[key], depth + 1);
    }
  };
  collect(wildlife, 0);
  return result;
}

function disconnectAll(nodes) {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {}
  }
}

export function createMaritimeAudio() {
  const AudioContextClass = typeof globalThis !== "undefined"
    ? (globalThis.AudioContext || globalThis.webkitAudioContext)
    : null;
  let supported = typeof AudioContextClass === "function";
  let context = null;
  let master = null;
  let disposed = false;
  let lastError = null;
  let loops = [];
  let waterLoop = null;
  const voices = new Set();
  let cuesPlayed = 0;
  let elapsedSeconds = 0;
  let randomState = 0x5a17c9e3;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  let nextCueAt = 18 + random() * 18;

  const noteError = (error) => {
    lastError = String((error && error.message) || error || "Web Audio unavailable");
  };

  function makePanner(pan) {
    if (!context || typeof context.createStereoPanner !== "function") return null;
    const panner = context.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    return panner;
  }

  function makeNoiseLoop({ cutoff, highpass, gain: level }) {
    const nodes = [];
    try {
      const frames = Math.max(1, Math.floor(context.sampleRate * 8));
      const buffer = context.createBuffer(1, frames, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      nodes.push(source);
      let tail = source;

      if (highpass) {
        const filter = context.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = highpass;
        filter.Q.value = 0.35;
        tail.connect(filter);
        tail = filter;
        nodes.push(filter);
      }
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = cutoff;
      lowpass.Q.value = 0.3;
      tail.connect(lowpass);
      tail = lowpass;
      nodes.push(lowpass);

      const levelNode = context.createGain();
      levelNode.gain.value = level;
      tail.connect(levelNode);
      levelNode.connect(master);
      nodes.push(levelNode);
      source.start();
      return { nodes, source, levelNode };
    } catch (error) {
      disconnectAll(nodes);
      noteError(error);
      return null;
    }
  }

  function startLoops() {
    if (loops.length || !context || !master) return;
    const wind = makeNoiseLoop({ cutoff: 430, highpass: 75, gain: 0.026 });
    const water = makeNoiseLoop({ cutoff: 1150, highpass: 150, gain: 0.014 });
    waterLoop = water;
    loops = [wind, water].filter(Boolean);
  }

  function cleanupVoice(voice) {
    if (!voice || !voices.has(voice)) return;
    voices.delete(voice);
    disconnectAll(voice.nodes);
  }

  function scheduleCue(kind, pan, attenuation) {
    if (!context || !master || context.state !== "running" || voices.size >= MAX_VOICES) return false;

    const now = context.currentTime;
    const nodes = [];
    let oscillator;
    let voice;
    try {
      oscillator = context.createOscillator();
      oscillator.type = kind === "gull" ? "triangle" : "sine";
      nodes.push(oscillator);

      const filter = context.createBiquadFilter();
      filter.type = kind === "whale" ? "lowpass" : "bandpass";
      filter.frequency.value = kind === "whale" ? 430 : (kind === "dolphin" ? 2250 : 1800);
      filter.Q.value = kind === "gull" ? 1.15 : 0.75;
      oscillator.connect(filter);
      nodes.push(filter);

      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, now);
      filter.connect(envelope);
      nodes.push(envelope);

      const panner = makePanner(pan);
      if (panner) {
        envelope.connect(panner);
        panner.connect(master);
        nodes.push(panner);
      } else {
        envelope.connect(master);
      }

      const loudness = clamp(attenuation, 0.08, 1);
      let duration;
      if (kind === "gull") {
        duration = 0.82;
        oscillator.frequency.setValueAtTime(1080, now);
        oscillator.frequency.exponentialRampToValueAtTime(1880, now + 0.14);
        oscillator.frequency.exponentialRampToValueAtTime(1260, now + 0.3);
        oscillator.frequency.exponentialRampToValueAtTime(2140, now + 0.48);
        oscillator.frequency.exponentialRampToValueAtTime(1600, now + duration);
        envelope.gain.linearRampToValueAtTime(0.019 * loudness, now + 0.045);
        envelope.gain.setValueAtTime(0.0001, now + 0.27);
        envelope.gain.linearRampToValueAtTime(0.014 * loudness, now + 0.36);
        envelope.gain.linearRampToValueAtTime(0.0001, now + duration);
      } else if (kind === "whale") {
        duration = 3.5;
        oscillator.frequency.setValueAtTime(205, now);
        oscillator.frequency.exponentialRampToValueAtTime(132, now + 1.55);
        oscillator.frequency.exponentialRampToValueAtTime(185, now + duration);
        envelope.gain.linearRampToValueAtTime(0.014 * loudness, now + 0.5);
        envelope.gain.linearRampToValueAtTime(0.011 * loudness, now + 1.8);
        envelope.gain.linearRampToValueAtTime(0.0001, now + duration);
      } else {
        duration = 0.78;
        oscillator.frequency.setValueAtTime(1500, now);
        oscillator.frequency.exponentialRampToValueAtTime(2850, now + 0.12);
        oscillator.frequency.exponentialRampToValueAtTime(1740, now + 0.23);
        oscillator.frequency.exponentialRampToValueAtTime(3050, now + 0.43);
        oscillator.frequency.exponentialRampToValueAtTime(2050, now + duration);
        envelope.gain.linearRampToValueAtTime(0.012 * loudness, now + 0.055);
        envelope.gain.setValueAtTime(0.0001, now + 0.2);
        envelope.gain.linearRampToValueAtTime(0.009 * loudness, now + 0.29);
        envelope.gain.linearRampToValueAtTime(0.0001, now + duration);
      }

      voice = { nodes, oscillator };
      voices.add(voice);
      oscillator.onended = () => cleanupVoice(voice);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.03);
      cuesPlayed++;
      return true;
    } catch (error) {
      if (voice) cleanupVoice(voice);
      else disconnectAll(nodes);
      noteError(error);
      return false;
    }
  }

  function chooseCue(ship, wildlife) {
    const candidates = wildlifeItems(wildlife).map((item) => {
      const kind = speciesOf(item);
      const position = positionOf(item);
      if (!kind) return null;
      let distance = null;
      let pan = (random() * 2) - 1;
      let attenuation = kind === "gull" ? 0.55 : 0.48;
      if (ship && position) {
        const dx = position.x - ship.x;
        const dz = position.z - ship.z;
        distance = Math.hypot(dx, dz);
        const range = kind === "gull" ? 850 : (kind === "dolphin" ? 360 : 780);
        if (distance > range * 2.2) return null;
        let side = dx;
        if (finite(ship.yaw)) side = dx * Math.cos(ship.yaw) - dz * Math.sin(ship.yaw);
        pan = clamp(side / (range * 0.7), -1, 1);
        attenuation = 1 / (1 + (distance / range) ** 2);
      }
      return { kind, distance: distance ?? Infinity, pan, attenuation };
    }).filter(Boolean);

    if (candidates.length) {
      candidates.sort((a, b) => a.distance - b.distance);
      const near = candidates.slice(0, Math.min(4, candidates.length));
      const chosen = near[Math.floor(random() * near.length)];
      return chosen;
    }

    // Gulls remain an occasional distant coastal presence when no fauna data is supplied.
    if (random() < 0.62) {
      return { kind: "gull", pan: (random() * 1.4) - 0.7, attenuation: 0.36 };
    }
    return null;
  }

  async function unlock() {
    if (disposed) return false;
    if (!supported || typeof AudioContextClass !== "function") {
      supported = false;
      lastError = "Web Audio API is not supported";
      return false;
    }
    try {
      if (!context) {
        try {
          context = new AudioContextClass({ latencyHint: "interactive" });
        } catch {
          context = new AudioContextClass();
        }
        master = context.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(context.destination);
        startLoops();
      }
      if (context.state !== "running" && typeof context.resume === "function") await context.resume();
      if (context.state === "running") {
        nextCueAt = elapsedSeconds + 16 + random() * 24;
        return true;
      }
      return false;
    } catch (error) {
      noteError(error);
      return false;
    }
  }

  function update(elapsed, shipPosition, wildlife) {
    if (disposed) return;
    if (finite(elapsed)) elapsedSeconds = Math.max(0, elapsed);
    if (!context || context.state !== "running") return;
    // Bow wash: the water bed swells with ship speed so sailing sounds like sailing.
    if (waterLoop && finite(shipPosition?.speed)) {
      const wash = clamp(Math.abs(shipPosition.speed) / 40, 0, 1);
      const target = 0.014 * (0.55 + wash * 2.2);
      try {
        waterLoop.levelNode.gain.setTargetAtTime(target, context.currentTime, 0.4);
      } catch {}
    }
    if (elapsedSeconds < nextCueAt) return;

    const cue = chooseCue(positionOf(shipPosition), wildlife);
    if (cue) scheduleCue(cue.kind, cue.pan, cue.attenuation);
    nextCueAt = elapsedSeconds + CUE_INTERVAL_MIN + random() * (CUE_INTERVAL_MAX - CUE_INTERVAL_MIN);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const voice of Array.from(voices)) {
      try {
        voice.oscillator.stop();
      } catch {}
      cleanupVoice(voice);
    }
    for (const loop of loops) {
      try {
        loop.source.stop();
      } catch {}
      disconnectAll(loop.nodes);
    }
    loops = [];
    if (context && typeof context.close === "function" && context.state !== "closed") {
      try {
        const closing = context.close();
        if (closing && typeof closing.catch === "function") closing.catch(() => {});
      } catch {}
    }
    context = null;
    master = null;
  }

  function diagnosticSnapshot() {
    return {
      supported,
      unlocked: !!context && context.state === "running",
      disposed,
      audioState: context ? context.state : "uninitialized",
      activeLoops: loops.length,
      activeVoices: voices.size,
      cuesPlayed,
      elapsed: elapsedSeconds,
      lastError,
    };
  }

  return {
    unlock,
    update,
    dispose,
    get diagnostics() {
      return diagnosticSnapshot();
    },
    get state() {
      return diagnosticSnapshot();
    },
  };
}
