// Ring buffer for audio data streaming
export class RingBuffer {
  private buffer: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private _length = 0;
  private maxLength: number;
  
  constructor(size: number) {
    this.buffer = new Float32Array(size);
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
      this.buffer[this.writeIndex] = value;
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
  
  // Additional methods for AudioWorklet usage
  read(): number {
    return this._length > 0 ? this.remove() : 0;
  }
  
  write(value: number): void {
    this.put(value);
  }
  
  // Bulk operations for Float32Array
  writeArray(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.put(samples[i]);
    }
  }
  
  readArray(output: Float32Array): void {
    for (let i = 0; i < output.length; i++) {
      output[i] = this._length > 0 ? this.remove() : 0;
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
  
  toArray(): Float32Array {
    const result = new Float32Array(this._length);
    for (let i = 0; i < this._length; i++) {
      result[i] = this.get(i);
    }
    return result;
  }
}
