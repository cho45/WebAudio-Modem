// Core interfaces and base classes for WebAudio Modem

export interface BaseModulatorConfig {
  sampleRate: number;
  baudRate: number;
}

export interface SignalQuality {
  snr: number;           // Signal-to-Noise Ratio (dB)
  ber: number;           // Bit Error Rate
  eyeOpening: number;    // Eye Pattern Opening (0-1)
  phaseJitter: number;   // Phase Jitter (radians)
  frequencyOffset: number; // Frequency Offset (Hz)
}

export type ModulationType = 'FSK' | 'PSK' | 'QAM' | 'ASK';

export interface IModulator<TConfig extends BaseModulatorConfig = BaseModulatorConfig> {
  readonly name: string;
  readonly type: ModulationType;
  
  // Configuration management
  configure(_config: TConfig): void;
  getConfig(): TConfig;
  
  // Modulation/Demodulation (async data processing)
  modulateData(_data: Uint8Array): Promise<Float32Array>;

  // ストリーム処理のため、連続してデータを受けとれること
  // samples を跨いでも処理することができること
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
 * while enforcing the ITransport interface
 */
export abstract class BaseTransport 
  extends EventEmitter 
  implements ITransport {
  
  abstract readonly transportName: string;
  
  protected modulator: IModulator;
  protected statistics: MutableTransportStatistics = {
    packetsSent: 0,
    packetsReceived: 0,
    packetsRetransmitted: 0,
    packetsDropped: 0,
    bytesTransferred: 0,
    errorRate: 0,
    averageRoundTripTime: 0
  };

  constructor(modulator: IModulator) {
    super();
    this.modulator = modulator;
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


