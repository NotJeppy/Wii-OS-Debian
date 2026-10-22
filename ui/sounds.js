// Menu sounds, synthesized on the fly so the project ships no audio files.
const ctx = new AudioContext();
const master = ctx.createGain();
master.gain.value = 0.6;
master.connect(ctx.destination);

function tone(freq, at, dur, { type = "sine", gain = 0.15, attack = 0.004 } = {}) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function whoosh(at, dur, from, to) {
  const t = ctx.currentTime + at;
  const noise = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 2.5;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(0.08, t + dur * 0.3);
  amp.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(filter).connect(amp).connect(master);
  src.start(t);
}

const SOUNDS = {
  move() { tone(1480, 0, 0.06, { type: "triangle", gain: 0.05 }); },
  select() { tone(880, 0, 0.14, { gain: 0.12 }); tone(1318.5, 0.05, 0.22, { gain: 0.1 }); },
  back() { tone(1046.5, 0, 0.12, { gain: 0.1 }); tone(698.5, 0.06, 0.2, { gain: 0.1 }); },
  bump() { tone(196, 0, 0.12, { type: "triangle", gain: 0.08 }); },
  open() { whoosh(0, 0.4, 500, 3000); tone(1568, 0.12, 0.3, { gain: 0.06 }); },
  close() { whoosh(0, 0.35, 2600, 450); },
  start() {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, i * 0.07, 0.5, { gain: 0.09 }));
    whoosh(0.1, 0.7, 800, 6000);
  },
  welcome() { [392, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.12, 0.9, { gain: 0.07 })); },
};

export function play(name) {
  if (ctx.state === "suspended") ctx.resume();
  SOUNDS[name]?.();
}
