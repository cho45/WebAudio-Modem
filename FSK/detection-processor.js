class DetectionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.d = 0;
  }
  process(inputs, outputs, parameters) {
    const inputI = inputs[0][0];
    const inputQ = inputs[0][1];
    const outputMerged = outputs[0][0];
    if (!inputI || !inputQ || !outputMerged) return true;
    for (let i = 0, len = inputI.length; i < len; i++) {
      const amp = inputI[i] * inputI[i] + inputQ[i] * inputQ[i];
      const pha = Math.atan2(inputQ[i], inputI[i]) / Math.PI * 2;
      const dif = (this.d - pha + 2) % 2;
      outputMerged[i] = (dif - 1) * amp;
      this.d = pha;
    }
    return true;
  }
}

registerProcessor('detection-processor', DetectionProcessor);
