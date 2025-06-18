// Debug bit-level correlation sync
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modulators/fsk';

describe('FSK Bit-Level Debug', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  test('verify bit conversion', () => {
    const config = fskCore.getConfig();
    console.log('=== Bit Conversion Test ===');
    console.log(`Preamble bytes: [${config.preamblePattern.map(x => '0x' + x.toString(16)).join(', ')}]`);
    console.log(`SFD bytes: [${config.sfdPattern.map(x => '0x' + x.toString(16)).join(', ')}]`);
    
    // Test bit conversion function manually
    function byteToBits(byte: number): number[] {
      const bits: number[] = [];
      // MSB first (as used in communications)
      for (let i = 7; i >= 0; i--) {
        bits.push((byte >> i) & 1);
      }
      return bits;
    }
    
    // Check 0x55 conversion
    const bits55 = byteToBits(0x55);
    console.log(`0x55 -> bits: [${bits55.join(',')}]`);
    console.log(`Expected: [0,1,0,1,0,1,0,1] (MSB first)`);
    
    // Check 0x7E conversion  
    const bits7E = byteToBits(0x7E);
    console.log(`0x7E -> bits: [${bits7E.join(',')}]`);
    console.log(`Expected: [0,1,1,1,1,1,1,0] (MSB first)`);
    
    // Full pattern
    const allBits: number[] = [];
    for (const byte of config.preamblePattern) {
      allBits.push(...byteToBits(byte));
    }
    for (const byte of config.sfdPattern) {
      allBits.push(...byteToBits(byte));
    }
    
    console.log(`Full bit pattern: [${allBits.join(',')}]`);
    console.log(`Total bits: ${allBits.length}`);
  });
  
  test('debug correlation process', () => {
    console.log('\n=== Correlation Debug ===');
    
    const userData = new Uint8Array([0x48]);
    const signal = fskCore.modulateData(userData);
    
    console.log(`Generated signal length: ${signal.length}`);
    console.log(`Signal range: ${Math.min(...signal).toFixed(3)} to ${Math.max(...signal).toFixed(3)}`);
    
    // Try basic demodulation
    const result = fskCore.demodulateData(signal);
    console.log(`Demodulation result: ${result.length} bytes`);
    
    if (result.length === 0) {
      console.log('❌ No frames detected - correlation failing');
    } else {
      console.log(`✅ Success: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
    }
  });
  
  test('debug correlation template generation', () => {
    console.log('\n=== Template Generation Debug ===');
    
    const config = fskCore.getConfig();
    const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
    
    // Generate the same template as CorrelationSync would
    function byteToBits(byte: number): number[] {
      const bits: number[] = [];
      for (let i = 0; i < 8; i++) {
        bits.push((byte >> i) & 1);
      }
      return bits;
    }
    
    function bitsToFSKSignal(bits: number[], samplesPerBit: number): Float32Array {
      const totalSamples = bits.length * samplesPerBit;
      const signal = new Float32Array(totalSamples);
      let phase = 0;
      let sampleIndex = 0;
      
      for (const bit of bits) {
        const frequency = bit ? config.markFrequency : config.spaceFrequency;
        const omega = 2 * Math.PI * frequency / config.sampleRate;
        
        for (let i = 0; i < samplesPerBit; i++) {
          signal[sampleIndex++] = Math.sin(phase);
          phase += omega;
          if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        }
      }
      return signal;
    }
    
    // Generate preamble+SFD template WITH FRAMING (like actual signal)
    function encodeByteWithFraming(byte: number): number[] {
      const bits: number[] = [];
      
      // Start bits (0)
      for (let i = 0; i < config.startBits; i++) {
        bits.push(0);
      }
      
      // Data bits (MSB first)
      for (let i = 7; i >= 0; i--) {
        bits.push((byte >> i) & 1);
      }
      
      // Stop bits (1)
      for (let i = 0; i < config.stopBits; i++) {
        bits.push(1);
      }
      
      return bits;
    }
    
    const allBits: number[] = [];
    for (const byte of config.preamblePattern) {
      allBits.push(...encodeByteWithFraming(byte));
    }
    for (const byte of config.sfdPattern) {
      allBits.push(...encodeByteWithFraming(byte));
    }
    
    const template = bitsToFSKSignal(allBits, samplesPerBit);
    console.log(`Template: ${allBits.length} bits, ${template.length} samples`);
    console.log(`Template range: ${Math.min(...template).toFixed(3)} to ${Math.max(...template).toFixed(3)}`);
    
    // Now generate a test signal with preamble+SFD+data
    const userData = new Uint8Array([0x48]);
    const fullSignal = fskCore.modulateData(userData);
    console.log(`Full signal: ${fullSignal.length} samples`);
    
    // Extract beginning of signal for correlation test
    const signalStart = fullSignal.slice(0, template.length);
    
    // Manual correlation
    function correlation(sig1: Float32Array, sig2: Float32Array): number {
      let corr = 0;
      let power1 = 0;
      let power2 = 0;
      
      for (let i = 0; i < sig1.length && i < sig2.length; i++) {
        corr += sig1[i] * sig2[i];
        power1 += sig1[i] * sig1[i];
        power2 += sig2[i] * sig2[i];
      }
      
      return corr / Math.sqrt(power1 * power2);
    }
    
    const corrResult = correlation(signalStart, template);
    console.log(`Template vs signal start correlation: ${corrResult.toFixed(3)}`);
    
    if (corrResult > 0.6) {
      console.log('✅ Template matches signal start');
    } else {
      console.log('❌ Template does not match signal start');
      
      // Debug: check if bit patterns match
      console.log(`Expected bits: [${allBits.slice(0, 8).join(',')}...]`);
      
      // Also check framing difference
      console.log('Possible issue: Template uses raw bits, but signal uses framed bits');
    }
  });
});