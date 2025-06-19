FSK = function () { this.init.apply(this, arguments) };
FSK.prototype = {
	init : function (opts) {
		var self = this;
		self.markFreq  = opts.markFreq  || 1650;
		self.spaceFreq = opts.spaceFreq || 1650 + 200;
		self.baudrate  = opts.baudrate  || 300;
		self.startBit  = opts.startBit  || 1;
		self.stopBit   = opts.stopBit   || 1.5;
		self.threshold = opts.threshold || 0.00001;
		self.byteUnit  = 8;

		self.context = opts.context;
		self.DOWNSAMPLE_FACTOR = opts.DOWNSAMPLE_FACTOR || 8;
		self.audioNodes = [];

		// 追加: input/outputノードを受け取る
		self.input = opts.input || null;
		self.output = opts.output || null;
	},

	/*
	 *
	 * @return  AudioBuffer
	 */
	modulate : function (bytes, opts) {
		var self = this;
		if (!opts) opts = {};

		if (typeof bytes == 'string') {
			var b = [];
			for (var i = 0, len = bytes.length; i < len; i++) {
				b.push(bytes.charCodeAt(i) & 0xff);
			}
			bytes = b;
		}
		console.log(bytes.length, bytes);

		var unit      = self.context.sampleRate / self.baudrate;
		var wait      = opts.wait || 30;
		var bitsPerByte = self.byteUnit + self.startBit + self.stopBit;

		var buffer    = self.context.createBuffer(1, bytes.length * bitsPerByte * unit + (wait * 2 * unit), self.context.sampleRate);
		var data      = buffer.getChannelData(0);
		var position  = 0;

		var phase = 0;
		var markToneDelta = 2 * Math.PI * self.markFreq / self.context.sampleRate;  
		var spaceToneDelta = 2 * Math.PI * self.spaceFreq / self.context.sampleRate;  

		var sent = [];
		function sendBit (bit, length) {
			sent.push(bit);
			var tone = bit ? markToneDelta : spaceToneDelta;
			var len = length * unit;
			for (var i = 0; i < len; i++) {
				phase += tone;
				data[position++] = Math.sin(phase);
			}
		}

		function sendByte (byte) {
			sendBit(0, self.startBit);
			var bits = [];
			for (var b = self.byteUnit - 1; b >= 0; b--) {
				var bit = (byte & (1<<b)) ? 1 : 0;
				bits.push(bit);
				sendBit(bit, 1);
			}
			sendBit(1, self.stopBit);
			console.log('[SEND][FSK] sendByte', byte.toString(2).padStart(self.byteUnit, '0'), 'bits:', bits.join(''));
		}

		sendBit(1, wait);
		for (var i = 0, len = bytes.length; i < len; i++) {
			sendByte(bytes[i]);
		}
		sendBit(1, wait);
		var source = self.context.createBufferSource();
		source.buffer = buffer;
		// 追加: 出力ノードに接続
		source.connect(self.output);
		source.start(0);
		console.log('FSK modulated', sent.length, 'bits:', sent, bytes.map(function (b) {
			return b.toString(2).padStart(self.byteUnit, '0');
		}));
		return source;
	},

	/*
	 *
	 */
	demodulate : async function (source, callback) {
		var self = this;
		source = self.input; // force
		var detection = await self._detectCoherent(source);
		var unit  = Math.round(self.context.sampleRate / self.DOWNSAMPLE_FACTOR / self.baudrate);
		await self.context.audioWorklet.addModule('./decoder-processor.js');
		var decoder = self.retainAudioNode(new AudioWorkletNode(self.context, 'decoder-processor', {
			processorOptions: {
				unit: unit,
				startBit: self.startBit,
				stopBit: self.stopBit,
				byteUnit: self.byteUnit,
				threshold: self.threshold,
				DOWNSAMPLE_FACTOR: self.DOWNSAMPLE_FACTOR
			}
		}));
		decoder.port.onmessage = (event) => {
			if (event.data.type === 'bit') {
				// console.log('[RECEIVE][FSK] bit', event.data.bitIndex, event.data.value, 'byte:', event.data.byte.toString(2).padStart(self.byteUnit, '0'));
			}
			if (event.data.type === 'byte') {
				// console.log('[RECEIVE][FSK] byte', event.data.value.toString(2).padStart(self.byteUnit, '0'));
				callback(event.data.value);
			}
		};
		detection.connect(decoder);
		var outputGain = self.retainAudioNode(self.context.createGain());
		outputGain.gain.value = 0;
		decoder.connect(outputGain);
		outputGain.connect(self.context.destination);
	},

	_detectCoherent : async function (source) {
		var self = this;

		var centerFreq = Math.min(self.markFreq, self.spaceFreq) + Math.abs(self.markFreq - self.spaceFreq) / 2;
		var toneCenter =  self.context.sampleRate / (2 * Math.PI * centerFreq);

		var preFilter = self.retainAudioNode(self.context.createBiquadFilter());
		preFilter.type = 'bandpass'; // band pass
		preFilter.frequency.value = centerFreq;
		preFilter.Q.value = 1;
		// preFilterをthis.preFilterに保存
		self.preFilter = preFilter;
		source.connect(preFilter);

		// AudioWorkletNode で IQ
		await self.context.audioWorklet.addModule('./iq-processor.js');
		var iq = self.retainAudioNode(new AudioWorkletNode(self.context, 'iq-processor', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			processorOptions: {
				toneCenter: toneCenter
			}
		}));
		preFilter.connect(iq);

		var splitter = self.retainAudioNode(self.context.createChannelSplitter(2));
		iq.connect(splitter);
		var merger   = self.retainAudioNode(self.context.createChannelMerger(2));

		for (var i = 0; i < 2; i++) {
			var filter = self.retainAudioNode(self.context.createBiquadFilter());
			filter.type = 'lowpass'; // low pass
			filter.frequency.value = self.baudrate;
			filter.Q.value = 1;
			splitter.connect(filter, i, 0);
			filter.connect(merger, 0, i);
		}

		// AudioWorkletNode で detection
		await self.context.audioWorklet.addModule('./detection-processor.js');
		var detection = self.retainAudioNode(new AudioWorkletNode(self.context, 'detection-processor'));
		merger.connect(detection);

		var lpf = self.retainAudioNode(self.context.createBiquadFilter());
		lpf.type = 'lowpass'; // low pass
		lpf.frequency.value = self.baudrate;
		lpf.Q.value = 0;

		detection.connect(lpf);

		return lpf;
	},

	destroy : function () {
		var self = this;
		self.audioNodes = [];
	},

	retainAudioNode : function (node) {
		var self = this;
		self.audioNodes.push(node);
		return node;
	}
};


