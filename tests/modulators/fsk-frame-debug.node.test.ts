// Debug frame decoding for specific cases
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modulators/fsk';

describe('FSK Frame Debug', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  test('debug 0xAA working case', () => {
    console.log('\n=== 0xAA Debug (Working Case) ===');
    
    const testData = new Uint8Array([0xAA]);
    const signal = fskCore.modulateData(testData);
    const result = fskCore.demodulateData(signal);
    
    console.log(`Input: 0xAA`);
    console.log(`Output: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
  });
  
  test('debug 0x00 failing case', () => {
    console.log('\n=== 0x00 Debug (Failing Case) ===');
    
    const testData = new Uint8Array([0x00]);
    const signal = fskCore.modulateData(testData);
    const result = fskCore.demodulateData(signal);
    
    console.log(`Input: 0x00`);
    console.log(`Output: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
  });
  
  test('debug 0x48 partial case', () => {
    console.log('\n=== 0x48 Debug (Partial Working) ===');
    
    const testData = new Uint8Array([0x48]);
    const signal = fskCore.modulateData(testData);
    const result = fskCore.demodulateData(signal);
    
    console.log(`Input: 0x48`);
    console.log(`Output: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
  });
});