// Test bit polarity for FSK modulation/demodulation
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modulators/fsk';

describe('FSK Bit Polarity Test', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  test('verify FSK signal frequencies for known bits', () => {
    console.log('=== FSK Frequency Test ===');
    
    const config = fskCore.getConfig();
    console.log(`Mark frequency (bit 1): ${config.markFrequency}Hz`);
    console.log(`Space frequency (bit 0): ${config.spaceFrequency}Hz`);
    
    // Test single bit patterns
    const bit0Data = new Uint8Array([0x00]); // All zeros: 00000000
    const bit1Data = new Uint8Array([0xFF]); // All ones:  11111111
    
    const signal0 = fskCore.modulateData(bit0Data);
    const signal1 = fskCore.modulateData(bit1Data);
    
    console.log(`Signal for 0x00: ${signal0.length} samples`);
    console.log(`Signal for 0xFF: ${signal1.length} samples`);
    
    // Demodulate each and see what we get
    const result0 = fskCore.demodulateData(signal0);
    const result1 = fskCore.demodulateData(signal1);
    
    console.log(`Demodulated 0x00: [${Array.from(result0).map(x => '0x' + x.toString(16)).join(', ')}]`);
    console.log(`Demodulated 0xFF: [${Array.from(result1).map(x => '0x' + x.toString(16)).join(', ')}]`);
    
    // At least one should be successful
    expect(result0.length + result1.length).toBeGreaterThan(0);
  });
  
  test('test various patterns to identify the issue', () => {
    console.log('\n=== Pattern Analysis Test ===');
    
    const testCases = [
      { data: 0x48, desc: 'Known working case' },
      { data: 0x55, desc: 'Same as preamble - problematic' },
      { data: 0x7E, desc: 'Same as SFD - potentially problematic' },
      { data: 0xAA, desc: 'Inverted 0x55' },
      { data: 0x00, desc: 'All zeros' },
      { data: 0xFF, desc: 'All ones' },
      { data: 0x33, desc: 'Different pattern' }
    ];
    
    for (const testCase of testCases) {
      const testData = new Uint8Array([testCase.data]);
      const signal = fskCore.modulateData(testData);
      const result = fskCore.demodulateData(signal);
      
      console.log(`\nInput: 0x${testCase.data.toString(16).padStart(2, '0').toUpperCase()} (${testCase.desc})`);
      
      if (result.length > 0) {
        const output = result[0];
        console.log(`Output: 0x${output.toString(16).padStart(2, '0').toUpperCase()}`);
        
        if (output === testCase.data) {
          console.log('✅ Perfect match');
        } else {
          const inverted = (~output) & 0xFF;
          if (inverted === testCase.data) {
            console.log('🔄 Inverted (polarity issue)');
          } else {
            console.log(`❌ Different: expected 0x${testCase.data.toString(16).toUpperCase()}, got 0x${output.toString(16).toUpperCase()}`);
          }
        }
      } else {
        console.log('❌ No detection');
      }
    }
  });
});