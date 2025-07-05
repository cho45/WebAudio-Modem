/**
 * Custom AbortSignal/AbortController implementation for AudioWorkletGlobalScope
 * 
 * AudioWorkletGlobalScope では標準の AbortController / AbortSignal が利用できません。
 * そのため、キャンセル制御には独自実装の MyAbortController / MyAbortSignal を使用しています。
 */

export class MyAbortSignal {
  private _aborted = false;
  private _reason: any = undefined;
  private listeners: ((event: Event) => void)[] = [];
  onabort: (() => void) | null = null;

  get aborted() { return this._aborted; }
  get reason() { return this._reason; }

  addEventListener(type: 'abort', listener: (event: Event) => void, options?: boolean | AddEventListenerOptions) {
    if (type === 'abort') this.listeners.push(listener);
  }

  removeEventListener(type: 'abort', listener: (event: Event) => void, options?: boolean | EventListenerOptions) {
    if (type === 'abort') this.listeners = this.listeners.filter(l => l !== listener);
  }

  dispatchEvent(event?: Event): boolean {
    this.onabort?.();
    const abortEvent = event || new Event('abort');
    this.listeners.forEach(l => l(abortEvent));
    this.listeners = [];
    return true;
  }

  throwIfAborted() {
    if (this._aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

export class MyAbortController {
  signal = new MyAbortSignal();

  abort(reason?: any) {
    if (!this.signal.aborted) {
      (this.signal as any)._aborted = true;
      (this.signal as any)._reason = reason;
      this.signal.dispatchEvent();
    }
  }
}