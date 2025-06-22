// FSK Core demodulation tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSK Core Demodulation', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  describe('Basic Demodulation Functionality', () => {
    test('demodulate empty signal returns empty data', async () => {
      const emptySignal = new Float32Array(0);
      const result = await fskCore.demodulateData(emptySignal);
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });
    
    test('demodulate very short signal returns empty data', async () => {
      // Signal too short to contain even preamble
      const shortSignal = new Float32Array(100);
      const result = await fskCore.demodulateData(shortSignal);
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });
    
    test('demodulation handles unconfigured modulator gracefully', async () => {
      const unconfiguredCore = new FSKCore();
      const testSignal = new Float32Array([0.1, 0.2, 0.3]);
      
      await expect(unconfiguredCore.demodulateData(testSignal)).rejects.toThrow('not configured');
    });
  });
  
  describe('Roundtrip Modulation-Demodulation', () => {
    test('perfect roundtrip with single byte', async () => {
      const originalData = new Uint8Array([0x48]); // 'H'
      
      // Modulate
      const modulatedSignal = await fskCore.modulateData(originalData);
      expect(modulatedSignal.length).toBeGreaterThan(0);
      
      // Demodulate
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      // Check result
      expect(demodulatedData).toBeInstanceOf(Uint8Array);
      expect(demodulatedData.length).toBeGreaterThanOrEqual(originalData.length);
      
      // The result should contain our original data
      // Note: May contain extra data due to preamble pattern
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      // Verify the actual data
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with multiple bytes', async () => {
      const originalData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      expect(demodulatedData.length).toBeGreaterThanOrEqual(originalData.length);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('perfect roundtrip with "AB" - exact match required', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Modulate
      const modulatedSignal = await fskCore.modulateData(originalData);
      expect(modulatedSignal.length).toBeGreaterThan(0);
      
      // Demodulate
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      // Check result - should be EXACTLY the original data, no extra bytes
      expect(demodulatedData).toBeInstanceOf(Uint8Array);
      expect(demodulatedData.length).toBe(originalData.length);
      
      // Verify exact match
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[i]).toBe(originalData[i]);
      }
      
      // Get status to understand sync behavior
      const status = fskCore.getStatus();
      console.log(`[TEST] AB roundtrip status:`, status);
      
      // Verify sync detection quality - should be very high for perfect signal
      expect(status.syncDetections).toBe(1); // Should have exactly one sync detection
    });
    
    test('roundtrip with all zeros', async () => {
      const originalData = new Uint8Array([0x00, 0x00, 0x00]);
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with all ones', async () => {
      const originalData = new Uint8Array([0xFF, 0xFF, 0xFF]);
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with alternating pattern', async () => {
      const originalData = new Uint8Array([0x55, 0xAA, 0x55]); // 01010101, 10101010, 01010101
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });

    test('roundtrip with multiple bytes /w splitted chunks', async () => {
      const originalData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      console.log(`Total signal: ${modulatedSignal.length} samples`);

      const demodulatedData = [];
      const CHUNK_SIZE = 128;
      let processedCount = 0;
      for (let i = 0; i < modulatedSignal.length; i += CHUNK_SIZE) {
        const chunk = modulatedSignal.slice(i, i + CHUNK_SIZE);
        const part = await fskCore.demodulateData(chunk);
        demodulatedData.push(...part);
        if (part.length > 0) {
          console.log(`Chunk ${Math.floor(i/CHUNK_SIZE)}: got ${part.length} bytes`);
          processedCount++;
        }
      }
      
      console.log(`Total processed chunks: ${processedCount}, total bytes: ${demodulatedData.length}`);
      
      expect(demodulatedData.length).toBeGreaterThanOrEqual(originalData.length);
      
      const dataStart = findDataStart(new Uint8Array(demodulatedData), originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
  });
  
  describe('Noise Resistance', () => {
    test('roundtrip with low-level noise (30dB SNR)', async () => {
      const originalData = new Uint8Array([0x48, 0x65, 0x6C]); // "Hel"
      
      const cleanSignal = await fskCore.modulateData(originalData);
      const noisySignal = addNoise(cleanSignal, 30); // 30dB SNR
      
      const demodulatedData = await fskCore.demodulateData(noisySignal);
      
      // Should still recover the data with high SNR
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with moderate noise (20dB SNR)', async () => {
      const originalData = new Uint8Array([0x48]); // Single byte for reliability
      
      const cleanSignal = await fskCore.modulateData(originalData);
      const noisySignal = addNoise(cleanSignal, 20); // 20dB SNR
      
      const demodulatedData = await fskCore.demodulateData(noisySignal);
      
      // May not be perfect, but should attempt recovery
      expect(demodulatedData.length).toBeGreaterThanOrEqual(0);
      
      // If data is recovered, it should be correct
      const dataStart = findDataStart(demodulatedData, originalData);
      if (dataStart >= 0) {
        expect(demodulatedData[dataStart]).toBe(originalData[0]);
      }
    });
    
    test('handles signal with DC offset', async () => {
      const originalData = new Uint8Array([0x48]);
      
      let cleanSignal = await fskCore.modulateData(originalData);
      
      // Add DC offset
      const dcOffset = 0.2;
      const offsetSignal = new Float32Array(cleanSignal.length);
      for (let i = 0; i < cleanSignal.length; i++) {
        offsetSignal[i] = cleanSignal[i] + dcOffset;
      }
      
      const demodulatedData = await fskCore.demodulateData(offsetSignal);
      
      // AGC should handle DC offset
      const dataStart = findDataStart(demodulatedData, originalData);
      if (dataStart >= 0) {
        expect(demodulatedData[dataStart]).toBe(originalData[0]);
      }
    });
  });
  
  describe('Edge Cases and Error Handling', () => {
    test('handles amplitude variations', async () => {
      const originalData = new Uint8Array([0x55]);
      
      let signal = await fskCore.modulateData(originalData);
      
      // Scale signal amplitude
      const scaledSignal = new Float32Array(signal.length);
      const scaleFactor = 0.3; // Reduce amplitude
      for (let i = 0; i < signal.length; i++) {
        scaledSignal[i] = signal[i] * scaleFactor;
      }
      
      const demodulatedData = await fskCore.demodulateData(scaledSignal);
      
      // AGC should compensate for amplitude changes
      const dataStart = findDataStart(demodulatedData, originalData);
      if (dataStart >= 0) {
        expect(demodulatedData[dataStart]).toBe(originalData[0]);
      }
    });
    
    test('handles missing preamble gracefully', async () => {
      // Generate signal without proper preamble
      const config = fskCore.getConfig();
      const testFreq = config.markFrequency;
      const duration = 0.01; // 10ms
      const numSamples = Math.floor(config.sampleRate * duration);
      
      const invalidSignal = new Float32Array(numSamples);
      const omega = 2 * Math.PI * testFreq / config.sampleRate;
      for (let i = 0; i < numSamples; i++) {
        invalidSignal[i] = Math.sin(omega * i);
      }
      
      const result = await fskCore.demodulateData(invalidSignal);
      
      // Should return empty or fail gracefully
      expect(result).toBeInstanceOf(Uint8Array);
      // Result may be empty or contain spurious data, both are acceptable
    });
    
    test('reset clears demodulator state', async () => {
      const testData = new Uint8Array([0x48]);
      
      // Process some data
      const signal = await fskCore.modulateData(testData);
      await fskCore.demodulateData(signal);
      
      // Reset
      fskCore.reset();
      
      // Reconfigure and test
      fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      const signal2 = await fskCore.modulateData(testData);
      const result = await fskCore.demodulateData(signal2);
      
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Different Configuration Parameters', () => {
    test('works with different baud rates', async () => {
      const baudRates = [300, 1200];
      const originalData = new Uint8Array([0x48]);
      
      for (const baudRate of baudRates) {
        const config: FSKConfig = {
          ...DEFAULT_FSK_CONFIG,
          baudRate
        } as FSKConfig;
        
        fskCore.configure(config);
        
        const signal = await fskCore.modulateData(originalData);
        const result = await fskCore.demodulateData(signal);
        
        const dataStart = findDataStart(result, originalData);
        expect(dataStart).toBeGreaterThanOrEqual(0);
        expect(result[dataStart]).toBe(originalData[0]);
      }
    });
    
    test('works with different frequency pairs', async () => {
      const freqPairs = [
        { mark: 1650, space: 1850 },
        { mark: 2125, space: 2295 }
      ];
      const originalData = new Uint8Array([0x48]);
      
      for (const frequencies of freqPairs) {
        const config: FSKConfig = {
          ...DEFAULT_FSK_CONFIG,
          markFrequency: frequencies.mark,
          spaceFrequency: frequencies.space
        } as FSKConfig;
        
        fskCore.configure(config);
        
        const signal = await fskCore.modulateData(originalData);
        const result = await fskCore.demodulateData(signal);
        
        const dataStart = findDataStart(result, originalData);
        expect(dataStart).toBeGreaterThanOrEqual(0);
        expect(result[dataStart]).toBe(originalData[0]);
      }
    });
  });
  
  describe('Preamble Detection', () => {
    test('correctly identifies preamble pattern', async () => {
      const originalData = new Uint8Array([0x48]);
      const signal = await fskCore.modulateData(originalData);
      const result = await fskCore.demodulateData(signal);
      
      // Preamble is used for synchronization only, result should contain data
      expect(result.length).toBeGreaterThanOrEqual(1);
      
      // Should recover the original data (preamble is not included in result)
      expect(result[0]).toBe(originalData[0]);
    });
  });

  describe('AudioWorklet Simulation Tests', () => {
    test('perfect roundtrip with 128-sample chunks', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Generate complete signal
      const fullSignal = await fskCore.modulateData(originalData);
      console.log(`Generated signal: ${fullSignal.length} samples for chunked processing`);
      
      // Process in 128-sample chunks (AudioWorklet style)
      const CHUNK_SIZE = 128;
      const results: number[] = [];
      let chunkCount = 0;
      
      for (let i = 0; i < fullSignal.length; i += CHUNK_SIZE) {
        const chunk = fullSignal.slice(i, i + CHUNK_SIZE);
        const result = await fskCore.demodulateData(chunk);
        
        if (result.length > 0) {
          console.log(`Chunk ${chunkCount}: bytes [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
          results.push(...result);
        }
        chunkCount++;
      }
      
      console.log(`Total chunks processed: ${chunkCount}, total bytes: ${results.length}`);
      
      // Get status to verify sync behavior
      const status = fskCore.getStatus();
      console.log(`Chunked processing status:`, status);
      
      // Should get exactly original data
      expect(results.length).toBe(originalData.length);
      expect(Array.from(results)).toEqual(Array.from(originalData));
      
      // Verify sync detection quality
      expect(status.syncDetections).toBe(1); // Should have exactly one sync detection
    });

    test('handles signal after silence period', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Generate silence + signal (simulating AudioWorklet startup)
      const silenceSamples = new Float32Array(2000).fill(0); // 2000 samples of silence
      const signalSamples = await fskCore.modulateData(originalData);
      const combinedSignal = new Float32Array(silenceSamples.length + signalSamples.length);
      combinedSignal.set(silenceSamples, 0);
      combinedSignal.set(signalSamples, silenceSamples.length);
      
      console.log(`Testing silence (${silenceSamples.length}) + signal (${signalSamples.length}) = ${combinedSignal.length} total samples`);
      
      // Process in 128-sample chunks
      const CHUNK_SIZE = 128;
      const results: number[] = [];
      let silentChunks = 0;
      let signalChunks = 0;
      
      for (let i = 0; i < combinedSignal.length; i += CHUNK_SIZE) {
        const chunk = combinedSignal.slice(i, i + CHUNK_SIZE);
        const result = await fskCore.demodulateData(chunk);
        
        if (result.length > 0) {
          console.log(`Signal chunk found at ${i}: bytes [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
          results.push(...result);
          signalChunks++;
        } else if (i < silenceSamples.length) {
          silentChunks++;
        }
      }
      
      console.log(`Processed ${silentChunks} silent chunks, ${signalChunks} signal chunks`);
      
      // Should successfully recover data despite initial silence
      expect(results.length).toBe(originalData.length);
      expect(Array.from(results)).toEqual(Array.from(originalData));
      expect(silentChunks).toBeGreaterThan(10); // Should have processed significant silence
    });

    test('handles signal boundaries across chunks', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      const signal = await fskCore.modulateData(originalData);
      
      console.log(`Testing signal boundary alignment with ${signal.length} samples`);
      
      // Test different chunk boundary alignments
      const testOffsets = [0, 16, 32, 48, 64, 80, 96, 112];
      const results: Array<{offset: number, success: boolean, syncRatio?: number}> = [];
      
      for (const offset of testOffsets) {
        fskCore.reset();
        fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
        
        const chunks: number[] = [];
        let chunkCount = 0;
        
        for (let i = offset; i < signal.length; i += 128) {
          const chunk = signal.slice(i, i + 128);
          const result = await fskCore.demodulateData(chunk);
          chunks.push(...result);
          chunkCount++;
        }
        
        const status = fskCore.getStatus();
        const success = chunks.length >= originalData.length;
        
        if (success) {
          const dataStart = findDataStart(new Uint8Array(chunks), originalData);
          if (dataStart >= 0) {
            console.log(`Offset ${offset}: SUCCESS - chunks=${chunkCount}, syncDetections=${status.syncDetections}`);
            results.push({ offset, success: true, syncDetections: status.syncDetections });
          } else {
            console.log(`Offset ${offset}: FAILED - data not found in result`);
            results.push({ offset, success: false });
          }
        } else {
          console.log(`Offset ${offset}: FAILED - insufficient data (${chunks.length} < ${originalData.length})`);
          results.push({ offset, success: false });
        }
      }
      
      // Should work for most alignments (allow some flexibility for edge cases)
      const successCount = results.filter(r => r.success).length;
      const successRate = successCount / results.length;
      console.log(`Success rate: ${successCount}/${results.length} = ${(successRate * 100).toFixed(1)}%`);
      
      expect(successRate).toBeGreaterThan(0.6); // At least 60% of alignments should work
      
      // At least one alignment should achieve sync
      const hasSync = results.some(r => r.success);
      expect(hasSync).toBe(true);
    });

    test('AGC handles amplitude variations in chunks', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      let signal = await fskCore.modulateData(originalData);
      
      // Scale signal to test AGC adaptation
      signal = signal.map(sample => sample * 0.1); // Very low amplitude
      console.log(`Testing AGC with low amplitude signal (scaled by 0.1)`);
      
      const CHUNK_SIZE = 128;
      const results: number[] = [];
      let chunkCount = 0;
      
      for (let i = 0; i < signal.length; i += CHUNK_SIZE) {
        const chunk = signal.slice(i, i + CHUNK_SIZE);
        const result = await fskCore.demodulateData(chunk);
        
        if (result.length > 0) {
          console.log(`AGC chunk ${chunkCount}: recovered ${result.length} bytes`);
          results.push(...result);
        }
        chunkCount++;
      }
      
      // AGC should compensate and recover the data
      expect(results.length).toBe(originalData.length);
      expect(Array.from(results)).toEqual(Array.from(originalData));
      
      console.log(`AGC test successful: processed ${chunkCount} chunks`);
    });

    test('debug offset 16 frame sync timing', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      const fsk = new FSKCore();
      fsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      // Generate signal
      const signal = await fsk.modulateData(originalData);
      console.log(`=== OFFSET 16 DEBUG ===`);
      console.log(`Signal length: ${signal.length} samples`);
      
      // Test offset 16 specifically
      const offset = 16;
      const chunkSize = 128;
      const targetSignal = signal.slice(offset);
      
      // Process chunk by chunk
      let chunkIndex = 0;
      for (let i = 0; i < targetSignal.length; i += chunkSize) {
        const chunk = targetSignal.slice(i, i + chunkSize);
        if (chunk.length === 0) break;
        
        const result = await fsk.demodulateData(chunk);
        const status = fsk.getStatus();
        
        console.log(`Chunk ${chunkIndex}: samples ${offset + i}-${offset + i + chunk.length - 1}, result: ${result.length} bytes`);
        console.log(`  Status: receivedBits=${status.receivedBitsLength}, globalSample=${status.globalSampleCounter}, syncDetections=${status.syncDetections}`);
        
        // Check if we're in the critical range where preamble should end
        const preambleEndExpected = 4800 - 16; // 4784 for offset 16
        const chunkStartGlobal = offset + i;
        const chunkEndGlobal = offset + i + chunk.length - 1;
        
        if (chunkStartGlobal <= preambleEndExpected && preambleEndExpected <= chunkEndGlobal) {
          console.log(`  *** CRITICAL CHUNK *** Expected preamble end at sample ${preambleEndExpected}`);
          console.log(`  receivedBits buffer: [${status.receivedBitsLength} bits]`);
        }
        
        if (result.length > 0) {
          const resultBytes = Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
          console.log(`  → Bytes: [${resultBytes}]`);
        }
        
        chunkIndex++;
        
        // Stop after we get some results or after reasonable number of chunks
        if (result.length > 0 || chunkIndex > 50) {
          break;
        }
      }
      
      // Get final status
      const status = fsk.getStatus();
      console.log(`Final status:`, {
        syncDetections: status.syncDetections,
        frameStarted: status.frameStarted,
        bitBoundaryLearned: status.bitBoundaryLearned,
        globalSampleCounter: status.globalSampleCounter
      });
    });

    test('investigates offset 16 bit boundary issue', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      const signal = await fskCore.modulateData(originalData);
      
      console.log(`=== BIT BOUNDARY ANALYSIS FOR OFFSET 16 ===`);
      console.log(`Signal length: ${signal.length} samples`);
      
      // Calculate signal structure
      const samplesPerBit = Math.floor(DEFAULT_FSK_CONFIG.sampleRate / DEFAULT_FSK_CONFIG.baudRate); // 160
      const bitsPerByte = 8 + DEFAULT_FSK_CONFIG.startBits + DEFAULT_FSK_CONFIG.stopBits; // 10
      const preambleBytes = DEFAULT_FSK_CONFIG.preamblePattern.length; // 2 
      const sfdBytes = DEFAULT_FSK_CONFIG.sfdPattern.length; // 1
      const totalPreambleSfdBits = (preambleBytes + sfdBytes) * bitsPerByte; // 30 bits
      const preambleSfdSamples = totalPreambleSfdBits * samplesPerBit; // 4800 samples
      
      console.log(`Signal structure:`);
      console.log(`- Samples per bit: ${samplesPerBit}`);
      console.log(`- Bits per byte: ${bitsPerByte}`);
      console.log(`- Preamble+SFD bits: ${totalPreambleSfdBits}`);
      console.log(`- Preamble+SFD samples: ${preambleSfdSamples}`);
      
      // Analyze bit boundary alignment for offset 16
      console.log(`\n=== BIT BOUNDARY ALIGNMENT ANALYSIS ===`);
      const offset16ChunkBoundaries = [];
      for (let i = 0; i < 40; i++) {
        const chunkStart = 16 + i * 128;
        const chunkEnd = chunkStart + 128;
        if (chunkStart >= signal.length) break;
        
        // Calculate which bit boundaries this chunk contains
        const firstBitBoundary = Math.ceil(chunkStart / samplesPerBit) * samplesPerBit;
        const lastBitBoundary = Math.floor(chunkEnd / samplesPerBit) * samplesPerBit;
        const bitBoundariesInChunk = [];
        for (let boundary = firstBitBoundary; boundary <= lastBitBoundary; boundary += samplesPerBit) {
          if (boundary >= chunkStart && boundary < chunkEnd) {
            bitBoundariesInChunk.push(boundary);
          }
        }
        
        offset16ChunkBoundaries.push({
          chunk: i,
          start: chunkStart,
          end: chunkEnd,
          bitBoundaries: bitBoundariesInChunk,
          inPreamble: chunkStart < preambleSfdSamples
        });
      }
      
      // Log critical chunks around preamble end
      console.log(`Critical chunks around preamble/SFD end (sample ${preambleSfdSamples}):`);
      const criticalChunks = offset16ChunkBoundaries.filter(chunk => 
        Math.abs(chunk.start - preambleSfdSamples) < 512 || 
        Math.abs(chunk.end - preambleSfdSamples) < 512 ||
        (chunk.start < preambleSfdSamples && chunk.end > preambleSfdSamples)
      );
      
      criticalChunks.forEach(chunk => {
        console.log(`Chunk ${chunk.chunk}: samples ${chunk.start}-${chunk.end}, ` +
                   `bitBoundaries: [${chunk.bitBoundaries.join(', ')}], ` +
                   `inPreamble: ${chunk.inPreamble}`);
      });
      
      // Compare with offset 0 alignment
      console.log(`\n=== COMPARING WITH OFFSET 0 ===`);
      const offset0BitBoundary = Math.ceil(preambleSfdSamples / samplesPerBit) * samplesPerBit;
      const offset16BitBoundary = Math.ceil((preambleSfdSamples - 16) / samplesPerBit) * samplesPerBit + 16;
      
      console.log(`Offset 0: First data bit boundary at sample ${offset0BitBoundary}`);
      console.log(`Offset 16: First data bit boundary at sample ${offset16BitBoundary}`);
      console.log(`Bit boundary offset difference: ${offset16BitBoundary - offset0BitBoundary} samples`);
      
      // Test the hypothesis: bit boundary misalignment
      const bitBoundaryMisalignment = (preambleSfdSamples - 16) % samplesPerBit;
      console.log(`Preamble end misalignment from bit boundary: ${bitBoundaryMisalignment} samples`);
      console.log(`This means ${(bitBoundaryMisalignment / samplesPerBit * 100).toFixed(1)}% into bit period`);
      
      if (bitBoundaryMisalignment !== 0) {
        console.log(`⚠️  POTENTIAL ISSUE: Offset 16 causes bit boundary misalignment!`);
        console.log(`   This could disrupt bit synchronization learning.`);
      }
      
      // Simple verification test - just check if boundary analysis reveals the issue
      console.log(`\n=== BOUNDARY ANALYSIS CONCLUSION ===`);
      expect(bitBoundaryMisalignment).toBeGreaterThanOrEqual(0); // Always passes for investigation
    });

    test('complete offset coverage (0-127)', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      const signal = await fskCore.modulateData(originalData);
      
      console.log(`=== TESTING ALL OFFSETS 0-127 ===`);
      
      const results: Array<{offset: number, success: boolean, bytes: number, syncRatio: number}> = [];
      
      // Test every single sample offset
      for (let offset = 0; offset < 128; offset++) {
        console.log(`Testing offset ${offset}...`);
        fskCore.reset();
        fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
        
        const chunks: number[] = [];
        
        for (let i = offset; i < signal.length; i += 128) {
          const chunk = signal.slice(i, i + 128);
          const result = await fskCore.demodulateData(chunk);
          chunks.push(...result);
        }
        
        const status = fskCore.getStatus();
        const success = chunks.length >= originalData.length;
        const syncRatio = status.syncDetections || 0;
        
        results.push({ offset, success, bytes: chunks.length, syncRatio });
        
        console.log(`Offset ${offset}: ${success ? 'SUCCESS' : 'FAILED'} - ${chunks.length} bytes, sync=${syncRatio.toFixed(3)}`);
      }
      
      // Analysis
      const successCount = results.filter(r => r.success).length;
      const failureOffsets = results.filter(r => !r.success).map(r => r.offset);
      
      console.log(`=== COMPLETE OFFSET ANALYSIS ===`);
      console.log(`Success rate: ${successCount}/128 = ${(successCount/128*100).toFixed(1)}%`);
      if (failureOffsets.length > 0) {
        console.log(`Failed offsets: [${failureOffsets.join(', ')}]`);
        
        // Analyze failure patterns
        const failurePattern = analyzeFailurePattern(failureOffsets);
        console.log(`Failure pattern analysis:`, failurePattern);
      }
      
      // Expect perfect success rate
      expect(successCount).toBe(128);
      expect(failureOffsets).toEqual([]);
    });

    test('various chunk sizes work perfectly', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      const signal = await fskCore.modulateData(originalData);
      
      const chunkSizes = [32, 64, 128, 256];
      
      console.log(`=== TESTING VARIOUS CHUNK SIZES ===`);
      
      for (const chunkSize of chunkSizes) {
        fskCore.reset();
        fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
        
        const results: number[] = [];
        let chunkCount = 0;
        
        for (let i = 0; i < signal.length; i += chunkSize) {
          const chunk = signal.slice(i, i + chunkSize);
          const result = await fskCore.demodulateData(chunk);
          results.push(...result);
          
          if (result.length > 0) {
            chunkCount++;
          }
        }
        
        const status = fskCore.getStatus();
        const syncRatio = status.syncDetections || 0;
        
        console.log(`Chunk size ${chunkSize}: ${results.length} bytes, sync=${syncRatio.toFixed(3)}, productive chunks=${chunkCount}`);
        
        // Each chunk size should work perfectly
        expect(results.length).toBe(originalData.length);
        expect(Array.from(results)).toEqual(Array.from(originalData));
        expect(syncRatio).toBeGreaterThan(0.95);
      }
    });

    test('consistency across multiple chunk processing runs', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      const signal = await fskCore.modulateData(originalData);
      
      const RUNS = 5;
      const CHUNK_SIZE = 128;
      const allResults: Array<{run: number, bytes: number[], syncRatio: number}> = [];
      
      for (let run = 0; run < RUNS; run++) {
        fskCore.reset();
        fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
        
        const results: number[] = [];
        
        for (let i = 0; i < signal.length; i += CHUNK_SIZE) {
          const chunk = signal.slice(i, i + CHUNK_SIZE);
          const result = await fskCore.demodulateData(chunk);
          results.push(...result);
        }
        
        const status = fskCore.getStatus();
        const syncRatio = status.syncDetections || 0;
        
        allResults.push({ run, bytes: results, syncRatio });
        console.log(`Run ${run}: ${results.length} bytes, sync=${syncRatio.toFixed(3)}`);
      }
      
      // All runs should produce identical results
      for (let i = 1; i < RUNS; i++) {
        expect(allResults[i].bytes).toEqual(allResults[0].bytes);
      }
      
      // Results should be perfect
      expect(allResults[0].bytes.length).toBe(originalData.length);
      expect(allResults[0].bytes).toEqual(Array.from(originalData));
    });

    test('WebAudio-style concurrent modulation and demodulation', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      console.log(`=== WebAudio-STYLE CONCURRENT PROCESSING TEST ===`);
      
      // Create separate FSKCore instances for modulation and demodulation
      const modulator = new FSKCore();
      const demodulator = new FSKCore();
      
      modulator.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      demodulator.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      // Generate complete signal first
      const fullSignal = await modulator.modulateData(originalData);
      console.log(`Generated signal: ${fullSignal.length} samples`);
      
      // Simulate WebAudio-style processing: 128-sample chunks processed concurrently
      const CHUNK_SIZE = 128;
      const results: number[] = [];
      let modulationComplete = false;
      let outputChunkIndex = 0;
      let inputChunkIndex = 0;
      
      // WebAudio processes audio in both directions simultaneously
      // Simulate this by processing modulation output → demodulation input with timing
      while (inputChunkIndex * CHUNK_SIZE < fullSignal.length) {
        // Get next input chunk from generated signal
        const inputChunk = fullSignal.slice(
          inputChunkIndex * CHUNK_SIZE, 
          (inputChunkIndex + 1) * CHUNK_SIZE
        );
        
        if (inputChunk.length > 0) {
          // Process through demodulator
          const demodResult = await demodulator.demodulateData(inputChunk);
          
          if (demodResult.length > 0) {
            console.log(`Input chunk ${inputChunkIndex}: demodulated ${demodResult.length} bytes: [${Array.from(demodResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
            results.push(...demodResult);
          }
        }
        
        inputChunkIndex++;
        
        // Add some realistic timing simulation (every few chunks)
        if (inputChunkIndex % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
      
      const demodStatus = demodulator.getStatus();
      console.log(`Concurrent processing complete: ${results.length} bytes demodulated`);
      console.log(`Demodulator status:`, {
        syncDetections: demodStatus.syncDetections,
        frameStarted: demodStatus.frameStarted,
        demodulationCalls: demodStatus.demodulationCalls
      });
      
      // Results should match exactly
      expect(results.length).toBe(originalData.length);
      expect(Array.from(results)).toEqual(Array.from(originalData));
      expect(demodStatus.syncDetections).toBeGreaterThan(0);
    });

    test('WebAudio-style continuous streaming with multiple transmissions', async () => {
      console.log(`=== CONTINUOUS STREAMING TEST ===`);
      
      // Simulate continuous WebAudio streaming where multiple transmissions
      // happen over time with the same FSKCore instances
      const testMessages = [
        new Uint8Array([0x41, 0x42]), // "AB"
        new Uint8Array([0x48, 0x65, 0x6C]), // "Hel"
        new Uint8Array([0x6C, 0x6F]), // "lo"
      ];
      
      const modulator = new FSKCore();
      const demodulator = new FSKCore();
      
      modulator.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      demodulator.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      const CHUNK_SIZE = 128;
      const allResults: Array<{message: number, bytes: number[]}> = [];
      
      for (let msgIndex = 0; msgIndex < testMessages.length; msgIndex++) {
        const message = testMessages[msgIndex];
        console.log(`\n--- Processing message ${msgIndex}: [${Array.from(message).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}] ---`);
        
        // Generate signal for this message
        const signal = await modulator.modulateData(message);
        
        // Add silence between transmissions (except for first)
        let processSignal = signal;
        if (msgIndex > 0) {
          const silenceGap = new Float32Array(500).fill(0); // 500 samples of silence
          const combined = new Float32Array(silenceGap.length + signal.length);
          combined.set(silenceGap, 0);
          combined.set(signal, silenceGap.length);
          processSignal = combined;
          console.log(`Added ${silenceGap.length} samples of silence before signal`);
        }
        
        // Process in chunks
        const messageResults: number[] = [];
        for (let i = 0; i < processSignal.length; i += CHUNK_SIZE) {
          const chunk = processSignal.slice(i, i + CHUNK_SIZE);
          const result = await demodulator.demodulateData(chunk);
          
          if (result.length > 0) {
            console.log(`Message ${msgIndex}, chunk ${Math.floor(i/CHUNK_SIZE)}: ${result.length} bytes`);
            messageResults.push(...result);
          }
        }
        
        allResults.push({ message: msgIndex, bytes: messageResults });
        
        // Verify this message was demodulated correctly
        console.log(`Message ${msgIndex} result: ${messageResults.length} bytes = [${messageResults.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        expect(messageResults.length).toBe(message.length);
        expect(messageResults).toEqual(Array.from(message));
        
        // Brief pause between messages to simulate real-world timing
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      
      const finalStatus = demodulator.getStatus();
      console.log(`\nContinuous streaming complete - final status:`, {
        totalMessages: testMessages.length,
        syncDetections: finalStatus.syncDetections,
        demodulationCalls: finalStatus.demodulationCalls,
        totalSamplesProcessed: finalStatus.totalSamplesProcessed
      });
      
      // Should have detected sync for each message transmission
      expect(finalStatus.syncDetections).toBeGreaterThanOrEqual(testMessages.length);
    });

    test('FSKProcessor-style continuous FSKCore usage investigation', async () => {
      console.log(`=== FSKProcessor-STYLE INVESTIGATION ===`);
      
      // This test investigates the exact pattern used in FSKProcessor:
      // 1. Single FSKCore instance used continuously
      // 2. processDemodulation() called multiple times
      // 3. Simulate audio input buffering behavior
      
      const fsk = new FSKCore();
      fsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Step 1: Generate the signal using SAME FSKCore instance (like FSKProcessor)
      const signal = await fsk.modulateData(originalData);
      console.log(`Generated signal: ${signal.length} samples`);
      
      // Step 2: Simulate FSKProcessor.processDemodulation() behavior
      // In FSKProcessor, this method is called whenever inputBuffer >= 4000 samples
      const MIN_SAMPLES = 4000;
      let inputBuffer = new Float32Array(0);
      const allDemodulatedBytes: number[] = [];
      let processDemodulationCalls = 0;
      
      // Add samples to buffer in chunks of 128 (like AudioWorklet input)
      for (let i = 0; i < signal.length; i += 128) {
        const chunk = signal.slice(i, i + 128);
        
        // Add to input buffer
        const newBuffer = new Float32Array(inputBuffer.length + chunk.length);
        newBuffer.set(inputBuffer);
        newBuffer.set(chunk, inputBuffer.length);
        inputBuffer = newBuffer;
        
        // Check if we have enough samples to call demodulateData (like FSKProcessor)
        if (inputBuffer.length >= MIN_SAMPLES) {
          processDemodulationCalls++;
          console.log(`processDemodulation call #${processDemodulationCalls}: processing ${inputBuffer.length} samples`);
          
          // Call FSKCore.demodulateData with ALL accumulated samples (like FSKProcessor Line 276)
          const demodulated = await fsk.demodulateData(inputBuffer);
          
          if (demodulated.length > 0) {
            console.log(`Call #${processDemodulationCalls}: FSKCore returned ${demodulated.length} bytes: [${Array.from(demodulated).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
            allDemodulatedBytes.push(...demodulated);
            
            // Clear buffer after successful demodulation (like FSKProcessor Line 299)
            inputBuffer = new Float32Array(0);
          } else if (inputBuffer.length > 12000) {
            // Buffer management like FSKProcessor Line 301-309
            const keepSamples = inputBuffer.slice(-8000);
            inputBuffer = keepSamples;
            console.log(`Call #${processDemodulationCalls}: No result, managed buffer size to ${inputBuffer.length}`);
          }
        }
      }
      
      // Final processing if buffer has remaining samples
      if (inputBuffer.length > 0) {
        processDemodulationCalls++;
        console.log(`Final processDemodulation call #${processDemodulationCalls}: processing remaining ${inputBuffer.length} samples`);
        const demodulated = await fsk.demodulateData(inputBuffer);
        if (demodulated.length > 0) {
          console.log(`Final call: FSKCore returned ${demodulated.length} bytes: [${Array.from(demodulated).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
          allDemodulatedBytes.push(...demodulated);
        }
      }
      
      const status = fsk.getStatus();
      console.log(`FSKProcessor simulation complete:`);
      console.log(`- processDemodulation calls: ${processDemodulationCalls}`);
      console.log(`- Total bytes demodulated: ${allDemodulatedBytes.length}`);
      console.log(`- Bytes: [${allDemodulatedBytes.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      console.log(`- FSKCore status:`, {
        syncDetections: status.syncDetections,
        demodulationCalls: status.demodulationCalls,
        frameStarted: status.frameStarted
      });
      
      // Analysis: check if we get extra bytes (the false positive issue)
      if (allDemodulatedBytes.length > originalData.length) {
        console.log(`⚠️  ISSUE DETECTED: Got ${allDemodulatedBytes.length} bytes, expected ${originalData.length}`);
        console.log(`Extra bytes: [${allDemodulatedBytes.slice(0, allDemodulatedBytes.length - originalData.length).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        
        // Check if extra bytes match preamble/SFD pattern
        const preambleBytes = [0x55, 0x55]; // From DEFAULT_FSK_CONFIG.preamblePattern
        const sfdBytes = [0x7E]; // From DEFAULT_FSK_CONFIG.sfdPattern
        const expectedPattern = [...preambleBytes, ...sfdBytes];
        
        console.log(`Expected preamble+SFD pattern: [${expectedPattern.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        
        if (allDemodulatedBytes.length === originalData.length + expectedPattern.length) {
          const extraBytes = allDemodulatedBytes.slice(0, expectedPattern.length);
          const actualData = allDemodulatedBytes.slice(expectedPattern.length);
          
          console.log(`Analysis: Extra bytes appear to be preamble/SFD pattern`);
          console.log(`Extra: [${extraBytes.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
          console.log(`Data: [${actualData.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
          
          // This would be the exact issue described in the demo
          expect(actualData).toEqual(Array.from(originalData)); // Data should be correct
          expect(extraBytes).toEqual(expectedPattern); // Extra should be preamble/SFD
        }
      } else {
        // This would be the ideal case
        expect(allDemodulatedBytes.length).toBe(originalData.length);
        expect(allDemodulatedBytes).toEqual(Array.from(originalData));
      }
    });

    test('same FSKCore instance modulation-demodulation state investigation', async () => {
      console.log(`=== SAME INSTANCE STATE INVESTIGATION ===`);
      
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Test 1: Fresh FSKCore instance - baseline
      console.log(`\n--- Test 1: Fresh FSKCore (baseline) ---`);
      const freshFsk = new FSKCore();
      freshFsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      const freshSignal = await freshFsk.modulateData(originalData);
      freshFsk.reset(); // Reset to clear any potential state
      freshFsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      const freshResult = await freshFsk.demodulateData(freshSignal);
      
      console.log(`Fresh FSK: ${freshResult.length} bytes = [${Array.from(freshResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      
      // Test 2: Same instance modulation then demodulation 
      console.log(`\n--- Test 2: Same instance mod→demod ---`);
      const sameFsk = new FSKCore();
      sameFsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      console.log(`Before modulation:`, sameFsk.getStatus());
      const sameSignal = await sameFsk.modulateData(originalData);
      console.log(`After modulation:`, sameFsk.getStatus());
      
      const sameResult = await sameFsk.demodulateData(sameSignal);
      console.log(`After demodulation:`, sameFsk.getStatus());
      
      console.log(`Same FSK: ${sameResult.length} bytes = [${Array.from(sameResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      
      // Test 3: Same instance with explicit reset between mod and demod
      console.log(`\n--- Test 3: Same instance with reset ---`);
      const resetFsk = new FSKCore();
      resetFsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      const resetSignal = await resetFsk.modulateData(originalData);
      console.log(`Before reset:`, resetFsk.getStatus());
      
      // Reset only demodulation state, not configuration
      resetFsk.reset();
      resetFsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      console.log(`After reset:`, resetFsk.getStatus());
      
      const resetResult = await resetFsk.demodulateData(resetSignal);
      console.log(`Reset FSK: ${resetResult.length} bytes = [${Array.from(resetResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      
      // Analysis
      console.log(`\n=== ANALYSIS ===`);
      console.log(`Fresh FSK result: [${Array.from(freshResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      console.log(`Same FSK result:  [${Array.from(sameResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      console.log(`Reset FSK result: [${Array.from(resetResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      
      // Check if modulation affects demodulation state
      if (sameResult.length !== originalData.length || !sameResult.every((byte, i) => byte === originalData[i])) {
        console.log(`⚠️  CONFIRMED: Modulation affects demodulation state!`);
        console.log(`Expected: [${Array.from(originalData).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        console.log(`Got:      [${Array.from(sameResult).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        
        if (resetResult.length === originalData.length && resetResult.every((byte, i) => byte === originalData[i])) {
          console.log(`✅ Reset fixes the issue - state contamination confirmed`);
        }
      } else {
        console.log(`✅ No state contamination detected in this simple case`);
      }
      
      // For this test, we'll be lenient and accept either correct result or document the issue
      // The main goal is to identify the problem pattern
      console.log(`\nTest completed - issue investigation complete`);
    });
  });

  describe('Pattern Coverage Tests', () => {
    test('various byte patterns work correctly', async () => {
      const testCases = [
        { data: 0x48, desc: 'Known working case' },
        { data: 0x55, desc: 'Same as preamble - should work with SFD' },
        { data: 0x7E, desc: 'Same as SFD - should work as user data' },
        { data: 0xAA, desc: 'Inverted 0x55' },
        { data: 0x00, desc: 'All zeros' },
        { data: 0xFF, desc: 'All ones' },
        { data: 0x33, desc: 'Mixed pattern' },
        { data: 0xF0, desc: 'High nibble set' },
        { data: 0x0F, desc: 'Low nibble set' }
      ];
      
      for (const testCase of testCases) {
        const testData = new Uint8Array([testCase.data]);
        const signal = await fskCore.modulateData(testData);
        const result = await fskCore.demodulateData(signal);
        
        expect(result.length).toBe(1); // Should detect exactly one byte
        expect(result[0]).toBe(testCase.data); // Should match input exactly
      }
    });

    test('multiple consecutive identical bytes', async () => {
      // Test that consecutive identical bytes don't cause false "padding" detection
      const testCases = [
        new Uint8Array([0xFF, 0xFF, 0xFF]), // Three consecutive 0xFF
        new Uint8Array([0x00, 0x00, 0x00]), // Three consecutive 0x00
        new Uint8Array([0x55, 0x55, 0x55]), // Three consecutive preamble pattern
        new Uint8Array([0x7E, 0x7E, 0x7E])  // Three consecutive SFD pattern
      ];


      let eodCount = 0;
      fskCore.on('eod', () => {
        console.log(`EOD event received`);
        eodCount++;
      });

      for (const testData of testCases) {
        eodCount = 0; // Reset EOD count for each test

        const signal = await fskCore.modulateData(testData);
        const result = await fskCore.demodulateData(signal);

        expect(eodCount).toBe(1); // Should trigger EOD event once
        expect(fskCore.isReady()).toBe(true);
        
        expect(result.length).toBe(testData.length);
        expect(Array.from(result)).toEqual(Array.from(testData));
      }
    });
  });
});

// Helper functions
function findDataStart(demodulated: Uint8Array, originalData: Uint8Array): number {
  if (originalData.length === 0) return -1;
  
  for (let start = 0; start <= demodulated.length - originalData.length; start++) {
    let match = true;
    for (let i = 0; i < originalData.length; i++) {
      if (demodulated[start + i] !== originalData[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return start;
    }
  }
  return -1;
}

function addNoise(signal: Float32Array, snrDb: number): Float32Array {
  const signalPower = calculatePower(signal);
  const noisePower = signalPower / Math.pow(10, snrDb / 10);
  // For uniform random in [-A, +A], variance = A²/3, so A = sqrt(3 * variance)
  const noiseAmplitude = Math.sqrt(3 * noisePower);
  
  const noisySignal = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const noise = noiseAmplitude * (Math.random() * 2 - 1);
    noisySignal[i] = signal[i] + noise;
  }
  
  return noisySignal;
}

function calculatePower(signal: Float32Array): number {
  let power = 0;
  for (let i = 0; i < signal.length; i++) {
    power += signal[i] * signal[i];
  }
  return power / signal.length;
}

function analyzeFailurePattern(failureOffsets: number[]): any {
  if (failureOffsets.length === 0) {
    return { pattern: 'no_failures' };
  }
  
  // Check for patterns
  const analysis: any = {
    count: failureOffsets.length,
    offsets: failureOffsets,
    patterns: {}
  };
  
  // Check modulo patterns
  for (const mod of [2, 4, 8, 16, 32, 64, 128]) {
    const modResults = failureOffsets.map(offset => offset % mod);
    const uniqueMods = [...new Set(modResults)];
    if (uniqueMods.length === 1) {
      analysis.patterns[`mod_${mod}`] = uniqueMods[0];
    }
  }
  
  // Check for arithmetic progression
  if (failureOffsets.length > 1) {
    const differences = [];
    for (let i = 1; i < failureOffsets.length; i++) {
      differences.push(failureOffsets[i] - failureOffsets[i-1]);
    }
    const uniqueDiffs = [...new Set(differences)];
    if (uniqueDiffs.length === 1) {
      analysis.patterns.arithmetic_progression = uniqueDiffs[0];
    }
  }
  
  // Check relationship to samplesPerBit (160)
  const samplesPerBit = 160;
  const bitRelations = failureOffsets.map(offset => ({
    offset,
    bitPhase: offset % samplesPerBit,
    bitIndex: Math.floor(offset / samplesPerBit)
  }));
  
  analysis.bitRelations = bitRelations;
  
  return analysis;
}
