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
