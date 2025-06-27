
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
