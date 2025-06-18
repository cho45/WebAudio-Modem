class IQProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.n = 0;
    this.toneCenter = opts.toneCenter || 41;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0][0];
    const outputI = outputs[0][0];
    const outputQ = outputs[0][1];
    if (!input || !outputI || !outputQ) return true;
    for (let i = 0, len = input.length; i < len; i++) {
      outputI[i] = Math.cos(this.n / this.toneCenter) * input[i];
      outputQ[i] = Math.sin(this.n / this.toneCenter) * input[i];
      this.n++;
    }
    return true;
  }
}

registerProcessor('iq-processor', IQProcessor);
