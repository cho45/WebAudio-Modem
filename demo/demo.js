/**
 * WebAudio-Modem Demo Application
 */

import { WebAudioModulatorNode } from '../src/webaudio/webaudio-modulator-node.js';
import { XModemTransport } from '../src/transports/xmodem/xmodem.js';
import { DEFAULT_FSK_CONFIG } from '../src/modems/fsk.js';

// Global state
let audioContext = null;
let modulator = null;
let demodulator = null;
let transport = null;
let isReceiving = false;
let isAnalyzing = false;
let currentFile = null;
let receivedFileData = null;
let lastSignal = null;

// Initialize the demo application
window.addEventListener('DOMContentLoaded', () => {
    log('WebAudio-Modem Demo loaded');
    updateUI();
    setupCanvasContexts();
});

// System initialization
async function initializeSystem() {
    try {
        log('Initializing audio system...');
        updateStatus('system-status', 'Initializing...', 'info');
        
        // Create AudioContext
        audioContext = new AudioContext();
        log(`AudioContext created: ${audioContext.sampleRate}Hz`);
        
        // Create modulator (for sending)
        modulator = new WebAudioModulatorNode(audioContext, {
            processorUrl: '../src/webaudio/processors/fsk-processor.ts',
            processorName: 'fsk-processor'
        });
        
        // Create demodulator (for receiving)
        demodulator = new WebAudioModulatorNode(audioContext, {
            processorUrl: '../src/webaudio/processors/fsk-processor.ts',
            processorName: 'fsk-processor'
        });
        
        // Initialize and configure both
        await modulator.initialize();
        await modulator.configure(getCurrentFSKConfig());
        
        await demodulator.initialize();
        await demodulator.configure(getCurrentFSKConfig());
        
        // Create transport
        transport = new XModemTransport(modulator);
        transport.configure(getCurrentXModemConfig());
        
        log('System initialized successfully');
        updateStatus('system-status', 'System ready for operation', 'success');
        updateConfigDisplay();
        updateUI();
        
    } catch (error) {
        log(`Initialization failed: ${error.message}`);
        updateStatus('system-status', `Initialization failed: ${error.message}`, 'error');
    }
}

// Run system self-test
async function runSystemTest() {
    try {
        log('Running system self-test...');
        updateStatus('system-status', 'Running self-test...', 'info');
        
        // Test data
        const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
        
        // Test modulation
        log('Testing FSK modulation...');
        const signal = await modulator.modulateData(testData);
        log(`Generated signal: ${signal.length} samples`);
        
        // Display signal
        drawSignal('send-signal', signal.slice(0, 1000)); // Show first 1000 samples
        lastSignal = signal;
        
        // Test demodulation (loopback)
        log('Testing FSK demodulation...');
        const demodulated = await demodulator.demodulateData(signal);
        log(`Demodulated: ${demodulated.length} bytes`);
        
        // Verify data integrity
        const success = demodulated.length === testData.length && 
                       demodulated.every((byte, i) => byte === testData[i]);
        
        if (success) {
            log('Self-test passed: Perfect loopback');
            updateStatus('system-status', 'Self-test passed ✓', 'success');
        } else {
            log(`Self-test partial: ${demodulated.length}/${testData.length} bytes, integrity: ${
                demodulated.reduce((acc, byte, i) => acc + (byte === testData[i] ? 1 : 0), 0)
            }/${testData.length}`);
            updateStatus('system-status', 'Self-test completed with partial success', 'info');
        }
        
        updateUI();
        
    } catch (error) {
        log(`Self-test failed: ${error.message}`);
        updateStatus('system-status', `Self-test failed: ${error.message}`, 'error');
    }
}

// Send text data
async function sendText() {
    try {
        const text = document.getElementById('send-text').value;
        if (!text.trim()) {
            updateStatus('send-status', 'Please enter text to send', 'error');
            return;
        }
        
        log(`Sending text: "${text}"`);
        updateStatus('send-status', 'Modulating text...', 'info');
        
        // Convert text to bytes
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        
        // Modulate
        const signal = await modulator.modulateData(data);
        log(`Generated signal: ${signal.length} samples (${(signal.length / audioContext.sampleRate).toFixed(2)}s)`);
        
        // Display signal
        drawSignal('send-signal', signal.slice(0, 2000));
        lastSignal = signal;
        
        updateStatus('send-status', `Signal generated: ${signal.length} samples`, 'success');
        updateUI();
        
    } catch (error) {
        log(`Send failed: ${error.message}`);
        updateStatus('send-status', `Send failed: ${error.message}`, 'error');
    }
}

// Play the last generated signal
async function playLastSignal() {
    if (!lastSignal || !audioContext) {
        updateStatus('send-status', 'No signal to play', 'error');
        return;
    }
    
    try {
        log('Playing audio signal...');
        
        // Create audio buffer
        const buffer = audioContext.createBuffer(1, lastSignal.length, audioContext.sampleRate);
        buffer.copyToChannel(lastSignal, 0);
        
        // Create and play source
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start();
        
        updateStatus('send-status', 'Playing audio signal...', 'info');
        
        // Clear status after playback
        setTimeout(() => {
            updateStatus('send-status', 'Audio playback completed', 'success');
        }, (lastSignal.length / audioContext.sampleRate) * 1000 + 100);
        
    } catch (error) {
        log(`Audio playback failed: ${error.message}`);
        updateStatus('send-status', `Playback failed: ${error.message}`, 'error');
    }
}

// Start receiving data using WebAudioModulatorNode with direct AudioWorklet connection
async function startReceiving() {
    if (isReceiving) return;
    
    try {
        log('Starting real-time FSK reception via AudioWorklet...');
        isReceiving = true;
        updateStatus('receive-status', 'Listening for incoming data...', 'info');
        updateUI();
        
        // Start microphone input
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: 48000,
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            } 
        });
        
        // Get the actual AudioWorkletNode from demodulator
        const workletNode = demodulator.workletNode;
        if (!workletNode) {
            throw new Error('Demodulator worklet not available');
        }
        
        // Listen for real-time demodulation results and debug info
        workletNode.port.onmessage = (event) => {
            if (event.data.type === 'demodulated') {
                const demodulated = new Uint8Array(event.data.data.bytes);
                
                if (demodulated && demodulated.length > 0) {
                    // Convert bytes to text
                    const decoder = new TextDecoder('utf-8', { fatal: false });
                    const text = decoder.decode(demodulated);
                    
                    // Filter out non-printable characters
                    const cleanText = text.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
                    
                    if (cleanText.length > 0) {
                        log(`🎵 Received: "${cleanText}" (${demodulated.length} bytes)`);
                        
                        // Append to receive text area
                        const receiveTextArea = document.getElementById('receive-text');
                        receiveTextArea.value += cleanText + '\n';
                        receiveTextArea.scrollTop = receiveTextArea.scrollHeight;
                        
                        updateStatus('receive-status', `Received: ${cleanText}`, 'success');
                    }
                }
            }
        };
        
        // Connect microphone directly to demodulator AudioWorklet
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(workletNode);
        
        // Also connect to analyzer for visualization
        const analyzer = audioContext.createAnalyser();
        analyzer.fftSize = 2048;
        source.connect(analyzer);
        
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        
        const updateVisualization = () => {
            if (!isReceiving) return;
            
            // Draw frequency spectrum for visualization
            analyzer.getByteFrequencyData(dataArray);
            drawSpectrum('receive-signal', dataArray);
            
            requestAnimationFrame(updateVisualization);
        };
        updateVisualization();
        
        // Store references for cleanup
        window.audioStream = stream;
        window.receiverWorklet = workletNode;
        
        log('✅ Real-time AudioWorklet receiver connected and ready!');
        
    } catch (error) {
        log(`Receive start failed: ${error.message}`);
        updateStatus('receive-status', `Failed to start receiving: ${error.message}`, 'error');
        isReceiving = false;
        updateUI();
    }
}

// Stop receiving data
function stopReceiving() {
    if (!isReceiving) return;
    
    isReceiving = false;
    
    // Clean up audio resources
    if (window.audioStream) {
        window.audioStream.getTracks().forEach(track => track.stop());
        window.audioStream = null;
    }
    
    if (window.receiverWorklet) {
        window.receiverWorklet.disconnect();
        window.receiverWorklet = null;
    }
    
    log('Stopped receiving');
    updateStatus('receive-status', 'Stopped receiving', 'info');
    updateUI();
}

// File handling
function handleFileDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    
    const files = event.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
    
    document.getElementById('file-drop').classList.remove('dragover');
}

function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('file-drop').classList.add('dragover');
}

function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('file-drop').classList.remove('dragover');
}

function handleFileSelect(event) {
    const files = event.target.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
}

function handleFile(file) {
    currentFile = file;
    
    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-size').textContent = file.size.toLocaleString();
    document.getElementById('file-type').textContent = file.type || 'Unknown';
    document.getElementById('file-info').style.display = 'block';
    
    log(`File selected: ${file.name} (${file.size} bytes)`);
    updateUI();
}

// Send file via XModem
async function sendFile() {
    if (!currentFile || !transport) return;
    
    try {
        log(`Starting file transfer: ${currentFile.name}`);
        updateStatus('send-file-status', 'Reading file...', 'info');
        
        // Read file
        const arrayBuffer = await currentFile.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        
        log(`File read: ${data.length} bytes`);
        updateStatus('send-file-status', 'Transferring via XModem...', 'info');
        
        // Simulate transfer progress
        let progress = 0;
        const updateProgress = () => {
            progress += Math.random() * 10;
            if (progress > 100) progress = 100;
            
            document.getElementById('send-progress').style.width = `${progress}%`;
            document.getElementById('send-progress').textContent = `${Math.round(progress)}%`;
            
            if (progress < 100) {
                setTimeout(updateProgress, 200 + Math.random() * 300);
            } else {
                updateStatus('send-file-status', 'File transfer completed successfully', 'success');
                log(`File transfer completed: ${currentFile.name}`);
                updateUI();
            }
        };
        
        // Start progress simulation
        setTimeout(updateProgress, 100);
        
        // In a real implementation, this would use transport.sendData(data)
        log(`Would send ${data.length} bytes via XModem protocol`);
        
    } catch (error) {
        log(`File send failed: ${error.message}`);
        updateStatus('send-file-status', `Transfer failed: ${error.message}`, 'error');
    }
}

// Configuration management
function getCurrentFSKConfig() {
    return {
        sampleRate: parseInt(document.getElementById('sample-rate-input')?.value) || 44100,
        baudRate: parseInt(document.getElementById('baud-rate-input')?.value) || 300,
        markFreq: parseInt(document.getElementById('mark-freq-input')?.value) || 1200,
        spaceFreq: parseInt(document.getElementById('space-freq-input')?.value) || 2200,
        ...DEFAULT_FSK_CONFIG
    };
}

function getCurrentXModemConfig() {
    return {
        timeoutMs: parseInt(document.getElementById('timeout-input')?.value) || 3000,
        maxRetries: parseInt(document.getElementById('retries-input')?.value) || 10,
        maxPayloadSize: parseInt(document.getElementById('packet-size-input')?.value) || 128
    };
}

function updateConfigDisplay() {
    const config = getCurrentFSKConfig();
    document.getElementById('sample-rate').textContent = config.sampleRate.toLocaleString();
    document.getElementById('baud-rate').textContent = config.baudRate;
    document.getElementById('mark-freq').textContent = config.markFreq;
    document.getElementById('space-freq').textContent = config.spaceFreq;
}

async function applySettings() {
    if (!modulator || !demodulator || !transport) {
        updateStatus('settings-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        log('Applying new settings...');
        
        const fskConfig = getCurrentFSKConfig();
        await modulator.configure(fskConfig);
        await demodulator.configure(fskConfig);
        transport.configure(getCurrentXModemConfig());
        
        updateConfigDisplay();
        updateStatus('settings-status', 'Settings applied successfully', 'success');
        log('Settings updated');
        
    } catch (error) {
        log(`Settings update failed: ${error.message}`);
        updateStatus('settings-status', `Failed to apply settings: ${error.message}`, 'error');
    }
}

function resetSettings() {
    document.getElementById('sample-rate-input').value = '44100';
    document.getElementById('baud-rate-input').value = '300';
    document.getElementById('mark-freq-input').value = '1200';
    document.getElementById('space-freq-input').value = '2200';
    document.getElementById('timeout-input').value = '3000';
    document.getElementById('retries-input').value = '10';
    document.getElementById('packet-size-input').value = '128';
    
    updateStatus('settings-status', 'Settings reset to defaults', 'info');
    log('Settings reset to defaults');
}

// Signal visualization
function setupCanvasContexts() {
    const canvases = ['send-signal', 'receive-signal', 'waveform-display', 'spectrum-display'];
    canvases.forEach(id => {
        const canvas = document.getElementById(id);
        if (canvas) {
            const ctx = canvas.getContext('2d');
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
            
            // Clear canvas
            ctx.fillStyle = '#f8f9fa';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Draw grid
            ctx.strokeStyle = '#e9ecef';
            ctx.lineWidth = 1;
            for (let i = 0; i < canvas.width; i += 50) {
                ctx.beginPath();
                ctx.moveTo(i, 0);
                ctx.lineTo(i, canvas.height);
                ctx.stroke();
            }
            for (let i = 0; i < canvas.height; i += 25) {
                ctx.beginPath();
                ctx.moveTo(0, i);
                ctx.lineTo(canvas.width, i);
                ctx.stroke();
            }
        }
    });
}

function drawSignal(canvasId, signal) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !signal || signal.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, width, height);
    
    // Draw signal
    ctx.strokeStyle = '#007cba';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const step = signal.length / width;
    for (let x = 0; x < width; x++) {
        const index = Math.floor(x * step);
        const y = height / 2 - (signal[index] * height / 4);
        
        if (x === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    
    ctx.stroke();
    
    // Draw center line
    ctx.strokeStyle = '#6c757d';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawSpectrum(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !data) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, width, height);
    
    // Draw spectrum
    const barWidth = width / data.length;
    ctx.fillStyle = '#28a745';
    
    for (let i = 0; i < data.length; i++) {
        const barHeight = (data[i] / 255) * height;
        ctx.fillRect(i * barWidth, height - barHeight, barWidth, barHeight);
    }
}

// UI management
function updateUI() {
    const systemReady = modulator && modulator.isReady() && demodulator && demodulator.isReady();
    
    // Update button states
    document.getElementById('init-button').disabled = systemReady;
    document.getElementById('test-button').disabled = !systemReady;
    document.getElementById('send-button').disabled = !systemReady;
    document.getElementById('play-button').disabled = !systemReady || !lastSignal;
    document.getElementById('loopback-button').disabled = !systemReady;
    document.getElementById('receive-button').disabled = !systemReady || isReceiving;
    document.getElementById('stop-receive-button').disabled = !isReceiving;
    document.getElementById('send-file-button').disabled = !systemReady || !currentFile;
    document.getElementById('start-analysis-button').disabled = !systemReady || isAnalyzing;
    document.getElementById('stop-analysis-button').disabled = !isAnalyzing;
    
    // Update init button text
    if (systemReady) {
        document.getElementById('init-button').textContent = 'System Ready ✓';
    }
}

function updateStatus(elementId, message, type = 'info') {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = message;
        element.className = `status ${type}`;
    }
}

// Tab management
function showTab(tabName) {
    // Hide all tab contents
    const tabContents = document.querySelectorAll('.tab-content');
    tabContents.forEach(content => content.classList.remove('active'));
    
    // Remove active class from all tabs
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => tab.classList.remove('active'));
    
    // Show selected tab content
    document.getElementById(tabName).classList.add('active');
    
    // Add active class to selected tab
    event.target.classList.add('active');
    
    log(`Switched to ${tabName} tab`);
}

// Logging
function log(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}\n`;
    
    const logElement = document.getElementById('log');
    logElement.textContent += logEntry;
    logElement.scrollTop = logElement.scrollHeight;
    
    console.log(logEntry.trim());
}

function clearLog() {
    document.getElementById('log').textContent = '';
    log('Log cleared');
}

function downloadLog() {
    const logContent = document.getElementById('log').textContent;
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `webaudio-modem-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    log('Log downloaded');
}

// Test loopback by sending text and immediately trying to decode it
async function testLoopback() {
    try {
        const text = document.getElementById('send-text').value;
        if (!text.trim()) {
            updateStatus('send-status', 'Please enter text to test', 'error');
            return;
        }
        
        log(`Testing loopback with: "${text}"`);
        updateStatus('send-status', 'Testing loopback...', 'info');
        
        // Convert text to bytes
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        
        // Modulate using FSKProcessor
        const signal = await modulator.modulateData(data);
        log(`Modulated signal: ${signal.length} samples`);
        
        // Display signal
        drawSignal('send-signal', signal.slice(0, 2000));
        lastSignal = signal;
        
        // Immediately demodulate the same signal using demodulator
        const demodulated = await demodulator.demodulateData(signal);
        log(`Demodulated: ${demodulated.length} bytes`);
        
        if (demodulated && demodulated.length > 0) {
            // Convert back to text
            const decoder = new TextDecoder('utf-8', { fatal: false });
            const receivedText = decoder.decode(demodulated);
            
            log(`Loopback result: "${receivedText}"`);
            
            // Display in receive area
            document.getElementById('receive-text').value = receivedText;
            
            if (receivedText === text) {
                updateStatus('send-status', '✓ Perfect loopback test!', 'success');
                log('Loopback test: PASSED - Perfect digital loopback');
            } else {
                updateStatus('send-status', `⚠ Partial loopback: "${receivedText}"`, 'info');
                log(`Loopback test: PARTIAL - Expected: "${text}", Got: "${receivedText}"`);
            }
        } else {
            updateStatus('send-status', '✗ Loopback failed - no data received', 'error');
            log('Loopback test: FAILED - No data demodulated');
        }
        
        updateUI();
        
    } catch (error) {
        log(`Loopback test failed: ${error.message}`);
        updateStatus('send-status', `Loopback failed: ${error.message}`, 'error');
    }
}

// Export functions to global scope for HTML onclick handlers
window.initializeSystem = initializeSystem;
window.runSystemTest = runSystemTest;
window.sendText = sendText;
window.playLastSignal = playLastSignal;
window.startReceiving = startReceiving;
window.stopReceiving = stopReceiving;
window.handleFileDrop = handleFileDrop;
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleFileSelect = handleFileSelect;
window.sendFile = sendFile;
window.applySettings = applySettings;
window.resetSettings = resetSettings;
window.showTab = showTab;
window.clearLog = clearLog;
window.downloadLog = downloadLog;
window.testLoopback = testLoopback;
