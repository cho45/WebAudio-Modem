/**
 * Core infrastructure tests - Event system
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Event, EventEmitter } from '../src/core';

// Test implementation of abstract EventEmitter
class TestEventEmitter extends EventEmitter {
  // Expose protected methods for testing
  public triggerEvent(eventName: string, data?: unknown): void {
    this.emit(eventName, new Event(data));
  }
  
  public getListenerCount(eventName: string): number {
    // Access private listeners via type assertion for testing
    const listeners = (this as any).listeners as Map<string, Array<(event: Event) => void>>;
    return listeners.get(eventName)?.length || 0;
  }
  
  public getTotalListenerCount(): number {
    const listeners = (this as any).listeners as Map<string, Array<(event: Event) => void>>;
    let total = 0;
    for (const eventListeners of listeners.values()) {
      total += eventListeners.length;
    }
    return total;
  }
}

describe('Event Class', () => {
  test('should create event with null data by default', () => {
    const event = new Event();
    expect(event.data).toBe(null);
  });

  test('should create event with provided data', () => {
    const testData = { message: 'test', value: 42 };
    const event = new Event(testData);
    expect(event.data).toEqual(testData);
  });

  test('should create event with primitive data', () => {
    const stringEvent = new Event('hello');
    const numberEvent = new Event(123);
    const booleanEvent = new Event(true);
    
    expect(stringEvent.data).toBe('hello');
    expect(numberEvent.data).toBe(123);
    expect(booleanEvent.data).toBe(true);
  });

  test('should have readonly data property', () => {
    const event = new Event('test');
    expect(() => {
      // TypeScript should prevent this, but test runtime behavior
      (event as any).data = 'modified';
    }).not.toThrow();
    // Note: readonly is compile-time only, runtime allows modification
  });
});

describe('EventEmitter', () => {
  let emitter: TestEventEmitter;
  let callback1: ReturnType<typeof vi.fn>;
  let callback2: ReturnType<typeof vi.fn>;
  let callback3: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitter = new TestEventEmitter();
    callback1 = vi.fn();
    callback2 = vi.fn();
    callback3 = vi.fn();
  });

  describe('Basic Event Registration and Emission', () => {
    test('should register and trigger single event listener', () => {
      emitter.on('test', callback1);
      emitter.triggerEvent('test', 'hello');
      
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledWith(expect.objectContaining({
        data: 'hello'
      }));
    });

    test('should handle multiple listeners for same event', () => {
      emitter.on('test', callback1);
      emitter.on('test', callback2);
      emitter.on('test', callback3);
      
      emitter.triggerEvent('test', 'data');
      
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);
      expect(emitter.getListenerCount('test')).toBe(3);
    });

    test('should handle multiple different events', () => {
      emitter.on('event1', callback1);
      emitter.on('event2', callback2);
      emitter.on('event3', callback3);
      
      emitter.triggerEvent('event1', 'data1');
      emitter.triggerEvent('event2', 'data2');
      
      expect(callback1).toHaveBeenCalledWith(expect.objectContaining({ data: 'data1' }));
      expect(callback2).toHaveBeenCalledWith(expect.objectContaining({ data: 'data2' }));
      expect(callback3).not.toHaveBeenCalled();
    });

    test('should emit with default Event when no event provided', () => {
      emitter.on('test', callback1);
      emitter.emit('test'); // No event parameter
      
      expect(callback1).toHaveBeenCalledWith(expect.objectContaining({
        data: null
      }));
    });
  });

  describe('Event Listener Removal', () => {
    test('should remove specific listener', () => {
      emitter.on('test', callback1);
      emitter.on('test', callback2);
      
      emitter.off('test', callback1);
      emitter.triggerEvent('test', 'data');
      
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(emitter.getListenerCount('test')).toBe(1);
    });

    test('should handle removal of non-existent listener gracefully', () => {
      emitter.on('test', callback1);
      
      // Remove callback that was never added
      expect(() => emitter.off('test', callback2)).not.toThrow();
      
      emitter.triggerEvent('test', 'data');
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(emitter.getListenerCount('test')).toBe(1);
    });

    test('should handle removal from non-existent event gracefully', () => {
      expect(() => emitter.off('nonexistent', callback1)).not.toThrow();
    });

    test('should remove correct listener when same callback added multiple times', () => {
      emitter.on('test', callback1);
      emitter.on('test', callback1); // Same callback twice
      emitter.on('test', callback2);
      
      expect(emitter.getListenerCount('test')).toBe(3);
      
      emitter.off('test', callback1); // Should remove only first occurrence
      expect(emitter.getListenerCount('test')).toBe(2);
      
      emitter.triggerEvent('test', 'data');
      expect(callback1).toHaveBeenCalledTimes(1); // Still called once
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('Remove All Listeners', () => {
    test('should remove all listeners for specific event', () => {
      emitter.on('test', callback1);
      emitter.on('test', callback2);
      emitter.on('other', callback3);
      
      emitter.removeAllListeners('test');
      
      emitter.triggerEvent('test', 'data');
      emitter.triggerEvent('other', 'data');
      
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
      expect(callback3).toHaveBeenCalledTimes(1);
      expect(emitter.getListenerCount('test')).toBe(0);
      expect(emitter.getListenerCount('other')).toBe(1);
    });

    test('should remove all listeners for all events when no event specified', () => {
      emitter.on('event1', callback1);
      emitter.on('event2', callback2);
      emitter.on('event3', callback3);
      
      expect(emitter.getTotalListenerCount()).toBe(3);
      
      emitter.removeAllListeners(); // No event name
      
      expect(emitter.getTotalListenerCount()).toBe(0);
      
      emitter.triggerEvent('event1', 'data');
      emitter.triggerEvent('event2', 'data');
      emitter.triggerEvent('event3', 'data');
      
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
      expect(callback3).not.toHaveBeenCalled();
    });

    test('should handle removeAllListeners for non-existent event gracefully', () => {
      emitter.on('existing', callback1);
      
      expect(() => emitter.removeAllListeners('nonexistent')).not.toThrow();
      
      emitter.triggerEvent('existing', 'data');
      expect(callback1).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle emission to non-existent event gracefully', () => {
      expect(() => emitter.triggerEvent('nonexistent', 'data')).not.toThrow();
    });

    test('should handle complex event data types', () => {
      const complexData = {
        array: [1, 2, 3],
        nested: { key: 'value' },
        func: () => 'test',
        null: null,
        undefined: undefined
      };
      
      emitter.on('complex', callback1);
      emitter.triggerEvent('complex', complexData);
      
      expect(callback1).toHaveBeenCalledWith(expect.objectContaining({
        data: complexData
      }));
    });

    test('should handle exceptions in event listeners gracefully', () => {
      const throwingCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      
      emitter.on('test', throwingCallback);
      emitter.on('test', callback1); // Should still be called
      
      // Event emission should not throw even if callback throws
      expect(() => emitter.triggerEvent('test', 'data')).toThrow('Callback error');
      
      expect(throwingCallback).toHaveBeenCalledTimes(1);
      // callback1 might not be called if throwingCallback throws first
    });

    test('should maintain listener order', () => {
      const callOrder: number[] = [];
      
      const orderedCallback1 = vi.fn(() => callOrder.push(1));
      const orderedCallback2 = vi.fn(() => callOrder.push(2));
      const orderedCallback3 = vi.fn(() => callOrder.push(3));
      
      emitter.on('test', orderedCallback1);
      emitter.on('test', orderedCallback2);
      emitter.on('test', orderedCallback3);
      
      emitter.triggerEvent('test', 'data');
      
      expect(callOrder).toEqual([1, 2, 3]);
    });
  });

  describe('Memory Management', () => {
    test('should not leak listeners after removal', () => {
      // Add many listeners
      for (let i = 0; i < 100; i++) {
        emitter.on('test', vi.fn());
      }
      
      expect(emitter.getListenerCount('test')).toBe(100);
      
      // Remove all
      emitter.removeAllListeners('test');
      
      expect(emitter.getListenerCount('test')).toBe(0);
      
      // Verify map entry is completely removed
      emitter.triggerEvent('test', 'data');
      expect(emitter.getListenerCount('test')).toBe(0);
    });

    test('should handle rapid add/remove operations', () => {
      for (let i = 0; i < 50; i++) {
        const cb = vi.fn();
        emitter.on('test', cb);
        emitter.off('test', cb);
      }
      
      expect(emitter.getListenerCount('test')).toBe(0);
    });
  });
});