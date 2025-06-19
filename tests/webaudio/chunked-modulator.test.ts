/**
 * ChunkedModulator Unit Tests
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ChunkedModulator } from '../../src/webaudio/chunked-modulator.js';
import type { FSKCore } from '../../src/modems/fsk.js';

describe('ChunkedModulator', () => {
  let mockFSKCore: FSKCore;
  let modulator: ChunkedModulator;
  
  beforeEach(() => {
    // Create mock FSKCore
    mockFSKCore = {
      modulateData: vi.fn().mockImplementation(async (data: Uint8Array) => {
        // Return mock signal proportional to input size
        return new Float32Array(data.length * 100);
      })
    } as any;
    
    modulator = new ChunkedModulator(mockFSKCore, { chunkSize: 4 });
  });
  
  test('should initialize correctly', () => {
    expect(modulator.isModulating()).toBe(false);
    expect(modulator.getProgress()).toBe(0);
  });
  
  test('should start modulation', () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    modulator.startModulation(testData);
    
    expect(modulator.isModulating()).toBe(true);
    expect(modulator.getProgress()).toBe(0);
  });
  
  test('should process chunks sequentially', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 8 bytes
    modulator.startModulation(testData);
    
    // First chunk (4 bytes)
    const result1 = await modulator.processNextChunk();
    expect(result1).not.toBeNull();
    expect(result1!.signal.length).toBe(400); // 4 bytes * 100 samples
    expect(result1!.isComplete).toBe(false);
    expect(result1!.position).toBe(4);
    expect(result1!.totalLength).toBe(8);
    expect(modulator.getProgress()).toBe(0.5);
    
    // Second chunk (4 bytes)
    const result2 = await modulator.processNextChunk();
    expect(result2).not.toBeNull();
    expect(result2!.signal.length).toBe(400); // 4 bytes * 100 samples
    expect(result2!.isComplete).toBe(true);
    expect(result2!.position).toBe(8);
    expect(modulator.getProgress()).toBe(0); // Reset after completion
    
    // No more chunks
    const result3 = await modulator.processNextChunk();
    expect(result3).toBeNull();
    
    expect(modulator.isModulating()).toBe(false);
  });
  
  test('should handle odd-sized data', async () => {
    const testData = new Uint8Array([1, 2, 3]); // 3 bytes
    modulator.startModulation(testData);
    
    // First chunk will be 3 bytes (smaller than chunkSize)
    const result = await modulator.processNextChunk();
    expect(result).not.toBeNull();
    expect(result!.signal.length).toBe(300); // 3 bytes * 100 samples
    expect(result!.isComplete).toBe(true);
    expect(result!.position).toBe(3);
    
    expect(modulator.isModulating()).toBe(false);
  });
  
  test('should call FSKCore.modulateData with correct chunks', async () => {
    const testData = new Uint8Array([10, 20, 30, 40, 50]);
    modulator.startModulation(testData);
    
    await modulator.processNextChunk();
    expect(mockFSKCore.modulateData).toHaveBeenCalledWith(
      new Uint8Array([10, 20, 30, 40])
    );
    
    await modulator.processNextChunk();
    expect(mockFSKCore.modulateData).toHaveBeenCalledWith(
      new Uint8Array([50])
    );
    
    expect(mockFSKCore.modulateData).toHaveBeenCalledTimes(2);
  });
  
  test('should handle empty data', async () => {
    const testData = new Uint8Array([]);
    modulator.startModulation(testData);
    
    const result = await modulator.processNextChunk();
    expect(result).toBeNull();
    expect(modulator.isModulating()).toBe(false);
  });
  
  test('should support cancellation', () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    modulator.startModulation(testData);
    
    expect(modulator.isModulating()).toBe(true);
    
    modulator.cancel();
    
    expect(modulator.isModulating()).toBe(false);
    expect(modulator.getProgress()).toBe(0);
  });
  
  test('should handle different chunk sizes', async () => {
    const largeChunkModulator = new ChunkedModulator(mockFSKCore, { chunkSize: 10 });
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    
    largeChunkModulator.startModulation(testData);
    
    // Should process all data in one chunk
    const result = await largeChunkModulator.processNextChunk();
    expect(result).not.toBeNull();
    expect(result!.isComplete).toBe(true);
    expect(result!.position).toBe(5);
    
    expect(mockFSKCore.modulateData).toHaveBeenCalledWith(testData);
  });
  
  test('should handle FSKCore errors', async () => {
    const errorFSKCore = {
      modulateData: vi.fn().mockRejectedValue(new Error('Modulation failed'))
    } as any;
    
    const errorModulator = new ChunkedModulator(errorFSKCore);
    const testData = new Uint8Array([1, 2, 3]);
    
    errorModulator.startModulation(testData);
    
    await expect(errorModulator.processNextChunk()).rejects.toThrow('Modulation failed');
  });
});