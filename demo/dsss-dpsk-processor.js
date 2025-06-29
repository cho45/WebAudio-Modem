import * as modem from '../src/modems/dsss-dpsk.js';
// AudioWorkletGlobalScope
class TestProcessor extends AudioWorkletProcessor {
	constructor(opts) {
		super();
		this.params = opts.processorOptions;
		console.log('TestProcessor initialized with options:', this.params);
		this.buffer = new Int8Array(sampleRate * 1);

		this.reference = modem.generateSyncReference(this.params.sequenceLength);
		this.startSample = 0;
		console.log('Sync reference generated:', this.reference);
	}

	process(inputs, _outputs, _parameters) {
		const input = inputs[0];
		if (!input) return true;
		if (!input[0]) return true;

		const { reference } = this;
		const { samplesPerChip, carrierFreq } = this.params;

		const demodPhases = modem.demodulateCarrier(input[0], samplesPerChip, sampleRate, carrierFreq, this.startSample);
		this.startSample += input[0].length;
		const softValues = modem.dpskDemodulate(demodPhases, 1.0);

		// append input to buffer
		this.buffer.set(this.buffer.subarray(softValues.length), 0);
		this.buffer.set(softValues, this.buffer.length - softValues.length);

		const result = modem.findSyncOffset(this.buffer, reference, this.buffer.length - reference.length);
		if (result.isFound) {
			const demodBits = modem.dsssDespread(this.buffer.slice(result.bestOffset), this.params.sequenceLength);
			console.log(`Demodulated bits at(${result.bestOffset}):`, Array.from(demodBits.map(bit => bit < 0 ? 0 : 1)).join(''));
		}

		return true;
	}
}
registerProcessor('test-processor', TestProcessor);
