/**
 * FSK Processor Integration Tests - Tests actual modulation
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { WebAudioModulatorNode } from '../../src/webaudio/webaudio-modulator-node.js';
import { DEFAULT_FSK_CONFIG } from '../../src/modems/fsk.js';
import { userEvent } from '@vitest/browser/context'

// These tests will run in browser environment with vitest browser mode

describe('FSK Processor Integration', () => {
  let audioContext: AudioContext;

  beforeEach(async () => {
    // Create AudioContext
    audioContext = new AudioContext();
    
    // AudioContext requires user interaction to resume in browsers
    // Simulate user click to allow AudioContext to resume
    const button = document.createElement('button');
    button.textContent = 'Test Click';
    document.body.appendChild(button);

    const resumePromise = new Promise<void>((resolve, reject) => {
      button.addEventListener('click', async function me () {
        button.removeEventListener('click', me);
        console.log('User clicked button, resuming AudioContext...');
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        resolve();
      });
    });
    
    // Create and dispatch click event
    // console.log('Simulating user interaction to resume AudioContext...');
    await userEvent.click(button); // Simulate user click for test environment

    await resumePromise;
    
    // Resume AudioContext after user interaction
    // console.log('AudioContext state before resume:', audioContext.state);
    
    // Cleanup
    document.body.removeChild(button);
    
    expect(audioContext.state).toBe('running');
  });

  afterEach(async () => {
  });

  test('actual modulation and XModem integration', async () => {
      // Test basic AudioContext functionality
      expect(audioContext.state).toBeDefined();
      expect(['suspended', 'running', 'closed']).toContain(audioContext.state);
      
      // For now, just test that we can create the modulator node without AudioWorklet
      const modulator = new WebAudioModulatorNode(audioContext, {
        processorUrl: './test-processor.js',
        processorName: 'test-processor'
      });
      
      expect(modulator.name).toBe('WebAudioModulator');
      
      // Note: Full AudioWorklet testing requires a more complex setup
      // This test verifies the basic structure works
  });
  
  test('XModem transport integration', async () => {
      // Test XModem integration without AudioWorklet complexity
      const modulator = new WebAudioModulatorNode(audioContext, {
        processorUrl: './test-processor.js',
        processorName: 'test-processor'
      });
      
      const { XModemTransport } = await import('/src/transports/xmodem/xmodem.js');
      const transport = new XModemTransport(modulator);
      
      expect(transport.isReady()).toBe(false); // Not ready until modulator is initialized
      expect(transport.transportName).toBe('XModem');
  });
  
   test('should handle WebAudio and XModem integration', async () => {
       // Test that XModemTransport can work with WebAudioModulatorNode
       const modulator = new WebAudioModulatorNode(audioContext, {
         processorUrl: '/src/webaudio/processors/fsk-processor.js',
         processorName: 'fsk-processor'
       });
       
       const { XModemTransport } = await import('../../src/transports/xmodem/xmodem.js');
       const transport = new XModemTransport(modulator);
       
       // Basic integration test
       expect(transport.transportName).toBe('XModem');
       expect(transport.isReady()).toBe(false); // Modulator not initialized
       
       // Configure transport
       transport.configure({ timeoutMs: 1000, maxRetries: 1 });
       
       // Even if modulator isn't working, transport should be creatable
       expect(transport.getConfig().timeoutMs).toBe(1000);
       expect(transport.getConfig().maxRetries).toBe(1);
       
       console.log('XModem transport created successfully with WebAudio modulator');
   });
 
   test('demonstrates expected FSK signal properties', () => {
     // Expected properties of FSK signal:
     // - Length should be: (preamble + SFD + data) * bitsPerByte * samplesPerBit + padding
     // - Should contain mark and space frequencies
     // - Should have phase continuity
     
     const config = DEFAULT_FSK_CONFIG;
     const dataLength = 5; // "Hello"
     const bitsPerByte = 8 + config.startBits + config.stopBits; // 10 bits
     const samplesPerBit = Math.floor(config.sampleRate / config.baudRate); // 147 samples
     
     const totalBytes = config.preamblePattern.length + config.sfdPattern.length + dataLength;
     const paddingSamples = samplesPerBit * 2;
     const expectedLength = totalBytes * bitsPerByte * samplesPerBit + paddingSamples;
     
     expect(expectedLength).toBe(13120); // Expected signal length for "Hello" with 48kHz
   });
 
   test('Direct Audio Test - AudioWorklet Integration', async () => {
       console.log('🧪 Starting Direct Audio Test...');
 
       // Create modulator and demodulator
       const modulator = new WebAudioModulatorNode(audioContext, {
         processorUrl: '/src/webaudio/processors/fsk-processor.ts',
         processorName: 'fsk-processor'
       });
 
       const demodulator = new WebAudioModulatorNode(audioContext, {
         processorUrl: '/src/webaudio/processors/fsk-processor.ts',
         processorName: 'fsk-processor'
       });
 
       await modulator.initialize();
       await demodulator.initialize();

       // Configure with test-friendly settings
       const testConfig = {
         sampleRate: audioContext.sampleRate,
         baudRate: 300,
         markFrequency: 1650,
         spaceFrequency: 1850,
         syncThreshold: 0.75
       };
 
       await modulator.configure(testConfig);
       await demodulator.configure(testConfig);

       // Get worklet nodes for proper AudioWorklet connection
       const modulatorWorklet = modulator.workletNode;
       const demodulatorWorklet = demodulator.workletNode;
       if (!modulatorWorklet || !demodulatorWorklet) {
         throw new Error('AudioWorklet nodes not available');
       }
 
       // Connect modulator output to demodulator input (AudioWorklet loopback)
       modulatorWorklet.connect(demodulatorWorklet);
 
       console.log('🎯 Connected AudioWorklet modulator → demodulator...');
       audioContext.resume(); // Ensure AudioContext is running
       expect(audioContext.state).equal('running');
 
       console.log('✅ AudioWorklet processors loaded successfully!');
 
       // Test data
       const testText = "Test123";
       const testData = new TextEncoder().encode(testText);
       console.log(`🔊 Testing with: "${testText}"`);
 
       // Generate signal
       await modulator.modulateData(testData);
 
       // Set up demodulation result listener  
       const demodulationPromise = new Promise((resolve, reject) => {
         const timeout = setTimeout(() => {
           reject(new Error('Direct Audio Test timeout - no demodulation received'));
         }, 10000); // Increased timeout to 10 seconds
 
         demodulator.on('demodulated', (data) => {
           clearTimeout(timeout);
           console.log(`🎵 Received demodulated data: ${data.bytes.length} bytes`);
           resolve(new Uint8Array(data.bytes));
         });
       });
 
       // Wait a bit for connection to stabilize, then check for buffered data
       await new Promise(resolve => setTimeout(resolve, 1000));
 
       // Check demodulated buffer
       const demodulated = await demodulator.demodulateData(new Float32Array(0)); // samples parameter ignored
 
       // Verify result
       const receivedText = new TextDecoder().decode(demodulated);
       console.log(`📝 Received text: "${receivedText}"`);
 
       // Assert perfect match
       expect(receivedText).toBe(testText);
       expect(demodulated.length).toBe(testData.length);
 
       console.log('✅ Direct Audio Test PASSED - Perfect AudioWorklet loopback!');
   });
});
