import { describe, it, expect, beforeEach } from 'vitest'
import { RingBuffer } from '../src/utils'

describe('RingBuffer', () => {
  let buffer: RingBuffer

  beforeEach(() => {
    buffer = new RingBuffer(4)
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
    const smallBuffer = new RingBuffer(1)
    
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
})