const { FSKCore } = require('./src/modems/fsk.ts');

async function debugFSK() {
  const fsk = new FSKCore();
  
  fsk.configure({
    sampleRate: 48000,
    baudRate: 300,
    markFrequency: 1650,
    spaceFrequency: 1850,
    preamblePattern: [0xAA, 0xAA, 0xAA, 0xAA],
    sfdPattern: [0x55],
    startBits: 1,
    stopBits: 1,
    parity: 'none',
    syncThreshold: 0.85,
    agcEnabled: true,
    preFilterBandwidth: 800,
    adaptiveThreshold: false
  });

  console.log('FSK configured');
  
  // Test simple single byte
  const testData = new Uint8Array([0x48]); // 'H'
  console.log('Original data:', Array.from(testData));
  
  // Modulate
  const signal = await fsk.modulateData(testData);
  console.log('Signal length:', signal.length);
  console.log('Signal first 10 samples:', Array.from(signal.slice(0, 10)));
  
  // Demodulate
  const result = await fsk.demodulateData(signal);
  console.log('Result length:', result.length);
  console.log('Result data:', Array.from(result));
}

debugFSK().catch(console.error);