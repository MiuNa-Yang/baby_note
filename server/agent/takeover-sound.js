// Short two-note PCM chime, generated locally without external audio services.
export function takeoverSound() {
  const rate = 24000;
  const samples = Math.round(rate * 0.38);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const time = i / rate;
    const start = time < 0.18 ? 0 : 0.18;
    const t = time - start;
    const envelope = Math.min(1, t / 0.008) * Math.max(0, 1 - t / 0.2) ** 2;
    const tone = Math.sin(2 * Math.PI * (start ? 1046.5 : 783.99) * t);
    wav.writeInt16LE(Math.round(6500 * envelope * tone), 44 + i * 2);
  }
  return wav;
}
