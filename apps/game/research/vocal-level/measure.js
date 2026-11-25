const frequencies = [200, 300, 500, 700, 900, 1100];

class MeasureOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capture = [];
    this.port.onmessage = ({ data }) => {
      this.capture = [[], []];
      this.level = data;
      this.peakError = 0;
      this.energy = 0;
      this.ramp = [];
    };
  }

  process([input, mix]) {
    if (this.capture.length === 0 || input.length !== 2 || mix.length !== 4) return true;
    const size = Math.round(sampleRate * 0.12);
    let differenceEnergy = 0;
    let differenceProjection = 0;
    for (let channel = 0; channel < 2; channel++) {
      const samples = this.capture[channel];
      const block = input[channel].subarray(0, size - samples.length);
      for (let i = 0; i < block.length; i++) {
        const backing = mix[channel + 2][i];
        const difference = mix[channel][i] - backing;
        if (this.level === null) {
          differenceEnergy += difference ** 2;
          differenceProjection += (block[i] - backing) * difference;
        } else {
          const expected = backing + this.level * difference;
          this.peakError = Math.max(this.peakError, Math.abs(block[i] - expected));
        }
        this.energy += block[i] ** 2;
      }
      samples.push(...block);
    }
    if (this.level === null && differenceEnergy > 1e-8) {
      this.ramp.push(differenceProjection / differenceEnergy);
    }
    if (this.capture[0].length === size) {
      const amplitudes = this.capture.map((samples) =>
        frequencies.map((frequency) => {
          let real = 0;
          let imaginary = 0;
          for (let i = 0; i < samples.length; i++) {
            const angle = (2 * Math.PI * frequency * i) / sampleRate;
            real += samples[i] * Math.cos(angle);
            imaginary += samples[i] * Math.sin(angle);
          }
          return (2 * Math.hypot(real, imaginary)) / size;
        }),
      );
      const port = this.port;
      port.postMessage({
        tones: amplitudes,
        peakError: this.peakError,
        rms: Math.sqrt(this.energy / (2 * size)),
        ramp: this.ramp,
        blockSize: input[0].length,
      });
      this.capture = [];
    }
    return true;
  }
}
registerProcessor("measure-output", MeasureOutput);
