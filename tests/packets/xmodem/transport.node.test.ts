/**
 * XModem transport tests - Comprehensive testing
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { XModemTransport } from '../../../src/packets/xmodem/transport';
import { XModemPacket } from '../../../src/packets/xmodem/packet';
import { ControlType } from '../../../src/packets/xmodem/types';

describe('XModem Transport', () => {
  let transport: XModemTransport;
  let mockSend: ReturnType<typeof vi.fn>;
  let mockReceive: ReturnType<typeof vi.fn>;
  let sentPackets: Uint8Array[];
  
  beforeEach(() => {
    transport = new XModemTransport();
    sentPackets = [];
    
    mockSend = vi.fn(async (data: Uint8Array) => {
      sentPackets.push(new Uint8Array(data));
    });
    
    mockReceive = vi.fn(async () => {
      return new Uint8Array([]);
    });
    
    transport.setTransportCallbacks(mockSend, mockReceive);
    
    // Speed up tests
    transport.configure({ timeoutMs: 100, maxRetries: 3 });
  });
  
  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    // Dispose transport cleanly to avoid unhandled rejections
    transport.dispose();
  });

  describe('Configuration', () => {
    test('Default configuration', () => {
      const newTransport = new XModemTransport();
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

    test('Not ready without callbacks', () => {
      const newTransport = new XModemTransport();
      expect(newTransport.isReady()).toBe(false);
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
      
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(transport.getStatistics().packetsSent).toBe(3);
    });

    test('Invalid control command', async () => {
      await expect(transport.sendControl('INVALID')).rejects.toThrow('Unknown control command');
    });

    test('Control command without callback', async () => {
      const newTransport = new XModemTransport();
      await expect(newTransport.sendControl('ACK')).rejects.toThrow('Transport send callback not configured');
    });
  });

  describe('Data Fragmentation', () => {
    test('Send small data (single packet)', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      // Start send operation
      const sendPromise = transport.sendData(testData);
      
      // Should send data packet
      expect(mockSend).toHaveBeenCalledTimes(1);
      
      // Simulate ACK response
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      const ackSerialized = XModemPacket.serialize(ackPacket);
      await transport.processIncomingData(ackSerialized);
      
      // Should send EOT
      expect(mockSend).toHaveBeenCalledTimes(2);
      
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
      expect(mockSend).toHaveBeenCalledTimes(1);
      let ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // Packet 2  
      expect(mockSend).toHaveBeenCalledTimes(2);
      ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // Packet 3
      expect(mockSend).toHaveBeenCalledTimes(3);
      ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // EOT
      expect(mockSend).toHaveBeenCalledTimes(4);
      
      await sendPromise;
      vi.useRealTimers();
    });

    test('Send empty data', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([]);
      
      const sendPromise = transport.sendData(testData);
      
      // Should send empty packet
      expect(mockSend).toHaveBeenCalledTimes(1);
      
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      // Should send EOT
      expect(mockSend).toHaveBeenCalledTimes(2);
      
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
      expect(mockSend).toHaveBeenCalledTimes(1);
      
      // Wait for timeout (100ms + some buffer)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Should retry
      expect(mockSend).toHaveBeenCalledTimes(2);
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
      
      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(transport.getStatistics().packetsRetransmitted).toBe(3);
      
      // Transport should already be reset after failure
      expect(transport.isReady()).toBe(true);
    });

    test('NAK triggers retransmission', async () => {
      vi.useFakeTimers();
      
      const testData = new Uint8Array([0x42]);
      
      const sendPromise = transport.sendData(testData);
      
      // Initial send
      expect(mockSend).toHaveBeenCalledTimes(1);
      
      // Send NAK
      const nakPacket = XModemPacket.createControl(ControlType.NAK);
      await transport.processIncomingData(XModemPacket.serialize(nakPacket));
      
      // Should retransmit
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(transport.getStatistics().packetsRetransmitted).toBe(1);
      
      // Send ACK to complete
      const ackPacket = XModemPacket.createControl(ControlType.ACK);
      await transport.processIncomingData(XModemPacket.serialize(ackPacket));
      
      await sendPromise;
      vi.useRealTimers();
    });

    test('Send failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network error'));
      
      const testData = new Uint8Array([0x42]);
      
      await expect(transport.sendData(testData)).rejects.toThrow('Send failed');
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
      expect(mockSend).toHaveBeenCalledTimes(1);
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
      expect(mockSend).toHaveBeenCalledTimes(3);
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
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(transport.getStatistics().packetsDropped).toBe(1);
      
      // Send correct packet 1
      const packet1 = XModemPacket.createData(1, new Uint8Array([1, 2, 3]));
      await transport.processIncomingData(XModemPacket.serialize(packet1));
      
      // Should send ACK
      expect(mockSend).toHaveBeenCalledTimes(2);
      
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

    test('Operations without callbacks throw errors', async () => {
      const newTransport = new XModemTransport();
      
      await expect(newTransport.sendData(new Uint8Array([1]))).rejects.toThrow('Transport send callback not configured');
      await expect(newTransport.receiveData()).rejects.toThrow('Transport receive callback not configured');
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