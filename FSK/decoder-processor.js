class DecoderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.current = {
      state: "waiting",
      total: 0,
      mark: 0,
      space: 0,
      bit: 0,
      byte: 0,
      data: 0
    };
    this.states = {
      waiting: () => {
        if (this.current.data === -1) {
		  console.log(this.current.state + " -> start");
          this.current.state = "start";
        } else {
          this.current.total = 0;
        }
      },
      start: () => {
        if (this.current.data === 1) this.current.mark++;
        if (this.current.data === -1) this.current.space++;
        if (this.unit * this.startBit <= this.current.total) {
          if (this.current.mark < this.current.space) {
            // 状態遷移のみ最小限ログ
            // console.log(this.current.state + " -> data");
            const firstBit = this.current.mark > this.current.space ? 1 : 0;
            this.current.byte = (this.current.byte << 1) | firstBit;
            this.current.bit = 1;
            this.current.mark = 0;
            this.current.space = 0;
            this.current.total = 0;
            this.current.state = "data";
          } else {
            // console.log(this.current.state + " -> waiting");
            this.current.byte = 0;
            this.current.state = "waiting";
            this.current.total = 0;
          }
        }
      },
      data: () => {
        if (this.current.data === 1) this.current.mark++;
        if (this.current.data === -1) this.current.space++;
        if (this.unit <= this.current.total) {
          const bit = this.current.mark > this.current.space ? 1 : 0;
          this.current.mark = 0;
          this.current.space = 0;
          this.current.byte = (this.current.byte << 1) | bit;
          this.current.bit++;
          this.current.total = 0;
          if (this.current.bit >= this.byteUnit) {
            this.current.bit = 0;
            // console.log(this.current.state + " -> stop");
            this.current.state = "stop";
          }
        }
      },
      stop: () => {
        if (this.current.data === 1) this.current.mark++;
        if (this.current.data === -1) this.current.space++;
        if (this.unit * this.stopBit <= this.current.total) {
          this.port.postMessage({ type: "byte", value: this.current.byte });
          // バイト確定時のみ最小限ログ
          // console.log('[BYTE]', this.current.byte.toString(2).padStart(this.byteUnit, '0'));
          this.current.mark = 0;
          this.current.space = 0;
          this.current.byte = 0;
          this.current.state = "waiting";
          this.current.total = 0;
        }
      }
    };
    this.unit = opts.unit || 41;
    this.startBit = opts.startBit || 1;
    this.stopBit = opts.stopBit || 1.5;
    this.byteUnit = opts.byteUnit || 8;
    this.threshold = opts.threshold || 0.00001;
    this.DOWNSAMPLE_FACTOR = opts.DOWNSAMPLE_FACTOR || 8;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0][0];
    if (!input) return true;
    for (let i = 0, len = input.length; i < len; i += this.DOWNSAMPLE_FACTOR) {
      if (-this.threshold < input[i] && input[i] < this.threshold) {
        this.current.data = 0;
      } else if (input[i] < 0) {
        this.current.data = -1;
      } else if (0 < input[i]) {
        this.current.data = 1;
      }
      this.states[this.current.state]();
      this.current.total++;
    }
    return true;
  }
}

registerProcessor('decoder-processor', DecoderProcessor);
