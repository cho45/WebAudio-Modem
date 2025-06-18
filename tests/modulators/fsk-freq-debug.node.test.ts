// Debug test for different frequency pairs
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modulators/fsk';

describe('FSK Frequency Pair Debug', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
  });
  
  test('debug different frequency pairs', () => {
    const freqPairs = [
      { mark: 1650, space: 1850, name: 'default' },
      { mark: 2125, space: 2295, name: 'high-freq' }
    ];
    const originalData = new Uint8Array([0x48]);
    
    for (const frequencies of freqPairs) {
      console.log(`\n=== Testing ${frequencies.name} frequencies ===`);
      console.log(`Mark: ${frequencies.mark}Hz, Space: ${frequencies.space}Hz`);
      
      const config: FSKConfig = {
        ...DEFAULT_FSK_CONFIG,
        markFrequency: frequencies.mark,
        spaceFrequency: frequencies.space
      } as FSKConfig;
      
      fskCore.configure(config);
      
      const centerFreq = (frequencies.mark + frequencies.space) / 2;
      const freqSpan = Math.abs(frequencies.space - frequencies.mark);
      const adaptiveBandwidth = Math.max(config.preFilterBandwidth, freqSpan * 2.5);
      
      console.log(`Center frequency: ${centerFreq}Hz`);
      console.log(`Frequency span: ${freqSpan}Hz`);
      console.log(`Default bandwidth: ${config.preFilterBandwidth}Hz`);
      console.log(`Adaptive bandwidth: ${adaptiveBandwidth}Hz`);
      console.log(`Filter range: ${centerFreq - adaptiveBandwidth/2} - ${centerFreq + adaptiveBandwidth/2}Hz`);
      
      const signal = fskCore.modulateData(originalData);
      console.log(`Signal length: ${signal.length}`);
      
      const result = fskCore.demodulateData(signal);
      console.log(`Result length: ${result.length}`);
      console.log(`Result: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
      
      if (result.length > 0) {
        console.log(`✅ ${frequencies.name} frequencies: SUCCESS`);
      } else {
        console.log(`❌ ${frequencies.name} frequencies: FAILED`);
      }
    }
  });
});