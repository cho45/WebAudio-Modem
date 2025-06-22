// DSP Filter implementations for WebAudio Modem
// Node.js compatible, no Web API dependencies

/**
 * IIR (Infinite Impulse Response) Filter
 * Memory-efficient recursive filter implementation
 */
export class IIRFilter {
  private b: number[]; // Feedforward coefficients
  private a: number[]; // Feedback coefficients
  private x: number[]; // Input history (circular buffer)
  private y: number[]; // Output history (circular buffer)
  private xIndex = 0; // Current index in input buffer
  private yIndex = 0; // Current index in output buffer
  private order: number;
  
  constructor(b: number[], a: number[]) {
    // Validate input coefficients
    if (!b || b.length === 0) {throw new Error('Feedforward coefficients (b) cannot be empty');}
    if (!a || a.length === 0) {throw new Error('Feedback coefficients (a) cannot be empty');}
    if (a[0] === 0) {throw new Error('First feedback coefficient (a[0]) cannot be zero');}
    
    this.b = [...b];
    this.a = [...a];
    this.order = Math.max(b.length, a.length) - 1;
    
    // Normalize coefficients (a[0] should be 1)
    if (this.a[0] !== 1) {
      const a0 = this.a[0];
      for (let i = 0; i < this.b.length; i++) {
        this.b[i] /= a0;
      }
      for (let i = 1; i < this.a.length; i++) {
        this.a[i] /= a0;
      }
      this.a[0] = 1;
    }
    
    this.reset();
  }
  
  /**
   * Process single sample through filter
   */
  process(input: number): number {
    // Store input in circular buffer
    this.x[this.xIndex] = input;
    
    // Calculate output using difference equation
    let output = 0;
    
    // Feedforward part (numerator) - b[i] * x[n-i]
    let xIdx = this.xIndex;
    for (let i = 0; i < this.b.length; i++) {
      output += this.b[i] * this.x[xIdx];
      xIdx = xIdx === 0 ? this.x.length - 1 : xIdx - 1;
    }
    
    // Feedback part (denominator) - a[i] * y[n-i]
    let yIdx = this.yIndex === 0 ? this.y.length - 1 : this.yIndex - 1;
    for (let i = 1; i < this.a.length; i++) {
      output -= this.a[i] * this.y[yIdx];
      yIdx = yIdx === 0 ? this.y.length - 1 : yIdx - 1;
    }
    
    // Store output in circular buffer
    this.y[this.yIndex] = output;
    
    // Update circular buffer indices
    this.xIndex = (this.xIndex + 1) % this.x.length;
    this.yIndex = (this.yIndex + 1) % this.y.length;
    
    return output;
  }
  
  /**
   * Process array of samples
   */
  processBuffer(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = this.process(input[i]);
    }
    return output;
  }
  
  /**
   * Reset filter state
   */
  reset(): void {
    // Initialize circular buffers with correct sizes
    this.x = new Array(Math.max(this.b.length, this.order + 1)).fill(0);
    this.y = new Array(Math.max(this.a.length - 1, this.order)).fill(0);
    this.xIndex = 0;
    this.yIndex = 0;
  }
  
  /**
   * Get filter coefficients
   */
  getCoefficients(): { b: number[], a: number[] } {
    return { b: [...this.b], a: [...this.a] };
  }
}

/**
 * FIR (Finite Impulse Response) Filter
 * Linear phase, stable filter implementation
 */
export class FIRFilter {
  private coefficients: number[];
  private delayLine: number[];
  private index = 0;
  
  constructor(coefficients: number[]) {
    this.coefficients = [...coefficients];
    this.delayLine = new Array(coefficients.length).fill(0);
  }
  
  /**
   * Process single sample through filter
   */
  process(input: number): number {
    // Circular buffer for delay line
    this.delayLine[this.index] = input;
    
    let output = 0;
    let delayIndex = this.index;
    
    // Convolution with coefficients
    for (let i = 0; i < this.coefficients.length; i++) {
      output += this.coefficients[i] * this.delayLine[delayIndex];
      delayIndex = delayIndex === 0 ? this.coefficients.length - 1 : delayIndex - 1;
    }
    
    this.index = (this.index + 1) % this.coefficients.length;
    return output;
  }
  
  /**
   * Process array of samples
   */
  processBuffer(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = this.process(input[i]);
    }
    return output;
  }
  
  /**
   * Reset filter state
   */
  reset(): void {
    this.delayLine.fill(0);
    this.index = 0;
  }
  
  /**
   * Get filter coefficients
   */
  getCoefficients(): number[] {
    return [...this.coefficients];
  }
}

/**
 * Filter design utilities
 */
export class FilterDesign {
  
  /**
   * Design 2nd order Butterworth lowpass IIR filter
   * @param cutoffFreq Cutoff frequency in Hz
   * @param sampleRate Sample rate in Hz
   * @returns IIR filter coefficients
   */
  static butterworthLowpass(cutoffFreq: number, sampleRate: number): { b: number[], a: number[] } {
    const nyquist = sampleRate / 2;
    const normalizedCutoff = cutoffFreq / nyquist;
    const c = Math.tan(Math.PI * normalizedCutoff / 2);
    const c2 = c * c;
    const sqrt2c = Math.SQRT2 * c;
    const denom = 1 + sqrt2c + c2;
    
    const b = [c2 / denom, 2 * c2 / denom, c2 / denom];
    const a = [1, (2 * c2 - 2) / denom, (1 - sqrt2c + c2) / denom];
    
    return { b, a };
  }
  
  /**
   * Design 2nd order Butterworth highpass IIR filter
   * @param cutoffFreq Cutoff frequency in Hz
   * @param sampleRate Sample rate in Hz
   * @returns IIR filter coefficients
   */
  static butterworthHighpass(cutoffFreq: number, sampleRate: number): { b: number[], a: number[] } {
    const nyquist = sampleRate / 2;
    const normalizedCutoff = cutoffFreq / nyquist;
    const c = Math.tan(Math.PI * normalizedCutoff / 2);
    const c2 = c * c;
    const sqrt2c = Math.SQRT2 * c;
    const denom = 1 + sqrt2c + c2;
    
    const b = [1 / denom, -2 / denom, 1 / denom];
    const a = [1, (2 * c2 - 2) / denom, (1 - sqrt2c + c2) / denom];
    
    return { b, a };
  }
  
  /**
   * Design 2nd order Butterworth bandpass IIR filter
   * @param centerFreq Center frequency in Hz
   * @param bandwidth Bandwidth in Hz
   * @param sampleRate Sample rate in Hz
   * @returns IIR filter coefficients
   */
  static butterworthBandpass(centerFreq: number, bandwidth: number, sampleRate: number): { b: number[], a: number[] } {
    const _nyquist = sampleRate / 2;
    const omega = 2 * Math.PI * centerFreq / sampleRate;
    const bw = 2 * Math.PI * bandwidth / sampleRate;
    
    const c = Math.tan(bw / 2);
    const d = 2 * Math.cos(omega);
    const c2 = c * c;
    const denom = 1 + c + c2;
    
    const b = [c / denom, 0, -c / denom];
    const a = [1, (-d * (1 + c2)) / denom, (1 - c + c2) / denom];
    
    return { b, a };
  }
  
  /**
   * Design windowed-sinc FIR lowpass filter
   * @param cutoffFreq Cutoff frequency in Hz
   * @param sampleRate Sample rate in Hz
   * @param numTaps Number of filter taps (should be odd)
   * @returns FIR filter coefficients
   */
  static sincLowpass(cutoffFreq: number, sampleRate: number, numTaps: number): number[] {
    if (numTaps % 2 === 0) {
      numTaps++; // Ensure odd number of taps
    }
    
    const normalizedCutoff = cutoffFreq / sampleRate;
    const center = (numTaps - 1) / 2;
    const coefficients = new Array(numTaps);
    
    for (let i = 0; i < numTaps; i++) {
      if (i === center) {
        coefficients[i] = 2 * normalizedCutoff;
      } else {
        const x = Math.PI * (i - center);
        coefficients[i] = Math.sin(2 * normalizedCutoff * x) / x;
      }
      
      // Apply Hamming window
      coefficients[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (numTaps - 1));
    }
    
    return coefficients;
  }
  
  /**
   * Design windowed-sinc FIR highpass filter
   * @param cutoffFreq Cutoff frequency in Hz
   * @param sampleRate Sample rate in Hz
   * @param numTaps Number of filter taps (should be odd)
   * @returns FIR filter coefficients
   */
  static sincHighpass(cutoffFreq: number, sampleRate: number, numTaps: number): number[] {
    // Design lowpass and spectral invert
    const lowpass = this.sincLowpass(cutoffFreq, sampleRate, numTaps);
    const center = (numTaps - 1) / 2;
    
    // Spectral inversion
    for (let i = 0; i < numTaps; i++) {
      lowpass[i] = -lowpass[i];
    }
    lowpass[center] += 1; // Add impulse at center
    
    return lowpass;
  }
  
  /**
   * Design windowed-sinc FIR bandpass filter
   * @param centerFreq Center frequency in Hz
   * @param bandwidth Bandwidth in Hz
   * @param sampleRate Sample rate in Hz
   * @param numTaps Number of filter taps (should be odd)
   * @returns FIR filter coefficients
   */
  static sincBandpass(centerFreq: number, bandwidth: number, sampleRate: number, numTaps: number): number[] {
    const lowFreq = centerFreq - bandwidth / 2;
    const highFreq = centerFreq + bandwidth / 2;
    
    const highpass = this.sincHighpass(lowFreq, sampleRate, numTaps);
    const lowpass = this.sincLowpass(highFreq, sampleRate, numTaps);
    
    // Combine highpass and lowpass (convolution)
    const bandpass = new Array(numTaps).fill(0);
    for (let i = 0; i < numTaps; i++) {
      for (let j = 0; j < numTaps; j++) {
        if (i + j < numTaps) {
          bandpass[i + j] += highpass[i] * lowpass[j];
        }
      }
    }
    
    return bandpass;
  }
}

/**
 * Convenient filter factory functions
 */
export class FilterFactory {
  
  /**
   * Create IIR lowpass filter
   */
  static createIIRLowpass(cutoffFreq: number, sampleRate: number): IIRFilter {
    const { b, a } = FilterDesign.butterworthLowpass(cutoffFreq, sampleRate);
    return new IIRFilter(b, a);
  }
  
  /**
   * Create IIR highpass filter
   */
  static createIIRHighpass(cutoffFreq: number, sampleRate: number): IIRFilter {
    const { b, a } = FilterDesign.butterworthHighpass(cutoffFreq, sampleRate);
    return new IIRFilter(b, a);
  }
  
  /**
   * Create IIR bandpass filter
   */
  static createIIRBandpass(centerFreq: number, bandwidth: number, sampleRate: number): IIRFilter {
    const { b, a } = FilterDesign.butterworthBandpass(centerFreq, bandwidth, sampleRate);
    return new IIRFilter(b, a);
  }
  
  /**
   * Create FIR lowpass filter
   */
  static createFIRLowpass(cutoffFreq: number, sampleRate: number, numTaps = 51): FIRFilter {
    const coefficients = FilterDesign.sincLowpass(cutoffFreq, sampleRate, numTaps);
    return new FIRFilter(coefficients);
  }
  
  /**
   * Create FIR highpass filter
   */
  static createFIRHighpass(cutoffFreq: number, sampleRate: number, numTaps = 51): FIRFilter {
    const coefficients = FilterDesign.sincHighpass(cutoffFreq, sampleRate, numTaps);
    return new FIRFilter(coefficients);
  }
  
  /**
   * Create FIR bandpass filter
   */
  static createFIRBandpass(centerFreq: number, bandwidth: number, sampleRate: number, numTaps = 51): FIRFilter {
    const coefficients = FilterDesign.sincBandpass(centerFreq, bandwidth, sampleRate, numTaps);
    return new FIRFilter(coefficients);
  }
}