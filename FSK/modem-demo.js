navigator.getMedia = (
	navigator.getUserMedia ||
	navigator.webkitGetUserMedia ||
	navigator.mozGetUserMedia ||
	navigator.msGetUserMedia
);

window.AudioContext = (
	window.AudioContext ||
	window.webkitAudioContext ||
	window.mozAudioContext ||
	window.msAudioContext
);

var AModem = function () { this.init.apply(this, arguments) };
AModem.prototype = {
	NAK : 0x15,
	ACK : 0x06,
	EOT : 0x04,
	CAN : 0x18,
	EOF : 0x1A,
	SOH : 0x01,

	init : function () {
		var self = this;
		self.baudrate = 450;
		self.chunksize = 128;
		self.context = FSK.context;
		self.logger  = function (msg) {
			console.log(msg);
		};

		if (AModem.debug) {
			self.destination = AModem.debug;
		} else {
			self.destination = self.context.destination;
		}
	},

	initChannels : function () {
		var self = this;

		// channel for slave
		self.channel1 = new FSK({
			markFreq: 980,
			spaceFreq : 1180,
			baudrate : self.baudrate
		});
		// channel for master
		self.channel2 = new FSK({
			markFreq: 1650,
			spaceFreq : 1850,
			baudrate : self.baudrate
		});
	},

	destroyChannels : function () {
		var self = this;
		delete self.channel1;
		delete self.channel2;
	},

	receive : function (callback) {
		var self = this;
		self.mic(function (source) {
			self.initChannels();

			var state  = 'data';
			var buffer = [];
			var chunk  = 0;
			var result = [];
			var timeout;

			var waitResponse = function (ack) {
				timeout = setTimeout(function () {
					buffer = [];
					self.logger('Timeout; resend previous ACK/NAK');
					self.channel1.modulate([ ack ], { play : self.destination });
					waitResponse(ack);
				}, 5000);
			};
			
			var returnACK = function (ack) {
				self.channel1.modulate([ ack ], { play : self.destination });
				waitResponse(ack);
			};

			var states = {
				'data' : function (byte) {
					if (!buffer.length && byte == self.EOT) {
						self.logger('Slave received EOT');
						self.channel1.modulate([ self.ACK ], { play : self.destination });
						self.destroyChannels();
						callback(result, 1);
						state = 'eot';
					} else
					if (!buffer.length && byte == self.CAN) {
						self.logger('Slave received CAN');
						self.destroyChannels();
						callback(null, 1);
						state = 'eot';
					} else {
						buffer.push(byte);
						if (buffer.length == self.chunksize + 4) {
							var soh = buffer.shift();
							if (self.SOH != soh) {
								buffer = [];
								returnACK(self.NAK);
								self.logger('Framing error expected SOH but ', soh ,'; return NAK');
								return;
							}

							if (chunk != (buffer.shift() & 0xff)) {
								buffer = [];
								returnACK(self.NAK);
								self.logger('Missmatch chunk number; return NAK');
								return;
							}
							if (chunk != (~buffer.shift() & 0xff)) {
								buffer = [];
								returnACK(self.NAK);
								self.logger('Missmatch chunk number (~); return NAK');
								return;
							}
							var crc = buffer.pop();
							if (crc != self.crc8(buffer)) {
								buffer = [];
								returnACK(self.NAK);
								self.logger('Missmatch CRC', crc, self.crc8(buffer), "; return NAK");
								return;
							}
							result = result.concat(buffer);
							callback(result, 0);
							buffer = [];
							self.logger('Slave received ', chunk, ' chunk ', result.length, ' bytes', '; return ACK');
							chunk++;
							returnACK(self.ACK);
						} else {
							var wait = (self.chunksize + 4 - buffer.length + 10) * (self.channel2.startBit + self.channel2.stopBit + self.channel2.byteUnit) * (1/self.channel2.baudrate) * 1000;
							timeout = setTimeout(function () {
								buffer = [];
								self.logger('Timeout; return NAK');
								returnACK(self.NAK);
							}, wait);
						}
					}
				},
				'eot' : function () {
					self.channel1.modulate([ self.ACK ], { play : self.destination });
				}
			};

			self.channel2.demodulate(source, function (byte) {
				// self.logger('receive (slave)', byte);
				clearTimeout(timeout);
				states[state](byte);
			});
			self.logger('Send initial NAK');
			returnACK(self.NAK);

//			var trigger = false;
//			self.channel2.rawBitCallback = function (current, mark, space) {
//				if (!trigger) {
////					if (current.state == 'start') {
////						setTimeout(function () {
////							trigger = true;
////							setTimeout(function () {
////								trigger = false;
////							}, 30 * 1000);
////						}, 800);
////					}
//					drawBuffers.bits.put(current.data);
//					drawBuffers.mark.put(mark);
//					// drawBuffers.space.put(space);
//				}
//			};
		});
	},

	send : function (data, done) {
		var self = this;

		if (typeof data == 'string') {
			var d = [];
			for (var i = 0, len = data.length; i < len; i++) {
				d.push(data.charCodeAt(i));
			}
			data = d;
		}
		self.logger(['Sending', data.length, 'bytes']);

		self.mic(function (source) {
			self.initChannels();
			var state  = 'data';
			var chunk  = 0;

			var states = {
				'data' : function (byte) {
					if (byte == self.NAK || byte == self.ACK) {
						if (byte == self.ACK) {
							self.logger('Master received ACK');
							chunk++;
						} else {
							self.logger('Master received NAK');
						}
						var d = data.slice(chunk * self.chunksize, (chunk + 1) * self.chunksize);
						if (d.length) {
							while (d.length < self.chunksize) {
								d.push(self.EOF);
							}

							self.logger('Sending chunk: ', chunk, d.length, chunk * self.chunksize, data.length, ( (chunk + 1) * self.chunksize / data.length * 100).toFixed(2), '%');
							d.push(self.crc8(d));
							self.channel2.modulate([ self.SOH, chunk & 0xff, ~chunk & 0xff ].concat(d), { play : self.destination });
							state = 'data';
						} else {
							self.logger('End of data. Send EOT');
							self.channel2.modulate([ self.EOT ], { play : self.destination });
							state = 'eot';
						}
					} else
					if (byte == self.CAN) {
						self.logger('Master received CAN');
						state = 'eot';
						self.destroyChannels();
						done();
					}
				},
				'eot' : function (byte) {
					if (byte == self.ACK) {
						self.destroyChannels();
						done();
					} else
					if (byte == self.NAK) {
						self.channel2.modulate([ self.EOT ], { play : self.destination });
					}
				}
			};

			self.channel1.demodulate(source, function (byte) {
				// self.logger('receive (master)', byte);
				states[state](byte);
			});
			self.logger('Ready. Waiting for NAK');

//			var trigger = false;
//			self.channel1.rawBitCallback = function (current, mark, space) {
//				if (!trigger) {
////					if (current.state == 'start') {
////						setTimeout(function () {
////							trigger = true;
////							setTimeout(function () {
////								trigger = false;
////							}, 30 * 1000);
////						}, 800);
////					}
//					drawBuffers.bits.put(current.data);
//					drawBuffers.mark.put(mark);
//					// drawBuffers.space.put(space);
//				}
//			};
//
		});
	},

	mic : function (callback) {
		var self = this;
		if (AModem.debug) {
			setTimeout(function () {
				callback(self.destination);
			}, 500);
		} else {
			navigator.getMedia({ video: false, audio: true }, function (stream) {
				callback(self.context.createMediaStreamSource(stream));
			}, function (e) {
				alert(e);
			});
		}
	},

	crc8 : function (bytes) {
		var crc = 0;
		for (var i = 0, len = bytes.length; i < len; i++) {
			crc = crc ^ ((bytes[i] & 0xff) << 8);
			for (var j = 8; j > 0; j--) {
				if (crc & 0x8000) crc = crc ^ (0x1070 << 3);
				crc = crc << 1;
			}
		}
		return (crc >> 8) & 0xFF;
	}

};

//var drawBuffers = {
//	bits : new RingBuffer(new Int8Array(Math.pow(2, 11))),
//	mark : new RingBuffer(new Float32Array(Math.pow(2, 11))),
//	space : new RingBuffer(new Float32Array(Math.pow(2, 11)))
//};
//function drawWaveForm () {
//	var canvas = document.getElementById('canvas');
//	var ctx = canvas.getContext('2d');
//
//	var buffer, n;
//	var max = Math.max(
//		Math.max.apply(Math, drawBuffers.mark.buffer),
//		Math.max.apply(Math, drawBuffers.space.buffer),
//		-Math.min.apply(Math, drawBuffers.mark.buffer),
//		-Math.min.apply(Math, drawBuffers.space.buffer),
//		0.001
//	);
//
//	ctx.clearRect(0, 0, canvas.width, canvas.height);
//
//	ctx.beginPath();
//	ctx.moveTo(0, canvas.height/2);
//	ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
//	buffer = drawBuffers.bits;
//	for (var i = 0, len = buffer.length; i < len; i++) {
//		n = buffer.get(i);
//		ctx.lineTo(
//			canvas.width * (i / len),
//			canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
//		);
//	}
//	ctx.stroke();
//
//	ctx.beginPath();
//	ctx.moveTo(0, canvas.height/2);
//	ctx.strokeStyle = "#3276b1";
//	buffer = drawBuffers.mark;
//	for (var i = 0, len = buffer.length; i < len; i++) {
//		n = buffer.get(i) / max;
//		ctx.lineTo(
//			canvas.width * (i / len),
//			canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
//		);
//	}
//	ctx.stroke();
//
//	ctx.beginPath();
//	ctx.moveTo(0, canvas.height/2);
//	ctx.strokeStyle = "#47a447";
//	buffer = drawBuffers.space;
//	for (var i = 0, len = buffer.length; i < len; i++) {
//		n = buffer.get(i) / max;
//		ctx.lineTo(
//			canvas.width * (i / len),
//			canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
//		);
//	}
//	ctx.stroke();
//}
//
//setInterval(function () {
//	drawWaveForm();
//}, 10);

var DEMO = {
	init : function () {
		new FSK({});
		if (location.hash != '#mic') {
			AModem.debug = FSK.context.createGain();
			AModem.debug.connect(FSK.context.destination);
		}
		DEMO.setImage('jpeg_1500b');
	},

	setImage : function (id) {
		var data = document.getElementById(id).innerText.replace(/\s/g, '');
		var img  = document.getElementById('sending');
		img.src = 'data:image/jpg;base64,' + data;
	},

	startMaster : function () {
		DEMO.master = new AModem();
		(function () {
			var e = document.getElementById('master');
			DEMO.master.logger = function (msg) {
				e.value += Array.prototype.slice.call(arguments, 0).join(' ') + "\n";
				e.scrollTop = e.scrollHeight;
			};
		})();

		document.getElementById('transmit-btn').disabled = true;
		var img  = document.getElementById('sending');
		var base64 = img.src.split(',')[1];

		DEMO.master.send(atob(base64), function () {
			document.getElementById('transmit-btn').disabled = false;
			console.log('done');
		});
	},

	startSlave : function () {
		DEMO.slave = new AModem();
		(function () {
			var e = document.getElementById('slave');
			DEMO.slave.logger = function (msg) {
				e.value += Array.prototype.slice.call(arguments, 0).join(' ') + "\n";
				e.scrollTop = e.scrollHeight;
			};
		})();

		var img  = document.getElementById('received');

		document.getElementById('receive-btn').disabled = true;
		DEMO.slave.receive(function (data, done) {
			var d = '';
			for (var i = 0, len = data.length; i < len; i++) {
				d += String.fromCharCode(data[i]);
			}

			img.src = 'data:image/jpg,' + escape(d);
			if (done) {
				document.getElementById('receive-btn').disabled = false;
			}
		});
	}
};

DEMO.init();

