/**
 * Custom AbortSignal/AbortController implementation for AudioWorkletGlobalScope
 * 
 * AudioWorkletGlobalScope では標準の AbortController / AbortSignal が利用できません。
 * そのため、キャンセル制御には独自実装の MyAbortController / MyAbortSignal を使用しています。
 */

export class MyAbortSignal {
  private _aborted = false;
  private listeners: (() => void)[] = [];
  onabort: (() => void) | null = null;

  get aborted() { return this._aborted; }

  addEventListener(type: 'abort', listener: () => void) {
    if (type === 'abort') this.listeners.push(listener);
  }

  removeEventListener(type: 'abort', listener: () => void) {
    if (type === 'abort') this.listeners = this.listeners.filter(l => l !== listener);
  }

  dispatchEvent() {
    this.onabort?.();
    this.listeners.forEach(l => l());
    this.listeners = [];
  }

  throwIfAborted() {
    if (this._aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

export class MyAbortController {
  signal = new MyAbortSignal();

  abort() {
    if (!this.signal.aborted) {
      (this.signal as any)._aborted = true;
      this.signal.dispatchEvent();
    }
  }
}