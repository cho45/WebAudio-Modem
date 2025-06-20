/**
 * WebAudio Modulator Node - Minimal implementation
 */

import { EventEmitter } from '../core.js';
import type { IModulator, SignalQuality } from '../core.js';

interface ModulatorDescriptor {
  processorUrl: string;
  processorName: string;
}

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate' | 'result' | 'error';
  data?: any;
}

export class WebAudioModulatorNode extends EventEmitter implements IModulator {
  readonly name = 'WebAudioModulator';
  readonly type = 'WebAudio' as const;
  
  private audioContext: AudioContext;
  private _workletNode: AudioWorkletNode | null = null;
  private pendingOperations = new Map<string, { resolve: Function, reject: Function }>();
  private operationCounter = 0;
  
  get workletNode(): AudioWorkletNode | null {
    return this._workletNode;
  }
  
  constructor(audioContext: AudioContext, private descriptor: ModulatorDescriptor) {
    super();
    this.audioContext = audioContext;
  }
  
  async initialize(): Promise<void> {
    // Load the processor module
    await this.audioContext.audioWorklet.addModule(this.descriptor.processorUrl);
    
    // Create the worklet node
    this._workletNode = new AudioWorkletNode(this.audioContext, this.descriptor.processorName);
    
    // Setup message handling
    this._workletNode.port.onmessage = this.handleMessage.bind(this);
  }
  
  private handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;
    
    // Handle realtime messages (not part of pendingOperations)
    if (id === 'realtime-demod' && type === 'demodulated') {
      this.emit('demodulated', data);
      return;
    }
    
    const operation = this.pendingOperations.get(id);
    
    if (!operation) {
      console.warn(`Received message for unknown operation: ${id}`);
      return;
    }
    
    this.pendingOperations.delete(id);
    
    if (type === 'result') {
      operation.resolve(data);
    } else if (type === 'error') {
      operation.reject(new Error(data.message));
    }
  }
  
  private sendMessage(type: string, data?: any): Promise<any> {
    if (!this._workletNode) {
      throw new Error('WebAudioModulatorNode not initialized');
    }
    
    const id = `op_${++this.operationCounter}`;
    
    return new Promise((resolve, reject) => {
      this.pendingOperations.set(id, { resolve, reject });
      this._workletNode!.port.postMessage({ id, type, data });
    });
  }
  
  async configure(config: any): Promise<void> {
    await this.sendMessage('configure', { config });
  }
  
  async modulateData(data: Uint8Array): Promise<Float32Array> {
    // For output (modulation), use FSKCore directly to get the signal
    // The AudioWorklet version buffers to outputBuffer for streaming
    const { FSKCore, DEFAULT_FSK_CONFIG } = await import('../modems/fsk');
    const config = {
      ...DEFAULT_FSK_CONFIG,
      sampleRate: this.audioContext.sampleRate,
      baudRate: 300,
      markFrequency: 1650,
      spaceFrequency: 1850
    };
    
    const fskCore = new FSKCore();
    fskCore.configure(config);
    
    return await fskCore.modulateData(data);
  }
  
  async demodulateData(samples: Float32Array): Promise<Uint8Array> {
    // Get currently buffered demodulated data from the AudioWorklet
    const result = await this.sendMessage('demodulate', {});
    return new Uint8Array(result.bytes || []);
  }
  
  reset(): void {
    // Clear pending operations
    for (const [id, operation] of this.pendingOperations) {
      operation.reject(new Error('Modulator reset'));
    }
    this.pendingOperations.clear();
  }
  
  isReady(): boolean {
    return !!this._workletNode;
  }
  
  getConfig(): any {
    // Config is managed by the processor
    return {};
  }
  
  getSignalQuality(): SignalQuality {
    // Placeholder implementation
    return {
      snr: 0,
      ber: 0,
      eyeOpening: 0,
      phaseJitter: 0,
      frequencyOffset: 0
    };
  }
}