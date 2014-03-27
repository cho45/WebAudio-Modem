var RingBuffer = function () { this.init.apply(this, arguments) };
RingBuffer.prototype = {
	init : function (buffer) {
		this.buffer = buffer;
		this.readIndex = 0;
		this.writeIndex = 0;
		this.length = 0;
		this.maxLength = buffer.length;
	},

	get : function (i) {
		if (i < 0) i += this.length;
		return this.buffer[(this.readIndex + i) % this.maxLength];
	},

	remove : function () {
		var ret = this.buffer[this.readIndex];
		this.readIndex = (this.readIndex + 1) % this.maxLength;
		if (this.length > 0) this.length--;
		return ret;
	},

	put : function (v) {
		var buffer = this.buffer;
		var maxLength = this.maxLength;
		var writeIndex = this.writeIndex;

		for (var i = 0, len = arguments.length; i < len; i++) {
			buffer[writeIndex] = arguments[i];
			writeIndex = (writeIndex + 1) % maxLength;
		}

		this.writeIndex = writeIndex;

		this.length += len;
		var over = this.length - maxLength;
		if (over > 0) {
			this.length = maxLength;
			this.readIndex = (this.readIndex + over) % maxLength;
		}
	}
};

RingBuffer.Fast = function () { this.init.apply(this, arguments) };
RingBuffer.Fast.prototype = {
	init : function (buffer) {
		if (buffer.length & (buffer.length-1)) {
			throw "buffer size must be power of 2";
		}
		this.buffer = buffer;
		this.readIndex = 0;
		this.writeIndex = 0;
		this.length = 0;
		this.maxLength = buffer.length;
		this.mask = this.maxLength - 1;
	},

	get : function (i) {
		if (i < 0) i += this.length;
		return this.buffer[(this.readIndex + i) & this.mask];
	},

	remove : function () {
		var ret = this.buffer[this.readIndex];
		this.readIndex = (this.readIndex + 1) & this.mask;
		if (this.length > 0) this.length--;
		return ret;
	},

	put : function (v) {
		var buffer = this.buffer;
		var mask = this.mask;
		var maxLength = this.maxLength;
		var writeIndex = this.writeIndex;

		for (var i = 0, len = arguments.length; i < len; i++) {
			buffer[writeIndex] = arguments[i];
			writeIndex = (writeIndex + 1) & mask;
		}

		this.writeIndex = writeIndex;

		this.length += len;
		var over = this.length - maxLength;
		if (over > 0) {
			this.length = maxLength;
			this.readIndex = (this.readIndex + over) & mask;
		}
	}
};

RingBuffer.Typed2D = function () { this.init.apply(this, arguments) };
RingBuffer.Typed2D.prototype = {
	init : function (type, unit, length) {
		this.buffer = new RingBuffer(new Array(length));
		for (var i = 0; i < length; i++) {
			this.buffer.put(new Uint8Array(unit));
		}
		this.length = 0;
		this.maxLength = length;
	},

	get : function (i) {
		return this.buffer.get(this.length + i);
	},

	put : function (v) {
		if (this.length < this.maxLength) this.length++;
		for (var i = 0, len = arguments.length; i < len; i++) {
			this.nextSubarray().set(arguments[i]);
		}
	},

	/**
	 * returns subarray of buffer for writing
	 */
	nextSubarray : function () {
		if (this.length < this.maxLength) this.length++;
		var ret = this.buffer.remove();
		this.buffer.put(ret);
		return ret;
	}
};

this.RingBuffer = RingBuffer;
