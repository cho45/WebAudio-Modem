
// 型補助: TypedArray, TypedArrayConstructor
export type TypedArray = Float32Array | Float64Array | Int32Array | Int16Array | Int8Array | Uint32Array | Uint16Array | Uint8Array | Uint8ClampedArray;
export type TypedArrayConstructor<T extends TypedArray> = { new(size: number): T };

export class RingBuffer<T extends TypedArray> {
  private buffer: T;
  private readIndex = 0;
  private writeIndex = 0;
  private _length = 0;
  private maxLength: number;
  private ArrayType: TypedArrayConstructor<T>;

  constructor(ArrayType: TypedArrayConstructor<T>, size: number) {
    this.ArrayType = ArrayType;
    this.buffer = new ArrayType(size) as T;
    this.maxLength = size;
  }

  get length(): number {
    return this._length;
  }

  get capacity(): number {
    return this.maxLength;
  }

  get(index: number): number {
    if (index < 0) {
      index += this._length;
    }
    if (index < 0 || index >= this._length) {
      throw new Error('Index out of bounds');
    }
    return this.buffer[(this.readIndex + index) % this.maxLength];
  }

  put(...values: number[]): void {
    for (const value of values) {
      this.buffer[this.writeIndex] = value as any;
      this.writeIndex = (this.writeIndex + 1) % this.maxLength;
      if (this._length < this.maxLength) {
        this._length++;
      } else {
        this.readIndex = (this.readIndex + 1) % this.maxLength;
      }
    }
  }

  remove(): number {
    if (this._length === 0) {
      throw new Error('Buffer is empty');
    }
    const value = this.buffer[this.readIndex];
    this.readIndex = (this.readIndex + 1) % this.maxLength;
    this._length--;
    return value;
  }

  read(): number {
    return this._length > 0 ? this.remove() : 0;
  }

  write(value: number): void {
    this.put(value);
  }

  writeArray(samples: T): void {
    for (let i = 0; i < samples.length; i++) {
      this.put(samples[i]);
    }
  }

  readArray(output: T): void {
    for (let i = 0; i < output.length; i++) {
      output[i] = this._length > 0 ? (this.remove() as any) : 0;
    }
  }

  availableRead(): number {
    return this._length;
  }

  availableWrite(): number {
    return this.maxLength - this._length;
  }

  hasSpace(minSpace: number): boolean {
    return this.availableWrite() > minSpace;
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this._length = 0;
  }

  toArray(): T {
    const result = new this.ArrayType(this._length) as T;
    for (let i = 0; i < this._length; i++) {
      result[i] = this.get(i) as any;
    }
    return result;
  }
}

// ==============================================================================
// Signal Processing Utilities
// ==============================================================================

/**
 * Calculate Bit Error Rate between two bit arrays
 * @param originalBits Original transmitted bits as Uint8Array
 * @param receivedBits Received/recovered bits as Uint8Array
 * @returns BER (0.0 to 1.0)
 */
export function calculateBER(originalBits: Uint8Array, receivedBits: Uint8Array): number {
  if (originalBits.length !== receivedBits.length) {
    throw new Error('Bit arrays must have same length');
  }
  
  if (originalBits.length === 0) return 0;
  
  let errors = 0;
  for (let i = 0; i < originalBits.length; i++) {
    if (originalBits[i] !== receivedBits[i]) {
      errors++;
    }
  }
  
  return errors / originalBits.length;
}

/**
 * Add Additive White Gaussian Noise to signal
 * @param signal Input signal array as Float32Array
 * @param snrDb Signal-to-Noise Ratio in dB
 * @returns Noisy signal array as Float32Array
 */
export function addAWGN(signal: Float32Array, snrDb: number): Float32Array {
  const noisySignal = new Float32Array(signal.length);
  
  // Calculate signal power
  let signalPower = 0;
  for (let i = 0; i < signal.length; i++) {
    signalPower += signal[i] * signal[i];
  }
  signalPower /= signal.length;
  
  // Calculate noise power from SNR
  const snrLinear = Math.pow(10, snrDb / 10);
  const noisePower = signalPower / snrLinear;
  const noiseStd = Math.sqrt(noisePower);
  
  // Add Gaussian noise
  for (let i = 0; i < signal.length; i++) {
    const noise = generateGaussianNoise() * noiseStd;
    noisySignal[i] = signal[i] + noise;
  }
  
  return noisySignal;
}

/**
 * Generate Gaussian noise sample using Box-Muller transform
 * @returns Random number from standard normal distribution N(0,1)
 */
export function generateGaussianNoise(): number {
  // Box-Muller transform for Gaussian random numbers
  const u1 = Math.random();
  const u2 = Math.random();
  
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * クイックセレクト実装（k番目の値を返す、in-place、比較関数指定可）
 * @param arr 配列（in-placeで書き換えます）
 * @param k 0-basedでk番目
 * @param compare 比較関数（a, b）=> number（b-aで降順, a-bで昇順）
 * @returns k番目の値
 */
export function quickSelect<T>(
  arr: ArrayLike<T> & { [n: number]: T; length: number },
  k: number,
  compare: (_a: T, _b: T) => number = (a, b) => (b as any) - (a as any) // デフォルト降順
): T {
  let left = 0, right = arr.length - 1;
  while (left < right) {
    const pivot = arr[right];
    let i = left;
    for (let j = left; j < right; j++) {
      if (compare(arr[j], pivot) < 0) {
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
        i++;
      }
    }
    const tmp = arr[i];
    arr[i] = arr[right];
    arr[right] = tmp;

    if (i === k) return arr[i];
    if (i < k) left = i + 1;
    else right = i - 1;
  }
  return arr[left];
}
