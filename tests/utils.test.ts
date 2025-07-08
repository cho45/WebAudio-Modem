import { describe, it, expect, beforeEach } from 'vitest'
import { RingBuffer, quickSelect } from '../src/utils'

describe('RingBuffer', () => {
  let buffer: RingBuffer<Float32Array>;

  beforeEach(() => {
    buffer = new RingBuffer(Float32Array, 4);
  })

  it('should initialize with correct capacity and empty state', () => {
    expect(buffer.capacity).toBe(4)
    expect(buffer.length).toBe(0)
  })

  it('should put and get single values', () => {
    buffer.put(1.0)
    expect(buffer.length).toBe(1)
    expect(buffer.get(0)).toBe(1.0)
  })

  it('should put multiple values', () => {
    buffer.put(1.0, 2.0, 3.0)
    expect(buffer.length).toBe(3)
    expect(buffer.get(0)).toBe(1.0)
    expect(buffer.get(1)).toBe(2.0)
    expect(buffer.get(2)).toBe(3.0)
  })

  it('should handle overflow by overwriting oldest values', () => {
    buffer.put(1.0, 2.0, 3.0, 4.0) // Fill buffer
    expect(buffer.length).toBe(4)
    
    buffer.put(5.0) // Should overwrite first value
    expect(buffer.length).toBe(4)
    expect(buffer.get(0)).toBe(2.0) // First value should now be 2.0
    expect(buffer.get(1)).toBe(3.0)
    expect(buffer.get(2)).toBe(4.0)
    expect(buffer.get(3)).toBe(5.0)
  })

  it('should remove values in FIFO order', () => {
    buffer.put(1.0, 2.0, 3.0)
    
    expect(buffer.remove()).toBe(1.0)
    expect(buffer.length).toBe(2)
    
    expect(buffer.remove()).toBe(2.0)
    expect(buffer.length).toBe(1)
    
    expect(buffer.remove()).toBe(3.0)
    expect(buffer.length).toBe(0)
  })

  it('should throw error when removing from empty buffer', () => {
    expect(() => buffer.remove()).toThrow('Buffer is empty')
  })

  it('should handle negative indices (from end)', () => {
    buffer.put(1.0, 2.0, 3.0)
    expect(buffer.get(-1)).toBe(3.0) // Last value
    expect(buffer.get(-2)).toBe(2.0) // Second to last
    expect(buffer.get(-3)).toBe(1.0) // Third to last
  })

  it('should throw error for out of bounds access', () => {
    buffer.put(1.0, 2.0)
    expect(() => buffer.get(2)).toThrow('Index out of bounds')
    expect(() => buffer.get(-3)).toThrow('Index out of bounds')
  })

  it('should clear buffer correctly', () => {
    buffer.put(1.0, 2.0, 3.0)
    expect(buffer.length).toBe(3)
    
    buffer.clear()
    expect(buffer.length).toBe(0)
    expect(buffer.capacity).toBe(4) // Capacity should remain unchanged
  })

  it('should convert to array correctly', () => {
    buffer.put(1.0, 2.0, 3.0)
    const array = buffer.toArray()
    
    expect(array).toBeInstanceOf(Float32Array)
    expect(array.length).toBe(3)
    expect(array[0]).toBe(1.0)
    expect(array[1]).toBe(2.0)
    expect(array[2]).toBe(3.0)
  })

  it('should handle circular buffer operations correctly', () => {
    // Fill buffer completely
    buffer.put(1.0, 2.0, 3.0, 4.0)
    
    // Remove some values
    buffer.remove() // Remove 1.0
    buffer.remove() // Remove 2.0
    
    // Add new values
    buffer.put(5.0, 6.0)
    
    // Check final state
    expect(buffer.length).toBe(4)
    expect(buffer.get(0)).toBe(3.0)
    expect(buffer.get(1)).toBe(4.0)
    expect(buffer.get(2)).toBe(5.0)
    expect(buffer.get(3)).toBe(6.0)
  })

  it('should maintain correct state after multiple operations', () => {
    // Complex sequence of operations
    buffer.put(1.0)
    buffer.put(2.0, 3.0)
    expect(buffer.remove()).toBe(1.0)
    
    buffer.put(4.0, 5.0, 6.0)
    expect(buffer.length).toBe(4) // Should be at capacity
    expect(buffer.get(0)).toBe(3.0) // 2.0 should be overwritten
    
    buffer.clear()
    expect(buffer.length).toBe(0)
    
    buffer.put(7.0)
    expect(buffer.get(0)).toBe(7.0)
    expect(buffer.length).toBe(1)
  })

  it('should handle edge case with size 1 buffer', () => {
    const smallBuffer = new RingBuffer(Float32Array, 1)
    
    smallBuffer.put(1.0)
    expect(smallBuffer.length).toBe(1)
    expect(smallBuffer.get(0)).toBe(1.0)
    
    smallBuffer.put(2.0) // Should overwrite
    expect(smallBuffer.length).toBe(1)
    expect(smallBuffer.get(0)).toBe(2.0)
  })

  it('should handle empty buffer toArray', () => {
    const array = buffer.toArray()
    expect(array.length).toBe(0)
  })
  
  it('should support AudioWorklet helper methods', () => {
    // Test read() method (safe remove)
    expect(buffer.read()).toBe(0) // Empty buffer returns 0
    
    buffer.write(5.5)
    buffer.write(6.6)
    
    expect(buffer.availableRead()).toBe(2)
    expect(buffer.availableWrite()).toBe(2) // 4 - 2
    
    expect(buffer.read()).toBeCloseTo(5.5)
    expect(buffer.read()).toBeCloseTo(6.6)
    expect(buffer.read()).toBe(0) // Empty again
    
    expect(buffer.availableRead()).toBe(0)
    expect(buffer.availableWrite()).toBe(4)
  })
  
  it('should have write method as alias for put', () => {
    buffer.write(7.7)
    expect(buffer.get(0)).toBeCloseTo(7.7)
    expect(buffer.length).toBe(1)
  })
  
  it('should support bulk Float32Array operations', () => {
    const input = new Float32Array([1.5, 2.5, 3.5, 4.5])
    buffer.writeArray(input)
    
    expect(buffer.length).toBe(4)
    expect(buffer.get(0)).toBeCloseTo(1.5)
    expect(buffer.get(3)).toBeCloseTo(4.5)
    
    const output = new Float32Array(3)
    buffer.readArray(output)
    
    expect(output[0]).toBeCloseTo(1.5)
    expect(output[1]).toBeCloseTo(2.5)
    expect(output[2]).toBeCloseTo(3.5)
    expect(buffer.length).toBe(1) // One remaining
  })
  
  it('should handle hasSpace method', () => {
    expect(buffer.hasSpace(2)).toBe(true) // 4 - 0 > 2
    
    buffer.put(1, 2, 3) // 3 items, 1 space left
    expect(buffer.hasSpace(2)).toBe(false) // 4 - 3 = 1 < 2
    expect(buffer.hasSpace(0)).toBe(true) // 1 > 0
  })
  
  it('should fill with zeros when reading more than available', () => {
    buffer.put(10, 20)
    
    const output = new Float32Array(5)
    output.fill(99) // Pre-fill to verify zeros are written
    
    buffer.readArray(output)
    
    expect(output[0]).toBe(10)
    expect(output[1]).toBe(20) 
    expect(output[2]).toBe(0) // Zero fill
    expect(output[3]).toBe(0)
    expect(output[4]).toBe(0)
    expect(buffer.length).toBe(0)
  })
})

describe('quickSelect', () => {
  it('should return k-th element with default compare function (descending)', () => {
    const arr = [3, 1, 4, 1, 5, 9, 2, 6];
    
    // デフォルトの降順ソート: [9, 6, 5, 4, 3, 2, 1, 1]
    expect(quickSelect(arr, 0)).toBe(9);  // 最大値
    expect(quickSelect(arr.slice(), 1)).toBe(6);  // 2番目に大きい値
    expect(quickSelect(arr.slice(), 2)).toBe(5);  // 3番目に大きい値
    expect(quickSelect(arr.slice(), 7)).toBe(1);  // 最小値
  });

  it('should return k-th element with ascending compare function', () => {
    const arr = [3, 1, 4, 1, 5, 9, 2, 6];
    const ascendingCompare = (a: number, b: number) => a - b;
    
    // 昇順ソート: [1, 1, 2, 3, 4, 5, 6, 9]
    expect(quickSelect(arr, 0, ascendingCompare)).toBe(1);  // 最小値
    expect(quickSelect(arr.slice(), 1, ascendingCompare)).toBe(1);  // 2番目に小さい値
    expect(quickSelect(arr.slice(), 2, ascendingCompare)).toBe(2);  // 3番目に小さい値
    expect(quickSelect(arr.slice(), 7, ascendingCompare)).toBe(9);  // 最大値
  });

  it('should handle boundary values (k=0 and k=length-1)', () => {
    const arr = [10, 20, 30, 40, 50];
    
    // k=0: 最大値 (降順)
    expect(quickSelect(arr, 0)).toBe(50);
    
    // k=length-1: 最小値 (降順)
    expect(quickSelect(arr.slice(), arr.length - 1)).toBe(10);
    
    // 昇順でも確認
    const ascendingCompare = (a: number, b: number) => a - b;
    expect(quickSelect(arr.slice(), 0, ascendingCompare)).toBe(10);
    expect(quickSelect(arr.slice(), arr.length - 1, ascendingCompare)).toBe(50);
  });

  it('should handle arrays with duplicate values', () => {
    const arr = [5, 5, 5, 5, 5];
    
    // 全て同じ値
    expect(quickSelect(arr, 0)).toBe(5);
    expect(quickSelect(arr.slice(), 2)).toBe(5);
    expect(quickSelect(arr.slice(), 4)).toBe(5);
    
    // 重複を含む配列
    const arr2 = [1, 3, 3, 3, 5];
    expect(quickSelect(arr2, 0)).toBe(5);  // 最大値
    expect(quickSelect(arr2.slice(), 1)).toBe(3);  // 2番目に大きい値
    expect(quickSelect(arr2.slice(), 4)).toBe(1);  // 最小値
  });

  it('should work with custom comparison function for strings', () => {
    const arr = ['apple', 'banana', 'cherry', 'date'];
    const stringCompare = (a: string, b: string) => a.localeCompare(b);
    
    // 辞書順昇順
    expect(quickSelect(arr, 0, stringCompare)).toBe('apple');
    expect(quickSelect(arr.slice(), 1, stringCompare)).toBe('banana');
    expect(quickSelect(arr.slice(), 2, stringCompare)).toBe('cherry');
    expect(quickSelect(arr.slice(), 3, stringCompare)).toBe('date');
  });

  it('should modify array in-place', () => {
    const arr = [3, 1, 4, 1, 5, 9, 2, 6];
    const originalArr = arr.slice();
    
    const result = quickSelect(arr, 2);
    
    // 結果の検証
    expect(result).toBe(5);
    
    // 配列が変更されていることを確認
    expect(arr).not.toEqual(originalArr);
    
    // k番目の位置に正しい値があることを確認
    expect(arr[2]).toBe(5);
  });

  it('should handle single element array', () => {
    const arr = [42];
    
    expect(quickSelect(arr, 0)).toBe(42);
  });

  it('should handle two element array', () => {
    const arr = [10, 20];
    
    // 降順デフォルト
    expect(quickSelect(arr, 0)).toBe(20);
    expect(quickSelect(arr.slice(), 1)).toBe(10);
    
    // 昇順
    const ascendingCompare = (a: number, b: number) => a - b;
    expect(quickSelect(arr.slice(), 0, ascendingCompare)).toBe(10);
    expect(quickSelect(arr.slice(), 1, ascendingCompare)).toBe(20);
  });

  it('should work with typed arrays', () => {
    const arr = new Int32Array([7, 2, 9, 1, 5]);
    
    // デフォルト降順
    expect(quickSelect(arr, 0)).toBe(9);
    expect(quickSelect(arr.slice(), 1)).toBe(7);
    expect(quickSelect(arr.slice(), 4)).toBe(1);
  });

  it('should handle negative numbers', () => {
    const arr = [-5, -1, -10, 0, 3];
    
    // デフォルト降順
    expect(quickSelect(arr, 0)).toBe(3);    // 最大値
    expect(quickSelect(arr.slice(), 1)).toBe(0);     // 2番目に大きい値
    expect(quickSelect(arr.slice(), 4)).toBe(-10);   // 最小値
  });
})
