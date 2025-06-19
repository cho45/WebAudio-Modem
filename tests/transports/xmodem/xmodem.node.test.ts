/**
 * XModem transport tests - Comprehensive testing
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { XModemTransport } from '../../../src/transports/xmodem/xmodem';
import { XModemPacket } from '../../../src/transports/xmodem/packet';
import { ControlType } from '../../../src/transports/xmodem/types';
import { IModulator, SignalQuality, Event, EventEmitter } from '../../../src/core';

// Mock Modulator for testing
class MockModulator extends EventEmitter implements IModulator {
  readonly name = 'Mock';
  readonly type = 'FSK' as const;
  
  private _ready = true;
  public sentData: Uint8Array[] = [];
  public receivedData: Uint8Array[] = [];
  private dataToReceive: Uint8Array[] = [];

  configure(config: any): void {
    // Mock implementation
  }

  getConfig(): any {
    return {};
  }

  async modulateData(data: Uint8Array): Promise<Float32Array> {
    this.sentData.push(new Uint8Array(data));
    return new Float32Array(data.length * 100); // Mock signal
  }

  async demodulateData(samples: Float32Array): Promise<Uint8Array> {
    if (this.dataToReceive.length > 0) {
      return this.dataToReceive.shift()!;
    }
    return new Uint8Array(0);
  }

  reset(): void {
    this.sentData = [];
    this.receivedData = [];
    this.dataToReceive = [];
    this._ready = true;
  }

  isReady(): boolean {
    return this._ready;
  }

  getSignalQuality(): SignalQuality {
    return {
      snr: 30,
      ber: 0.001,
      eyeOpening: 0.8,
      phaseJitter: 0.1,
      frequencyOffset: 0
    };
  }

  // Helper methods for testing
  addReceivedData(data: Uint8Array): void {
    this.dataToReceive.push(data);
  }

  simulateDataReceived(data: Uint8Array): void {
    this.emit('data', new Event(data));
  }

  getLastSentData(): Uint8Array | undefined {
    return this.sentData[this.sentData.length - 1];
  }
}

describe('XModem Transport', () => {
  let transport: XModemTransport;
  let mockModulator: MockModulator;
  
  beforeEach(() => {
    mockModulator = new MockModulator();
    transport = new XModemTransport(mockModulator);
    
    // Speed up tests
    transport.configure({ timeoutMs: 100, maxRetries: 3 });
  });
  
  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    // Reset transport state to avoid unhandled rejections
    transport.reset();
    // Reset mock modulator state
    mockModulator.reset();
  });

  describe('Configuration', () => {
    test('Default configuration', () => {
      const newMockModulator = new MockModulator();
      const newTransport = new XModemTransport(newMockModulator);
      const config = newTransport.getConfig();
      
      expect(config.timeoutMs).toBe(3000);
      expect(config.maxRetries).toBe(10);
      expect(config.maxPayloadSize).toBe(128);
    });

    test('Configure transport parameters', () => {
      transport.configure({ 
        timeoutMs: 5000, 
        maxRetries: 5,
        maxPayloadSize: 64
      });
      
      const config = transport.getConfig();
      expect(config.timeoutMs).toBe(5000);
      expect(config.maxRetries).toBe(5);
      expect(config.maxPayloadSize).toBe(64);
    });
  });

  describe('Basic Operations', () => {
    test('Transport name and ready state', () => {
      expect(transport.transportName).toBe('XModem');
      expect(transport.isReady()).toBe(true);
    });

    test('Ready with modulator', () => {
      const newMockModulator = new MockModulator();
      const newTransport = new XModemTransport(newMockModulator);
      expect(newTransport.isReady()).toBe(true);
    });

    test('Get initial statistics', () => {
      const stats = transport.getStatistics();
      expect(stats.packetsSent).toBe(0);
      expect(stats.packetsReceived).toBe(0);
      expect(stats.packetsRetransmitted).toBe(0);
      expect(stats.packetsDropped).toBe(0);
      expect(stats.bytesTransferred).toBe(0);
      expect(stats.errorRate).toBe(0);
    });
  });

  describe('Control Commands', () => {
    test('Send control commands', async () => {
      await transport.sendControl('ACK');
      await transport.sendControl('NAK');
      await transport.sendControl('EOT');
      
      expect(mockModulator.sentData.length).toBe(3);
      expect(transport.getStatistics().packetsSent).toBe(3);
    });

    test('Invalid control command', async () => {
      await expect(transport.sendControl('INVALID')).rejects.toThrow('Unknown control command');
    });

    test('Control command with modulator', async () => {
      const newMockModulator = new MockModulator();
      const newTransport = new XModemTransport(newMockModulator);
      await expect(newTransport.sendControl('ACK')).resolves.not.toThrow();
    });
  });

  describe('Data Fragmentation', () => {
    test('Send small data (single packet)', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      // Start send operation
      const sendPromise = transport.sendData(testData);
      
      // Should send data packet
      expect(mockModulator.sentData.length).toBe(1);
      
      // Simulate ACK response
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      const ackSerialized = XModemPacket.serialize(ackPacket);
      await transport.processIncomingData(ackSerialized);
      
      // Should send EOT
      expect(mockModulator.sentData.length).toBe(2);
      
      await sendPromise;
      vi.useRealTimers();
    });

    test('Send large data (multiple packets)', async () => {
      vi.useFakeTimers();
      
      // Configure small payload size for testing
      transport.configure({ maxPayloadSize: 3 });
      
      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7]); // 7 bytes -> 3 packets
      
      const sendPromise = transport.sendData(testData);
      
      // Packet 1
      expect(mockModulator.sentData.length).toBe(1);
      let ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // Packet 2  
      expect(mockModulator.sentData.length).toBe(2);
      ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // Packet 3
      expect(mockModulator.sentData.length).toBe(3);
      ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // EOT
      expect(mockModulator.sentData.length).toBe(4);
      
      await sendPromise;
      vi.useRealTimers();
    });

    test('Send empty data', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([]);
      
      const sendPromise = transport.sendData(testData);
      
      // Should send empty packet
      expect(mockModulator.sentData.length).toBe(1);
      
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // Should send EOT
      expect(mockModulator.sentData.length).toBe(2);
      
      await sendPromise;
      vi.useRealTimers();
    });
  });

  describe('Error Handling and Retransmission', () => {
    test('Timeout and retransmission', async () => {
      const testData = new Uint8Array([0x42]);
      
      // Send data
      const sendPromise = transport.sendData(testData);
      
      // Initial send
      expect(mockModulator.sentData.length).toBe(1);
      
      // Wait for timeout (100ms + some buffer)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Should retry
      expect(mockModulator.sentData.length).toBe(2);
      expect(transport.getStatistics().packetsRetransmitted).toBe(1);
      
      // Send ACK to complete
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      await sendPromise;
    });

    test('Max retries exceeded', async () => {
      const testData = new Uint8Array([0x42]);
      
      const sendPromise = transport.sendData(testData);
      
      // Wait for all retries to timeout and complete
      await expect(sendPromise).rejects.toThrow('Max retries exceeded');
      
      // Wait a bit more to ensure all timeouts are processed
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(mockModulator.sentData.length).toBe(4);
      expect(transport.getStatistics().packetsRetransmitted).toBe(3);
      
      // Transport should already be reset after failure
      expect(transport.isReady()).toBe(true);
    });

    test('NAK triggers retransmission', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([0x42]);
      
      const sendPromise = transport.sendData(testData);
      
      // Initial send
      expect(mockModulator.sentData.length).toBe(1);
      
      // Send NAK
      const nakPacket = XModemPacket.createControl(ControlType.NAK);
      await transport.processIncomingData(XModemPacket.serialize(nakPacket));
      
      // Should retransmit
      expect(mockModulator.sentData.length).toBe(2);
      expect(transport.getStatistics().packetsRetransmitted).toBe(1);
      
      // Send ACK to complete
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      await sendPromise;
      vi.useRealTimers();
    });

    test('Send failure', async () => {
      // Mock the modulator to throw an error
      const originalModulateData = mockModulator.modulateData;
      mockModulator.modulateData = vi.fn().mockRejectedValueOnce(new Error('Network error'));
      
      const testData = new Uint8Array([0x42]);
      
      await expect(transport.sendData(testData)).rejects.toThrow();
      
      // Restore original method
      mockModulator.modulateData = originalModulateData;
    });
  });

  describe('Data Reception', () => {
    test('Receive single packet', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
      
      const receivePromise = transport.receiveData();
      
      // Send data packet
      const dataPacket = XModemPacket.createData(1, testData);
      await transport.processIncomingData(XModemPacket.serialize(dataPacket));
      
      // Should send ACK
      expect(mockModulator.sentData.length).toBe(1);
      expect(transport.getStatistics().packetsReceived).toBe(1);
      
      // Send EOT
      const eotPacket = XModemPacket.createControl(ControlType.EOT);
      await transport.processIncomingData(XModemPacket.serialize(eotPacket));
      
      const receivedData = await receivePromise;
      expect(receivedData).toEqual(testData);
      
      vi.useRealTimers();
    });

    test('Receive multiple packets (reassembly)', async () => {
      vi.useFakeTimers();
      
      const receivePromise = transport.receiveData();
      
      // Send packets in sequence
      const packet1 = XModemPacket.createData(1, new Uint8Array([1, 2, 3]));
      const packet2 = XModemPacket.createData(2, new Uint8Array([4, 5, 6]));
      const packet3 = XModemPacket.createData(3, new Uint8Array([7, 8]));
      
      await transport.processIncomingData(XModemPacket.serialize(packet1));
      await transport.processIncomingData(XModemPacket.serialize(packet2));
      await transport.processIncomingData(XModemPacket.serialize(packet3));
      
      // Should send 3 ACKs
      expect(mockModulator.sentData.length).toBe(3);
      expect(transport.getStatistics().packetsReceived).toBe(3);
      
      // Send EOT to complete
      const eotPacket = XModemPacket.createControl(ControlType.EOT);
      await transport.processIncomingData(XModemPacket.serialize(eotPacket));
      
      const receivedData = await receivePromise;
      expect(receivedData).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      
      vi.useRealTimers();
    });

    test('Out-of-sequence packet triggers NAK', async () => {
      vi.useFakeTimers();
      
      const receivePromise = transport.receiveData();
      
      // Send packet 2 instead of packet 1
      const packet2 = XModemPacket.createData(2, new Uint8Array([4, 5, 6]));
      await transport.processIncomingData(XModemPacket.serialize(packet2));
      
      // Should send NAK
      expect(mockModulator.sentData.length).toBe(1);
      expect(transport.getStatistics().packetsDropped).toBe(1);
      
      // Send correct packet 1
      const packet1 = XModemPacket.createData(1, new Uint8Array([1, 2, 3]));
      await transport.processIncomingData(XModemPacket.serialize(packet1));
      
      // Should send ACK
      expect(mockModulator.sentData.length).toBe(2);
      
      // Complete with EOT
      const eotPacket = XModemPacket.createControl(ControlType.EOT);
      await transport.processIncomingData(XModemPacket.serialize(eotPacket));
      
      const receivedData = await receivePromise;
      expect(receivedData).toEqual(new Uint8Array([1, 2, 3]));
      
      vi.useRealTimers();
    });
  });

  describe('State Management', () => {
    test('Cannot send while busy', async () => {
      vi.useFakeTimers();
      
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6]);
      
      const send1 = transport.sendData(data1);
      
      await expect(transport.sendData(data2)).rejects.toThrow('Cannot send: transport busy');
      
      // Complete first send
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      await send1;
      vi.useRealTimers();
    });

    test('Cannot receive while busy', async () => {
      const receive1 = transport.receiveData();
      
      await expect(transport.receiveData()).rejects.toThrow('Cannot receive: transport busy');
      
      // Complete first receive
      const eotPacket = XModemPacket.createControl(ControlType.EOT);
      await transport.processIncomingData(XModemPacket.serialize(eotPacket));
      
      await receive1;
    });

    test('Reset clears state and rejects pending operations', async () => {
      const data = new Uint8Array([1, 2, 3]);
      
      const sendPromise = transport.sendData(data);
      
      // Wait a bit for the send to start
      await new Promise(resolve => setTimeout(resolve, 10));
      
      transport.reset();
      
      await expect(sendPromise).rejects.toThrow('Transport reset');
      
      expect(transport.isReady()).toBe(true);
      expect(transport.getStatistics().packetsSent).toBe(0);
    });
  });

  describe('Error Cases', () => {
    test('Invalid packet data', async () => {
      const errorSpy = vi.fn();
      transport.on('error', errorSpy);
      
      const invalidData = new Uint8Array([0x02, 0x01, 0x02]); // Invalid packet
      await transport.processIncomingData(invalidData);
      
      expect(errorSpy).toHaveBeenCalled();
    });

    test('Operations with modulator work correctly', async () => {
      const newMockModulator = new MockModulator();
      const newTransport = new XModemTransport(newMockModulator);
      newTransport.configure({ timeoutMs: 100, maxRetries: 1 });
      
      // These should not throw initially (though they may timeout/fail later)
      await expect(newTransport.sendControl('ACK')).resolves.not.toThrow();
    });
  });

  describe('Statistics Tracking', () => {
    test('Statistics are updated correctly', async () => {
      // Send operation with retry
      const testData = new Uint8Array([0x42]);
      const sendPromise = transport.sendData(testData);
      
      // Wait for timeout and retry
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Send ACK to complete
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      await sendPromise;
      
      const stats = transport.getStatistics();
      expect(stats.packetsSent).toBe(3); // 2 data packets + 1 EOT
      expect(stats.packetsRetransmitted).toBe(1);
      expect(stats.bytesTransferred).toBe(1);
    });
  });
});