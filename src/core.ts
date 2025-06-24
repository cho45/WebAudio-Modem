// Core interfaces and base classes for WebAudio Modem

export interface BaseModulatorConfig {
  sampleRate: number;
  baudRate: number;
}

export type ModulationType = 'FSK' | 'PSK' | 'QAM' | 'WebAudio';

export interface SignalQuality {
  snr: number;           // Signal-to-Noise Ratio (dB)
  ber: number;           // Bit Error Rate
  eyeOpening: number;    // Eye Pattern Opening (0-1)
  phaseJitter: number;   // Phase Jitter (radians)
  frequencyOffset: number; // Frequency Offset (Hz)
}

/**
 * Audio Processor Interface - リアルタイム音声処理とアプリケーション通信の統合
 * 
 * このインターフェースは、WebAudioの制約（リアルタイム処理）と
 * アプリケーションの要求（非同期データ送受信）を橋渡しします。
 * 
 * 実装例:
 * - FSKProcessor: FSK変復調のAudioWorkletProcessor実装
 * - PSKProcessor: PSK変復調のAudioWorkletProcessor実装
 * - MockAudioProcessor: テスト用のモック実装
 * 
 * 重要な責務:
 * 1. リアルタイム音声処理（128サンプル/チャンク）
 * 2. 送信データのキューイング・分割
 * 3. 受信データのバッファリング・待機制御
 */
export interface IAudioProcessor {
  /**
   * リアルタイム音声処理（AudioWorkletProcessor.process()相当）
   * 
   * @param inputs 入力音声データ（[チャネル][サンプル]の2次元配列）
   * @param outputs 出力音声データ（[チャネル][サンプル]の2次元配列）
   * @returns 処理継続フラグ（falseで処理停止）
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

export interface IDataChannel {
  /**
   * アプリケーションレベルの変調要求
   * データを音声信号に変調し、音声出力キューに追加
   * 
   * @param data 変調するデータ
   * @returns 変調完了を示すPromise
   */
  modulate(data: Uint8Array): Promise<void>;
  
  /**
   * アプリケーションレベルの復調データ取得
   * バッファされた復調データを取得（データが来るまで待機）
   * 
   * @returns 復調されたデータ
   */
  demodulate(): Promise<Uint8Array>;

  /**
   * Reset the data channel state
   */
  reset(): Promise<void>;
}

/**
 * Audio Modulator Interface - 純粋な音声信号処理層
 * 
 * このインターフェースは音声サンプルとデータの変換を担当する純粋計算エンジンです。
 * 通信プロトコル、リアルタイム制約、バッファリングなどは一切関知しません。
 * 
 * 実装例:
 * - FSKCore: FSK変復調
 * - PSKCore: PSK変復調  
 * - QAMCore: QAM変復調
 * 
 * 使用パターン:
 * - IAudioProcessor実装内で使用される（FSKProcessor内のFSKCore）
 * - 直接的なテストで使用される（純粋な信号処理テスト）
 * - Transport層からは IAudioProcessor を通じて間接的に使用される
 */
export interface IModulator<TConfig extends BaseModulatorConfig = BaseModulatorConfig> {
  readonly name: string;
  
  // Configuration management
  configure(_config: TConfig): void;
  getConfig(): TConfig;
  
  // データを音声信号に変調（純粋な計算処理）
  // 入力: データ → 出力: 音声信号（Float32Array）
  modulateData(_data: Uint8Array): Promise<Float32Array>;

  // 音声サンプルからデータを復調（ストリーム処理対応）
  // 入力: 音声サンプル → 出力: 復調されたデータ（即座に処理可能な分のみ）
  // 連続的にsamplesを処理し、復調可能なデータがあれば返す
  demodulateData(_samples: Float32Array): Promise<Uint8Array>;
  
  // State management
  reset(): void;
  isReady(): boolean;
  initialize?(): Promise<void>;
  dispose?(): void;
  
  // Signal quality monitoring
  getSignalQuality(): SignalQuality;
  
  // Event handling
  on(_eventName: string, _callback: (_event: Event) => void): void;
  off(_eventName: string, _callback: (_event: Event) => void): void;
  emit(_eventName: string, _event?: Event): void;
}

/**
 * High-level transport interface for application layer
 * 
 * Provides reliable data transmission with automatic:
 * - Error detection and correction
 * - Loss detection and retransmission  
 * - Flow control
 * - Data fragmentation and reassembly
 * 
 * Different transport protocols (XModem, HDLC, etc.) are completely interchangeable
 * through this interface, transparent to the application.
 */
export interface ITransport {
  readonly transportName: string;
  
  /**
   * Send data reliably to the remote endpoint
   * Handles fragmentation, sequencing, retransmission automatically
   * 
   * @param data Data to send
   * @returns Promise that resolves when data is acknowledged by remote
   */
  sendData(data: Uint8Array): Promise<void>;
  
  /**
   * Receive data from the remote endpoint
   * Handles reassembly, duplicate detection, acknowledgment automatically
   * 
   * @returns Promise that resolves with received data
   */
  receiveData(): Promise<Uint8Array>;
  
  /**
   * Send control command (protocol-specific)
   * 
   * @param command Protocol-specific control command
   * @returns Promise that resolves when command is sent
   */
  sendControl(command: string): Promise<void>;
  
  /**
   * Check if protocol is ready for communication
   */
  isReady(): boolean;
  
  /**
   * Get current transport statistics
   */
  getStatistics(): TransportStatistics;
  
  /**
   * Reset transport state (clear buffers, reset sequence numbers)
   */
  reset(): void;
}

/**
 * Transport statistics for monitoring and diagnostics
 */
export interface TransportStatistics {
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly packetsRetransmitted: number;
  readonly packetsDropped: number;
  readonly bytesTransferred: number;
  readonly errorRate: number;           // 0.0 - 1.0
  readonly averageRoundTripTime: number; // milliseconds
}

/*
 * Internal mutable statistics (for implementation use)
 */
export interface MutableTransportStatistics {
  packetsSent: number;
  packetsReceived: number;
  packetsRetransmitted: number;
  packetsDropped: number;
  bytesTransferred: number;
  errorRate: number;
  averageRoundTripTime: number;
}


// Base event class
export class Event {
  constructor(public readonly data: unknown = null) {}
}

// Event system base class
export abstract class EventEmitter {
  private listeners = new Map<string, Array<(_event: Event) => void>>();
  
  on(eventName: string, callback: (_event: Event) => void): void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName)!.push(callback);
  }
  
  off(eventName: string, callback: (_event: Event) => void): void {
    const eventListeners = this.listeners.get(eventName);
    if (eventListeners) {
      const index = eventListeners.indexOf(callback);
      if (index !== -1) {
        eventListeners.splice(index, 1);
      }
    }
  }
  
  emit(eventName: string, event: Event = new Event()): void {
    const eventListeners = this.listeners.get(eventName);
    if (eventListeners) {
      eventListeners.forEach(callback => callback(event));
    }
  }
  
  removeAllListeners(eventName?: string): void {
    if (eventName) {
      this.listeners.delete(eventName);
    } else {
      this.listeners.clear();
    }
  }
}

// Base modulator class with common functionality
export abstract class BaseModulator<TConfig extends BaseModulatorConfig> 
  extends EventEmitter 
  implements IModulator<TConfig> {
  
  abstract readonly name: string;
  abstract readonly type: ModulationType;
  
  protected config!: TConfig;
  protected ready = false;
  
  constructor() {
    super();
  }
  
  abstract configure(_config: TConfig): void;
  
  getConfig(): TConfig {
    return { ...this.config };
  }
  
  // Core DSP methods (must be implemented)
  abstract modulateData(_data: Uint8Array): Promise<Float32Array>;
  abstract demodulateData(_samples: Float32Array): Promise<Uint8Array>;
  
  reset(): void {
    this.ready = false;
    this.emit('reset');
  }
  
  isReady(): boolean {
    return this.ready;
  }
  
  getSignalQuality(): SignalQuality {
    return {
      snr: 0,
      ber: 0,
      eyeOpening: 0,
      phaseJitter: 0,
      frequencyOffset: 0
    };
  }
}

/**
 * Base class for transport protocols with common functionality
 * 
 * Provides event handling and basic statistics tracking
 * while enforcing the ITransport interface.
 * 
 * Transport層はIDataChannelを通じて通信し、音声処理の詳細を知らない。
 */
export abstract class BaseTransport 
  extends EventEmitter 
  implements ITransport {
  
  abstract readonly transportName: string;
  
  protected dataChannel: IDataChannel;
  protected statistics: MutableTransportStatistics = {
    packetsSent: 0,
    packetsReceived: 0,
    packetsRetransmitted: 0,
    packetsDropped: 0,
    bytesTransferred: 0,
    errorRate: 0,
    averageRoundTripTime: 0
  };

  constructor(dataChannel: IDataChannel) {
    super();
    this.dataChannel = dataChannel;
  }
  
  // Abstract methods that must be implemented by concrete protocols
  abstract sendData(data: Uint8Array): Promise<void>;
  abstract receiveData(): Promise<Uint8Array>;
  abstract sendControl(command: string): Promise<void>;
  abstract isReady(): boolean;
  
  /**
   * Get current statistics
   */
  getStatistics(): TransportStatistics {
    return { ...this.statistics };
  }
  
  /**
   * Reset transport state and statistics
   */
  reset(): void {
    this.statistics = {
      packetsSent: 0,
      packetsReceived: 0,
      packetsRetransmitted: 0,
      packetsDropped: 0,
      bytesTransferred: 0,
      errorRate: 0,
      averageRoundTripTime: 0
    };
    this.emit('reset');
  }
}


