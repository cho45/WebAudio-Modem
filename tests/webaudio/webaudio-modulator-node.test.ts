/**
 * WebAudio Modulator Node tests - Basic functionality
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { WebAudioModulatorNode } from '../../src/webaudio/webaudio-modulator-node.js';
import { DEFAULT_FSK_CONFIG } from '../../src/modems/fsk.js';

// Mock AudioContext and AudioWorkletNode
class MockAudioWorkletNode {
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn()
  };
}

class MockAudioContext {
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined)
  };
}

// Mock global AudioWorkletNode
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

describe('WebAudioModulatorNode', () => {
  let audioContext: MockAudioContext;
  let modulator: WebAudioModulatorNode;
  
  beforeEach(() => {
    audioContext = new MockAudioContext();
    modulator = new WebAudioModulatorNode(audioContext as any, {
      processorUrl: './processors/fsk-processor.js',
      processorName: 'fsk-processor'
    });
  });
  
  test('creates instance', () => {
    expect(modulator.name).toBe('WebAudioModulator');
    expect(modulator.isReady()).toBe(false);
  });
  
  test('initializes processor', async () => {
    await modulator.initialize();
    
    expect(audioContext.audioWorklet.addModule).toHaveBeenCalledWith('./processors/fsk-processor.js');
    expect(modulator.isReady()).toBe(true);
  });
  
  test('throws if used before initialization', async () => {
    await expect(modulator.configure(DEFAULT_FSK_CONFIG))
      .rejects.toThrow('not initialized');
  });
  
  test('sends configuration message', async () => {
    await modulator.initialize();
    
    // Simulate successful response from processor
    const workletNode = (modulator as any).workletNode as MockAudioWorkletNode;
    const configPromise = modulator.configure(DEFAULT_FSK_CONFIG);
    
    // Simulate processor response
    const sentMessage = workletNode.port.postMessage.mock.calls[0][0];
    expect(sentMessage.type).toBe('configure');
    expect(sentMessage.data.config).toEqual(DEFAULT_FSK_CONFIG);
    
    // Simulate response
    workletNode.port.onmessage!({
      data: { id: sentMessage.id, type: 'result', data: { success: true } }
    } as MessageEvent);
    
    await configPromise;
  });
  
  test('handles errors from processor', async () => {
    await modulator.initialize();
    
    const workletNode = (modulator as any).workletNode as MockAudioWorkletNode;
    const configPromise = modulator.configure({});
    
    // Simulate error response
    const sentMessage = workletNode.port.postMessage.mock.calls[0][0];
    workletNode.port.onmessage!({
      data: { id: sentMessage.id, type: 'error', data: { message: 'Configuration failed' } }
    } as MessageEvent);
    
    await expect(configPromise).rejects.toThrow('Configuration failed');
  });
  
  test('rejects pending operations on reset', async () => {
    await modulator.initialize();
    
    const configPromise = modulator.configure(DEFAULT_FSK_CONFIG);
    modulator.reset();
    
    await expect(configPromise).rejects.toThrow('Modulator reset');
  });
});
