/**
 * WebAudio Data Channel - AudioWorkletNode継承によるデータ通信チャネル
 * 
 * Transport層が使用するIDataChannelの実装。
 * AudioWorkletNodeを継承してWebAudio APIと自然に統合。
 */

import type { IDataChannel } from '../core.js';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate' | 'status' | 'result' | 'error';
  data?: any;
}

export class WebAudioDataChannel extends AudioWorkletNode implements IDataChannel {
  private pendingOperations = new Map<string, { resolve: Function, reject: Function }>();
  private operationCounter = 0;
  private instanceName: string;
  
  constructor(context: AudioContext, processorName: string, options: AudioWorkletNodeOptions = {}) {
    // Extract instance name from processorOptions
    const instanceName = options.processorOptions?.name || 'unnamed';
    
    console.log(`[WebAudioDataChannel:${instanceName}] Initializing with processor: ${processorName} and options:`, options);
    super(context, processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [1],
      ...options,
      processorOptions: {
        ...options.processorOptions,
        name: instanceName
      }
    });
    
    this.instanceName = instanceName;
    
    // Setup message handling
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  /**
   * AudioWorkletモジュールを追加（同一コンテキストで1回のみ）
   */
  static async addModule(context: AudioContext, processorUrl: string): Promise<void> {
    await context.audioWorklet.addModule(processorUrl);
  }
  
  private handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;
    const operation = this.pendingOperations.get(id);
    
    if (!operation) {
      console.warn(`[WebAudioDataChannel:${this.instanceName}] Received message for unknown operation: ${id}`);
      return;
    }
    
    this.pendingOperations.delete(id);
    
    if (type === 'result') {
      operation.resolve(data);
    } else if (type === 'error') {
      operation.reject(new Error(data.message));
    } else {
      console.warn(`[WebAudioDataChannel:${this.instanceName}] Unhandled message type: ${type}`);
      operation.reject(new Error(`Unhandled message type: ${type}`));
    }
  }
  
  private sendMessage(type: string, data?: any): Promise<any> {
    const id = `${this.instanceName}_op_${++this.operationCounter}`;
    
    return new Promise((resolve, reject) => {
      this.pendingOperations.set(id, { resolve, reject });
      this.port.postMessage({ id, type, data });
    });
  }
  
  /**
   * プロセッサーを設定
   */
  async configure(config: any): Promise<void> {
    await this.sendMessage('configure', { config });
  }
  
  /**
   * データを変調してオーディオ出力に送信
   */
  async modulate(data: Uint8Array, options?: {signal?: AbortSignal }): Promise<void> {
    console.log(`[WebAudioDataChannel:${this.instanceName}] Modulating ${data.length} bytes`);
    options?.signal?.addEventListener('abort', async () => {
      console.warn(`[WebAudioDataChannel:${this.instanceName}] Modulation aborted`);
      await this.sendMessage('abort', {});
    }, { once: true });

    const result = await this.sendMessage('modulate', { bytes: Array.from(data) });
    
    if (!result.success) {
      throw new Error('Modulation failed');
    }
  }
  
  /**
   * 復調されたデータを取得（データが利用可能になるまで待機）
   */
  async demodulate(): Promise<Uint8Array> {
    const result = await this.sendMessage('demodulate', {});
    return new Uint8Array(result.bytes || []);
  }

  /**
   * 現在のステータスを取得
   */
  async getStatus(): Promise<any> {
    return await this.sendMessage('status', {});
  }
  
  /**
   * チャネルをリセット
   */
  async reset(): Promise<void> {
    await this.sendMessage('abort', {});
    // Clear pending operations
    // abort によって reject されるので たぶんいらない
    for (const [_id, operation] of this.pendingOperations) {
      console.warn(`[WebAudioDataChannel:${this.instanceName}] Resetting operation: ${_id}`);
      operation.reject(new Error('DataChannel reset'));
    }
    this.pendingOperations.clear();
    await this.sendMessage('reset', {});
  }
  
  /**
   * チャネルが使用可能かチェック
   */
  isReady(): boolean {
    return true; // AudioWorkletNodeが作成されていれば使用可能
  }
}
